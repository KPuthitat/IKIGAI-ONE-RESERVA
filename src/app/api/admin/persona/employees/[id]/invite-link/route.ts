import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction, type Invite, type InviteKind } from "@/lib/db";
import { createInvite, revokeOpenInvites } from "@/lib/invites";

// GET  /api/admin/persona/employees/[id]/invite-link
// POST /api/admin/persona/employees/[id]/invite-link?kind=reset|rebind_line
//
// GET — admin wants to see the invite URL again (closed the original
// modal, lost the link, etc.). Returns:
//   • the existing valid open invite if there is one, OR
//   • a freshly-issued invite — `kind=onboard` for pending_invite
//     users, `kind=reset` for active users (revokes any prior open
//     invites in either case).
//
// POST — admin explicitly wants to issue a NEW invite of a specific
// kind. Used for "ออกลิงก์เชื่อมต่อ LINE ใหม่" (rebind_line) and "ออกลิงก์
// รีเซ็ตรหัสผ่าน" (reset). Always revokes prior open invites and
// creates a fresh one — even if a valid one already exists.

function buildUrls(token: string, expiresAt: string) {
  const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const directUrl = `${base}/persona/invite/${token}`;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID_INVITE;
  const liffUrl = liffId
    ? `https://liff.line.me/${liffId}?token=${token}`
    : null;
  return {
    token,
    expires_at: expiresAt,
    url: liffUrl ?? directUrl,
    liff_url: liffUrl,
    direct_url: directUrl
  };
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
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
  const target = db.prepare(
    "SELECT id, status FROM users WHERE id = ?"
  ).get(id) as { id: number; status: string } | undefined;
  if (!target) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  if (target.status === "disabled") {
    return NextResponse.json({ error: "user_disabled" }, { status: 409 });
  }

  // Look for a still-valid invite. If found, return its URLs unchanged
  // so admin can hand the staff the SAME link they got originally —
  // avoids invalidating a link that might already be in transit via
  // LINE chat history.
  const now = new Date().toISOString();
  const existing = db.prepare(`
    SELECT id, user_id, token, expires_at, used_at, created_by,
           created_at, kind
    FROM invites
    WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(id, now) as Invite | undefined;

  if (existing) {
    return NextResponse.json({
      ok: true,
      reused: true,
      invite_id: existing.id,
      kind: existing.kind,
      ...buildUrls(existing.token, existing.expires_at)
    });
  }

  // No valid invite — issue a fresh one. Pick the kind that matches
  // where the user is in the onboarding lifecycle.
  const kind: InviteKind = target.status === "pending_invite" ? "onboard" : "reset";
  revokeOpenInvites(id, "regenerated_by_admin");
  const fresh = createInvite({ userId: id, kind, createdBy: user.id });
  logPersonaAction(user.id, `invite.${kind}`, fresh.id);

  return NextResponse.json({
    ok: true,
    reused: false,
    invite_id: fresh.id,
    kind,
    ...buildUrls(fresh.token, fresh.expires_at)
  });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  if (kindParam !== "reset" && kindParam !== "rebind_line") {
    return NextResponse.json(
      { error: "invalid_kind", hint: "kind must be 'reset' or 'rebind_line'" },
      { status: 400 }
    );
  }
  const kind: InviteKind = kindParam;

  const db = getDb();
  const target = db.prepare(
    "SELECT id, status FROM users WHERE id = ?"
  ).get(id) as { id: number; status: string } | undefined;
  if (!target) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  if (target.status === "disabled") {
    return NextResponse.json({ error: "user_disabled" }, { status: 409 });
  }

  revokeOpenInvites(id, "regenerated_by_admin");
  const fresh = createInvite({ userId: id, kind, createdBy: user.id });
  logPersonaAction(user.id, `invite.${kind}`, fresh.id);

  return NextResponse.json({
    ok: true,
    reused: false,
    invite_id: fresh.id,
    kind,
    ...buildUrls(fresh.token, fresh.expires_at)
  });
}
