import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { pushClockInCard } from "@/lib/line";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";

// POST /api/admin/persona/timesheets/[id]/resend-notification
//
// Manually re-push the personal LINE clock-in card for a time_entries
// row. Admin-only — useful when the auto-push at clock-in time was
// skipped (no LINE userId bound at the time, platform OA misconfigured,
// transient LINE outage, etc.) and the staff member never got their
// confirmation card.
//
// We DON'T touch the time_entries row — re-sending a notification
// doesn't constitute a "revision" of the clock event. Each call is a
// fresh push.
//
// Branch guard mirrors the DELETE route in the parent folder: admin
// must be assigned to the branch the entry belongs to. Legacy rows
// with NULL branch_id are still reachable so admin can cover them.
//
// Only 'in' entries have a notification — 'out' clock-outs don't
// produce a LINE card in the current flow, so a resend would have
// nothing to send. The endpoint returns 400 for out rows so the UI
// can hide the button rather than failing mysteriously.

export async function POST(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const entry = db.prepare(`
    SELECT te.id, te.user_id, te.type, te.ts, te.branch_id,
           u.display_name, u.line_user_id
    FROM time_entries te
    JOIN users u ON te.user_id = u.id
    WHERE te.id = ?
  `).get(id) as
    | {
        id: number;
        user_id: number;
        type: "in" | "out";
        ts: string;
        branch_id: number | null;
        display_name: string;
        line_user_id: string | null;
      }
    | undefined;

  if (!entry) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (entry.branch_id != null && !userHasBranch(user, entry.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  if (entry.type !== "in") {
    // Clock-out rows don't have a Flex card to re-push. UI should
    // gate the button to 'in' entries only — this is defence in
    // depth.
    return NextResponse.json({ error: "not_resendable" }, { status: 400 });
  }

  if (!entry.line_user_id) {
    // The staff hasn't bound their LINE userId at all. Re-sending
    // wouldn't help — no destination to push to. Surface this so
    // the UI can show a helpful message instead of a generic fail.
    return NextResponse.json({ error: "no_line_user_id" }, { status: 422 });
  }

  // Branch context — needed for the Flex card body (lunch window +
  // branch name). Fall back to admin's active branch if the entry
  // pre-dates the branch_id column (NULL legacy rows).
  const branchId = entry.branch_id ?? user.activeBranchId;
  if (!branchId) {
    return NextResponse.json({ error: "no_branch" }, { status: 400 });
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(branchId) as Branch | undefined;
  if (!branch) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  // Platform OA — same channel the auto-push uses. If unconfigured,
  // resend can't succeed; tell the caller so they fix it instead of
  // retrying blindly.
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) {
    return NextResponse.json(
      { error: "platform_not_configured" },
      { status: 503 }
    );
  }

  // Build the same deep link the auto-push uses. We're already in
  // an API request so we have the request headers; mirror the same
  // proto/host fallback the original code uses.
  const proto = _req.headers.get("x-forwarded-proto") ?? "https";
  const host = _req.headers.get("host") ?? "ikigaimedihealth.com";
  const personaUrl = `${proto}://${host}/staff/persona`;

  try {
    const result = await pushClockInCard({
      userId: entry.user_id,
      displayName: entry.display_name,
      branch,
      platformChannelToken: platform.channel_token,
      personaUrl,
      clockInIsoTs: entry.ts
    });
    if (result.ok) {
      return NextResponse.json({ ok: true });
    }
    // Skipped because the user lost their line_user_id between
    // the early check above and the actual push (race condition,
    // admin un-bound them in another tab, etc.). Surface the
    // same code so the UI can show "no LINE bound" guidance.
    if (result.skipped === "no_line_user_id") {
      return NextResponse.json({ error: "no_line_user_id" }, { status: 422 });
    }
    // Hard LINE-side failure (token rejected, user blocked the bot,
    // payload invalid, etc.). Pass the underlying message through so
    // admin can act on it without digging into pm2 logs.
    return NextResponse.json(
      { error: "push_failed", status: result.status, message: result.error },
      { status: 502 }
    );
  } catch (e) {
    console.error("timesheets resend-notification failed", e);
    return NextResponse.json(
      {
        error: "push_failed",
        message: e instanceof Error ? e.message : "unknown"
      },
      { status: 500 }
    );
  }
}
