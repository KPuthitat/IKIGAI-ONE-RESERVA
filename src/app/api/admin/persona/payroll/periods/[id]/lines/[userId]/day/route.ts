import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { recomputeLine } from "@/lib/payroll-compute";
import { resolveSiblingPeriods } from "@/lib/payroll-cycle";

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
  // Approved OT "until" time (HH:MM) — extends the worked window so the
  // 8h split credits the excess as OT. null = clear (fall back to the
  // approved ot_requests row).
  ot_until: z.string().regex(HHMM).nullable().optional(),
  // Per-day BRANCH reattribution (owner 2026-07-31): book THIS day's worked
  // time to another branch (e.g. ลงเวลานามะ แต่ไปช่วยไฮโปทั้งวัน → ค่าแรงเป็นของ
  // ไฮโป). A branch id moves the day; null reverts to the punched branch;
  // OMITTED (undefined) leaves the day's branch untouched. Only branches in the
  // same company as this period are accepted.
  branch_id: z.number().int().positive().nullable().optional(),
  // ทำงานวันหยุดประเพณี เลื่อน/ใช้สิทธิ์ (owner 2026-08-04): 'use' → วันนั้นจ่าย 2 เท่า
  // เฉพาะคนนี้ + ตัดโควตาวันหยุด −1; 'defer' → ค่าจ้างปกติ ยกวันหยุดไปวันอื่น (ไม่ตัด
  // โควตา); null → ล้างตัวเลือก. OMITTED = ไม่แตะ.
  holiday_choice: z.enum(["defer", "use"]).nullable().optional(),
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
  let clockIn = d.clock_in || null;
  let clockOut = d.clock_out || null;
  const schedIn = d.sched_in || null;
  const schedOut = d.sched_out || null;
  const breakMin = d.break_min ?? null;
  const workedMin = d.worked_min ?? null;
  const otMin = d.ot_min ?? null;
  const otPay = d.ot_pay ?? null;
  const otUntil = d.ot_until || null;
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
    SELECT status, period_start, period_end, branch_id FROM payroll_periods WHERE id = ?
  `).get(periodId) as { status: string; period_start: string; period_end: string; branch_id: number | null } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  }
  if (d.work_date < period.period_start || d.work_date > period.period_end) {
    return NextResponse.json({ error: "date_out_of_range" }, { status: 400 });
  }

  // ── Per-day branch reattribution (owner 2026-07-31) ──────────────────
  // Resolve the source/target periods and guard BOTH ends before mutating.
  // Payroll is one period per branch: moving a day changes the losing branch's
  // and the gaining branch's totals, so both their periods must be open drafts.
  const branchEditing = d.branch_id !== undefined;
  // Periods whose ONE line for this user must be recomputed after the edit.
  // Source is always in (its day-field edits and/or the day leaving it).
  const recomputePeriodIds = new Set<number>([periodId]);
  let branchToStore: number | null | "delete" = null; // what to write to payroll_day_branch
  if (branchEditing) {
    if (period.branch_id == null) {
      // Legacy all-branches period has no company/branch scope to move within.
      return NextResponse.json({ error: "branch_move_unsupported" }, { status: 400 });
    }
    // Natural (punched) branch of this day = the branch of the day's first punch.
    const dayStartIso = new Date(`${d.work_date}T00:00:00+07:00`).toISOString();
    const dayEndIso = new Date(`${d.work_date}T23:59:59+07:00`).toISOString();
    const naturalRow = db.prepare(
      "SELECT branch_id FROM time_entries WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1"
    ).get(userId, dayStartIso, dayEndIso) as { branch_id: number | null } | undefined;
    const naturalBranch = naturalRow?.branch_id ?? null;
    const existingOv = db.prepare(
      "SELECT branch_id FROM payroll_day_branch WHERE user_id = ? AND work_date = ?"
    ).get(userId, d.work_date) as { branch_id: number } | undefined;
    const chosen = (d.branch_id ?? null) as number | null; // defined here (branchEditing)
    const oldEff = existingOv?.branch_id ?? naturalBranch;
    const newEff = chosen === null ? naturalBranch : chosen;

    // Store as an override only when the chosen branch differs from the natural
    // one; picking the natural branch (or null) clears the override.
    branchToStore = (chosen === null || chosen === naturalBranch) ? "delete" : chosen;

    if (oldEff !== newEff) {
      const siblings = resolveSiblingPeriods(db, periodId);
      const sibOf = (b: number) => siblings.find((s) => s.branch_id === b);
      // Gaining branch: the day's cost lands here → its period must exist + be draft.
      if (newEff != null) {
        const gain = sibOf(newEff);
        if (!gain) return NextResponse.json({ error: "target_branch_not_generated" }, { status: 400 });
        if (gain.status !== "draft") {
          return NextResponse.json({ error: "target_not_draft", branch: gain.branch_name }, { status: 400 });
        }
        recomputePeriodIds.add(gain.id);
      }
      // Losing branch: the day's cost leaves here → if it has a period it must
      // also be an open draft (can't alter closed/paid/posted books).
      if (oldEff != null) {
        const lose = sibOf(oldEff);
        if (lose) {
          if (lose.status !== "draft") {
            return NextResponse.json({ error: "source_not_draft", branch: lose.branch_name }, { status: 400 });
          }
          recomputePeriodIds.add(lose.id);
        }
      }
    } else {
      // No effective change (e.g. re-picked the same branch) → nothing to move.
      branchToStore = existingOv ? branchToStore : "delete";
    }
  }

  // Whether the request carries any day-FIELD input (clock/sched/break/…). A
  // branch-only save omits them, so we must NOT touch payroll_line_days then
  // (that would wipe an existing field override).
  const hasDayFieldInput = d.clock_in !== undefined || d.clock_out !== undefined
    || d.sched_in !== undefined || d.sched_out !== undefined
    || d.break_min !== undefined || d.worked_min !== undefined
    || d.ot_min !== undefined || d.ot_pay !== undefined || d.ot_until !== undefined;

  // If the admin filled only ONE side (the common case for a "ขาด" day —
  // a real IN exists but the OUT is missing, or vice-versa), auto-fill the
  // other side from the day's real time-clock punch so they don't have to
  // retype it (owner 2026-06-15). The override needs both times to form a
  // shift; without this the half-filled edit returned need_both_times and
  // the day stayed "ขาด". Only when the request carries day-field input.
  if (hasDayFieldInput && (clockIn === null) !== (clockOut === null)) {
    const startIso = new Date(`${d.work_date}T00:00:00+07:00`).toISOString();
    const endIso = new Date(`${d.work_date}T23:59:59+07:00`).toISOString();
    const wantType = clockIn === null ? "in" : "out";
    const existing = db.prepare(
      "SELECT ts FROM time_entries WHERE user_id = ? AND type = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1"
    ).get(userId, wantType, startIso, endIso) as { ts: string } | undefined;
    if (existing) {
      const hhmm = new Date(new Date(existing.ts).getTime() + 7 * 3600_000).toISOString().slice(11, 16);
      if (wantType === "in") clockIn = hhmm; else clockOut = hhmm;
    }
  }
  // Both-or-neither (after auto-fill): a half-filled pair is still ambiguous.
  if (hasDayFieldInput && (clockIn === null) !== (clockOut === null)) {
    return NextResponse.json({ error: "need_both_times" }, { status: 400 });
  }

  const line = db.prepare(`
    SELECT regular_minutes, ot_minutes, holiday_minutes, days_worked,
           base_pay, ot_pay, gross_pay, net_pay
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId);
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });
  const beforeSnapshot = { work_date: d.work_date, line };

  const allNull = !clockIn && !clockOut && !schedIn && !schedOut
    && breakMin === null && workedMin === null && otMin === null && otPay === null
    && otUntil === null;

  try {
    db.transaction(() => {
      // (1) Per-day FIELD/clock override — only when the request carries them,
      // so a branch-only save never disturbs an existing time override.
      if (hasDayFieldInput) {
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
               sched_in, sched_out, break_min, worked_min, ot_min, ot_pay, ot_until,
               edited_by, edited_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (period_id, user_id, work_date) DO UPDATE SET
              clock_in = excluded.clock_in,
              clock_out = excluded.clock_out,
              sched_in = excluded.sched_in,
              sched_out = excluded.sched_out,
              break_min = excluded.break_min,
              worked_min = excluded.worked_min,
              ot_min = excluded.ot_min,
              ot_pay = excluded.ot_pay,
              ot_until = excluded.ot_until,
              edited_by = excluded.edited_by,
              edited_at = excluded.edited_at
          `).run(
            periodId, userId, d.work_date, clockIn, clockOut,
            schedIn, schedOut, breakMin, workedMin, otMin, otPay, otUntil,
            user.id, new Date().toISOString()
          );
        }
      }

      // (2) Per-day BRANCH reattribution — book the day to the chosen branch.
      if (branchEditing) {
        if (branchToStore === "delete") {
          db.prepare(
            "DELETE FROM payroll_day_branch WHERE user_id = ? AND work_date = ?"
          ).run(userId, d.work_date);
        } else {
          db.prepare(`
            INSERT INTO payroll_day_branch (user_id, work_date, branch_id, edited_by, edited_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (user_id, work_date) DO UPDATE SET
              branch_id = excluded.branch_id,
              edited_by = excluded.edited_by,
              edited_at = excluded.edited_at
          `).run(userId, d.work_date, branchToStore, user.id, new Date().toISOString());
        }
      }

      // (2b) วันหยุดประเพณี เลื่อน/ใช้สิทธิ์ (owner 2026-08-04). 'use'/'defer' upsert;
      // null clears. Only touched when the field is present in the request.
      if (d.holiday_choice !== undefined) {
        if (d.holiday_choice === null) {
          db.prepare(
            "DELETE FROM holiday_work_choices WHERE user_id = ? AND work_date = ?"
          ).run(userId, d.work_date);
        } else {
          db.prepare(`
            INSERT INTO holiday_work_choices (user_id, work_date, choice, decided_by, decided_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (user_id, work_date) DO UPDATE SET
              choice = excluded.choice,
              decided_by = excluded.decided_by,
              decided_at = excluded.decided_at
          `).run(userId, d.work_date, d.holiday_choice, user.id, new Date().toISOString());
        }
      }

      // (3) Recompute the affected lines. Source always; the losing/gaining
      // branch periods too when the day moved. recomputeLine preserves each
      // line's manual money extras and can create a fresh line in the gaining
      // branch (auto-include). A branch with no line for this user throws
      // line_not_found — harmless there, so skip it.
      for (const pid of recomputePeriodIds) {
        try {
          recomputeLine(db, pid, userId);
        } catch (e) {
          if (pid === periodId) throw e; // the source line must recompute
          if (!(e instanceof Error && e.message === "line_not_found")) throw e;
        }
      }
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
      worked_min: workedMin, ot_min: otMin, ot_pay: otPay, ot_until: otUntil,
      branch_id: branchEditing ? (branchToStore === "delete" ? null : branchToStore) : undefined,
      line: after ?? {}
    }),
    branchEditing ? `แก้ไขรายวัน + ย้ายสาขา ${d.work_date}` : `แก้ไขรายวัน ${d.work_date}`,
    new Date().toISOString()
  );
  logPersonaAction(user.id, "payroll.line.day_edit", periodId);

  return NextResponse.json({ ok: true });
}
