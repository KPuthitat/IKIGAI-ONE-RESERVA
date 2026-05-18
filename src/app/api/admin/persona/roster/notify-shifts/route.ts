import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction, type Branch } from "@/lib/db";
import { sendShiftNotifications, markShiftNotifySent } from "@/lib/shift-notify";

// POST /api/admin/persona/roster/notify-shifts
//
// Manual "send shift reminders now" for the admin's active branch.
// DMs every staff rostered on `date` (default = today Bangkok) to
// their personal LINE. Stamps the same-day dedupe column when the
// date is today so the automatic morning cron won't double-send.

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const date = parsed.data.date ?? todayBkk;

  const result = await sendShiftNotifications(branch, date);

  // Sending "today" manually also satisfies the auto cron — stamp the
  // dedupe column so it doesn't fire a duplicate batch later today.
  if (date === todayBkk) markShiftNotifySent(branch.id, todayBkk);

  logPersonaAction(user.id, "roster.notify_shifts", branch.id);
  return NextResponse.json({ ok: true, date, ...result });
}
