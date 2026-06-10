import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { recomputeLine } from "@/lib/payroll-compute";

// POST /api/admin/persona/timesheets
//   Body: { user_id, type: 'in'|'out', ts (ISO instant) }
//
// Admin directly adds a missing clock punch from the timesheet — the
// reliable counterpart to the staff self-service certification. Creates
// the time_entries row on the admin's ACTIVE branch, audits it, and
// recomputes any DRAFT payroll period covering that date so the new
// punch reaches payroll immediately (the certification engine is proven
// to pair it — owner 2026-06-10: "รับรองเวลาแล้วไม่ขึ้นที่ไหนเลย").

const Body = z.object({
  user_id: z.number().int().positive(),
  type: z.enum(["in", "out"]),
  ts: z.string().datetime()
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
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { user_id, type, ts } = parsed.data;
  const branchId = user.activeBranchId;
  if (!userHasBranch(user, branchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(user_id) as { id: number } | undefined;
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // Guard against an obvious duplicate (same user/type within the same
  // Bangkok day) so a double-tap doesn't create two punches.
  const dayStart = new Date(new Date(new Date(ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10) + "T00:00:00+07:00").toISOString();
  const dayEnd = new Date(new Date(dayStart).getTime() + 86_400_000 - 1000).toISOString();
  const dup = db.prepare(
    "SELECT id FROM time_entries WHERE user_id = ? AND type = ? AND ts >= ? AND ts <= ?"
  ).get(user_id, type, dayStart, dayEnd) as { id: number } | undefined;
  if (dup) {
    return NextResponse.json(
      { error: "punch_exists", message: "วันนั้นมีการลงเวลาประเภทนี้อยู่แล้ว — ใช้แก้ไข/รับรองเวลาแทน" },
      { status: 409 }
    );
  }

  const nowIso = new Date().toISOString();
  const newId = db.transaction(() => {
    const res = db.prepare(
      "INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?, ?, ?, ?)"
    ).run(user_id, type, ts, branchId);
    const eid = Number(res.lastInsertRowid);
    db.prepare(`
      INSERT INTO time_entries_audit
        (entry_id, entry_user_id, entry_type, entry_ts, action, admin_id, reason, created_at)
      VALUES (?, ?, ?, ?, 'create', ?, ?, ?)
    `).run(eid, user_id, type, ts, user.id, "แอดมินเพิ่มเวลาที่ขาดจากหน้าบันทึกเวลา", nowIso);
    return eid;
  })();

  // Refresh any DRAFT payroll period covering that date for this user so
  // the punch reaches payroll right away. recomputeLine opens its own
  // transaction; finalized periods / missing lines are safely skipped.
  try {
    const dateBkk = new Date(new Date(ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
    const periods = db.prepare(`
      SELECT id FROM payroll_periods
      WHERE status = 'draft' AND period_start <= ? AND period_end >= ?
    `).all(dateBkk, dateBkk) as Array<{ id: number }>;
    for (const p of periods) {
      try { recomputeLine(db, p.id, user_id); }
      catch { /* line_not_found / period_not_draft — skip */ }
    }
  } catch (e) {
    console.warn("[timesheets] payroll recompute after add-punch failed:", e);
  }

  logPersonaAction(user.id, "timesheet.add_punch", newId);
  return NextResponse.json({ ok: true, id: newId });
}
