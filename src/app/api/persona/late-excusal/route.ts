import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { createExcusal } from "@/lib/late-excusals";

// POST /api/persona/late-excusal — a staffer files a late-arrival excusal for a
// day (owner 2026-09-05). One per (user, work_date); a pending/rejected day can
// be re-filed, an approved one is locked. Only for one's OWN record.

const HDATE = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  work_date: z.string().regex(HDATE),
  reason: z.string().min(3).max(500)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { work_date, reason } = parsed.data;

  // Only allow filing for the last ~45 days (older = pay period likely closed).
  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() + 7 * 3600_000 - 45 * 86400_000).toISOString().slice(0, 10);
  if (work_date > todayBkk || work_date < cutoff) {
    return NextResponse.json({ error: "date_out_of_range" }, { status: 400 });
  }

  const db = getDb();
  // Branch = where the staffer clocked in that day (for reviewer scoping),
  // falling back to their active branch.
  const firstIn = db.prepare(
    "SELECT branch_id FROM time_entries WHERE user_id = ? AND type = 'in' AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1"
  ).get(user.id, `${work_date}T00:00:00`, `${work_date}T23:59:59`) as { branch_id: number | null } | undefined;
  const branchId = firstIn?.branch_id ?? user.activeBranchId ?? null;

  const res = createExcusal(db, { userId: user.id, workDate: work_date, branchId, reason });
  if ("error" in res) {
    return NextResponse.json({ error: res.error }, { status: 409 });
  }
  logPersonaAction(user.id, "late_excusal.submit", res.id);
  return NextResponse.json({ ok: true, id: res.id });
}
