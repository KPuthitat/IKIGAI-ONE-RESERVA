import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { recomputeLine } from "@/lib/payroll-compute";

// PATCH /api/admin/persona/payroll/periods/[id]/lines/[userId]/day
//
// Edit ONE day's recorded clock-in / clock-out for an employee in a
// draft period. The edit is stored as a payroll-scoped override
// (payroll_line_days) — the staff's real time-clock log is never
// touched (owner 2026-06-03). After upsert the whole line is recomputed
// from the merged sources so break / hours / OT / pay refresh.
//
// PIN-gated (editing recorded staff time) + audited. Draft only.
//
//   clock_in/clock_out:
//     • both 'HH:MM'  → that day's worked window (equal = absent, 0 pay)
//     • both null/""  → remove the override (revert to the time-clock)

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clock_in: z.string().regex(HHMM).nullable().optional(),
  clock_out: z.string().regex(HHMM).nullable().optional(),
  // Per-day FIELD overrides (admin typed a corrected value). null = clear.
  sched_in: z.string().regex(HHMM).nullable().optional(),
  sched_out: z.string().regex(HHMM).nullable().optional(),
  break_min: z.number().int().min(0).max(1440).nullable().optional(),
  worked_min: z.number().int().min(0).max(1440).nullable().optional(),
  ot_min: z.number().int().min(0).max(1440).nullable().optional(),
  ot_pay: z.number().min(0).max(1_000_000).nullable().optional(),
  admin_pin: z.string().optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const clockIn = d.clock_in || null;
  const clockOut = d.clock_out || null;
  const schedIn = d.sched_in || null;
  const schedOut = d.sched_out || null;
  const breakMin = d.break_min ?? null;
  const workedMin = d.worked_min ?? null;
  const otMin = d.ot_min ?? null;
  const otPay = d.ot_pay ?? null;
  // Both-or-neither: a half-filled pair is ambiguous.
  if ((clockIn === null) !== (clockOut === null)) {
    return NextResponse.json({ error: "need_both_times" }, { status: 400 });
  }
  if ((schedIn === null) !== (schedOut === null)) {
    return NextResponse.json({ error: "need_both_sched" }, { status: 400 });
  }

  // PIN gate — touches recorded staff time → re-prove presence.
  if (!d.admin_pin) {
    return NextResponse.json({ error: "pin_required" }, { status: 400 });
  }
  const pinStatus = verifyAdminPin(user.id, d.admin_pin);
  if (!pinStatus.ok) {
    const code = pinStatus.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: pinStatus.reason }, { status: code });
  }

  const db = getDb();
  const period = db.prepare(`
    SELECT status, period_start, period_end FROM payroll_periods WHERE id = ?
  `).get(periodId) as { status: string; period_start: string; period_end: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  }
  if (d.work_date < period.period_start || d.work_date > period.period_end) {
    return NextResponse.json({ error: "date_out_of_range" }, { status: 400 });
  }

  const line = db.prepare(`
    SELECT regular_minutes, ot_minutes, holiday_minutes, days_worked,
           base_pay, ot_pay, gross_pay, net_pay
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId);
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });
  const beforeSnapshot = { work_date: d.work_date, line };

  const allNull = !clockIn && !clockOut && !schedIn && !schedOut
    && breakMin === null && workedMin === null && otMin === null && otPay === null;

  try {
    db.transaction(() => {
      if (allNull) {
        // Everything cleared → drop the override, revert to time-clock.
        db.prepare(`
          DELETE FROM payroll_line_days
          WHERE period_id = ? AND user_id = ? AND work_date = ?
        `).run(periodId, userId, d.work_date);
      } else {
        db.prepare(`
          INSERT INTO payroll_line_days
            (period_id, user_id, work_date, clock_in, clock_out,
             sched_in, sched_out, break_min, worked_min, ot_min, ot_pay,
             edited_by, edited_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (period_id, user_id, work_date) DO UPDATE SET
            clock_in = excluded.clock_in,
            clock_out = excluded.clock_out,
            sched_in = excluded.sched_in,
            sched_out = excluded.sched_out,
            break_min = excluded.break_min,
            worked_min = excluded.worked_min,
            ot_min = excluded.ot_min,
            ot_pay = excluded.ot_pay,
            edited_by = excluded.edited_by,
            edited_at = excluded.edited_at
        `).run(
          periodId, userId, d.work_date, clockIn, clockOut,
          schedIn, schedOut, breakMin, workedMin, otMin, otPay,
          user.id, new Date().toISOString()
        );
      }
      recomputeLine(db, periodId, userId);
    })();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "recompute_failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Audit trail — read the stored line back as the "after" snapshot.
  const after = db.prepare(`
    SELECT regular_minutes, ot_minutes, holiday_minutes, days_worked,
           base_pay, ot_pay, gross_pay, net_pay
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId);
  db.prepare(`
    INSERT INTO payroll_line_audit
      (period_id, target_user_id, admin_id, mode, before_json, after_json, note, created_at)
    VALUES (?, ?, ?, 'day', ?, ?, ?, ?)
  `).run(
    periodId, userId, user.id,
    JSON.stringify(beforeSnapshot),
    JSON.stringify({
      work_date: d.work_date, clock_in: clockIn, clock_out: clockOut,
      sched_in: schedIn, sched_out: schedOut, break_min: breakMin,
      worked_min: workedMin, ot_min: otMin, ot_pay: otPay, line: after ?? {}
    }),
    `แก้ไขรายวัน ${d.work_date}`,
    new Date().toISOString()
  );
  logPersonaAction(user.id, "payroll.line.day_edit", periodId);

  return NextResponse.json({ ok: true });
}
