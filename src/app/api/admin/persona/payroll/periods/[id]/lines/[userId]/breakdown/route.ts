import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  applyPtGrace, pickScheduled, deductBreak, splitRegularOt, computeOtPay,
  overlaySwapShifts, branchHourlyRateSelect, keepEntryForBranch, loadDayBranchMap,
  type ScheduledShift, type PayrollSettings
} from "@/lib/payroll-compute";
import { resolveSiblingPeriods } from "@/lib/payroll-cycle";

// GET /api/admin/persona/payroll/periods/[id]/lines/[userId]/breakdown
//
// Per-day breakdown of a single staff's pay-period line. Reads the
// raw time_entries inside [period_start, period_end] and pairs them
// up (in → out) so the admin opening the "แก้ไขเงินเดือน" modal can
// see WHERE the line's regular_minutes / ot_minutes came from.
//
// Pair-up rule (same as lib/payroll-compute.ts pairUp() — but
// simplified for visualisation; we don't need to recalculate the OT
// thresholds, just show the raw clock points alongside the totals
// already stored on payroll_lines):
//   - Walk through entries in chronological order.
//   - Each `in` starts a new pair; the next `out` closes it.
//   - An orphan in (no following out before the next in) is shown
//     with workOut=null so the admin can spot the gap.
//   - An orphan out (no preceding in) is shown with workIn=null.
//
// Output is grouped by calendar date (Asia/Bangkok local day). Days
// with no entries at all are omitted — admin sees only days the
// staff actually had activity.
//
// Auth: any signed-in admin in the same branch context can fetch.
// We don't filter by branch on the entries because legacy rows have
// branch_id NULL and the modal already represents that staff's full
// pay period across branches.

type EntryRow = { id: number; ts: string; type: "in" | "out"; selfie_path: string | null; branch_id: number | null };

type DayPair = {
  date: string;          // YYYY-MM-DD (BKK local)
  workIn: string | null;  // HH:MM (BKK local) or null when orphaned out — บันทึกเวลาเข้าออก
  workOut: string | null; // HH:MM (BKK local) or null when orphaned in
  durationMinutes: number; // raw clocked minutes, 0 when one side missing
  // Scheduled shift box (เวลาเข้าออกงาน ตามกะ) for this day, when the
  // staff has a roster assignment. Null when unscheduled.
  schedIn: string | null;  // HH:MM
  schedOut: string | null; // HH:MM
  // Scheduled break (เวลาพัก) deducted from the worked window, in minutes.
  breakMinutes: number;
  // Working minutes after grace clamp + break deduction (ชั่วโมงทำงาน).
  // = durationMinutes for FT / unscheduled days. This is the regular
  // (non-OT) portion that gets paid.
  effectiveMinutes: number;
  // Overtime portion (ทำงานล่วงเวลา) — minutes beyond 8h after break.
  otMinutes: number;
  // ค่าล่วงเวลา for this day (THB), and ค่าตอบแทน (regular + OT pay).
  otPay: number;
  pay: number;
  // True when this row comes from an admin per-day override
  // (payroll_line_days), not the raw time-clock.
  edited: boolean;
  // Attendance status vs the scheduled shift (PT only): minutes the
  // clock-in was late beyond grace / clock-out was early beyond grace.
  lateMin: number;
  earlyMin: number;
  // True when the day is a วันพิเศษ (pt_special) — PT pay ×1.5.
  holiday: boolean;
  // True when the day is a วันจ่ายสองเท่า (double_pay) — PT pay ×2 (wins over ×1.5).
  double: boolean;
  // True when the date is any public holiday (owner 2026-08-04) — surfaces the
  // เลื่อน/ใช้สิทธิ์ control in the day editor.
  publicHoliday: boolean;
  // This user's เลื่อน/ใช้สิทธิ์ choice for the date, or null if none set.
  holidayChoice: "defer" | "use" | null;
  // Branch where this day's hours are BOOKED — the per-day reattribution
  // (payroll_day_branch) when set, else where the clock-in was recorded
  // (owner 2026-07-28: แท็กสาขาที่ลงเวลา; 2026-07-31: ย้ายสาขารายวันได้). null for
  // legacy rows / synthetic status rows.
  branch: string | null;
  // Effective branch id for this day (for the editor's branch picker). null
  // when unknown (no punch + no override) or a synthetic status row.
  branch_id: number | null;
  // Non-working-day label for a synthetic row (no clock-in): "วันหยุด"
  // or the leave-type label (ลาพักร้อน/ลากิจ/ลาป่วย/…). null on normal rows.
  statusLabel: string | null;
};

type Period = {
  period_start: string;
  period_end: string;
};

// Asia/Bangkok ISO date (YYYY-MM-DD) for a given UTC ISO timestamp.
function bkkDate(iso: string): string {
  const d = new Date(iso);
  // +07:00 fixed offset — Thailand doesn't observe DST.
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(0, 10);
}
function bkkHHMM(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(11, 16);
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin" && user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    return NextResponse.json({ error: "invalid_period_id" }, { status: 400 });
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  const db = getDb();
  const period = db.prepare(`
    SELECT period_start, period_end, branch_id FROM payroll_periods WHERE id = ?
  `).get(periodId) as (Period & { branch_id: number | null }) | undefined;
  if (!period) {
    return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  }

  // Branches this day can be moved to = the sibling branch-periods of THIS pay
  // run (same cycle/target/dates/pay_date), independent of company_id (owner
  // 2026-07-31). Only offered when the period is branch-stamped and more than
  // one branch ran this pay period.
  const siblings = period.branch_id != null ? resolveSiblingPeriods(db, periodId) : [];
  const branchOptions = siblings
    .filter((s) => s.branch_name != null)
    .map((s) => ({ id: s.branch_id, name: s.branch_name as string, status: s.status }));

  // PT grace + scheduled-break only apply to part-timers — FT days keep
  // raw clocked minutes. Load type + rate so the per-day money columns
  // match what the pay engine stored.
  const emp = db.prepare(`
    SELECT employment_type, ${branchHourlyRateSelect(period.branch_id)}, monthly_salary, track_attendance FROM users WHERE id = ?
  `).get(userId) as { employment_type: "pt" | "ft" | null; hourly_rate: number | null; monthly_salary: number | null; track_attendance: number | null } | undefined;
  const isPt = emp?.employment_type === "pt";
  // Salaried execs (track_attendance=0) never get OT — same as the pay engine.
  const isExec = emp?.employment_type === "ft" && emp?.track_attendance === 0;

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;
  const ptRate = emp?.hourly_rate ?? settings.pt_default_hourly_rate;
  // FT per-day rate for the REFERENCE per-day amounts shown in the editor (owner
  // 2026-08-03: อยากเห็นแต่ละวันได้เท่าไหร่ โดยเฉพาะวันคูณสอง). FT base is a monthly
  // salary paid as a lump; here we surface the daily-equivalent value so a 2× day
  // is visible per day. rateForPay drives both the displayed base and OT.
  const ftHourlyEquiv = emp?.monthly_salary ? emp.monthly_salary / 30 / 8 : 0;
  const rateForPay = isPt ? ptRate : ftHourlyEquiv;
  // FT ประจำ (เงินเดือน) — ครอบคลุมประจำเดือน + เดือนเปลี่ยนผ่าน (weekly) + exec.
  // สำหรับกลุ่มนี้ modal per-day แสดงเป็น "ส่วนเพิ่ม/หัก" จากเงินเดือน (ไม่ใช่ยอดเต็ม
  // ต่อวัน) เพื่อให้กระทบยอดตรงกับยอดจ่ายจริงใน payroll_lines (owner 2026-08-04). PT
  // ไม่แตะ. round2 helper สำหรับปัดสองตำแหน่ง (route นี้ยังไม่มี helper กลาง).
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const ftMonthly = emp?.employment_type === "ft" && !!emp?.monthly_salary;
  // ยอดจ่ายจริงที่บันทึกไว้สำหรับรอบ+คนนี้ — base_pay = salary − ลาไม่รับค่าจ้าง +
  // ftDoubleBonus, ot_pay = ค่าล่วงเวลารวม (payroll-compute.ts). ไม่มีแถว → 0.
  const lineRow = db.prepare(
    `SELECT base_pay, ot_pay FROM payroll_lines WHERE period_id = ? AND user_id = ?`
  ).get(periodId, userId) as { base_pay: number; ot_pay: number } | undefined;
  const actualBase = lineRow?.base_pay ?? 0;
  const actualOt = lineRow?.ot_pay ?? 0;
  const branchNameById = new Map<number, string>(
    (db.prepare("SELECT id, name FROM branches").all() as Array<{ id: number; name: string }>).map((b) => [b.id, b.name])
  );
  // Per-day branch reattribution (payroll_day_branch) — a moved day is BOOKED
  // to this branch, overriding where it was punched (owner 2026-07-31).
  const dayBranchByDate = new Map<string, number>(
    (db.prepare(
      "SELECT work_date, branch_id FROM payroll_day_branch WHERE user_id = ? AND work_date >= ? AND work_date <= ?"
    ).all(userId, period.period_start, period.period_end) as Array<{ work_date: string; branch_id: number }>)
      .map((r) => [r.work_date, r.branch_id])
  );
  // Effective booked branch id for a day = reattribution ?? punched branch.
  const effBranchId = (date: string, punchBranch: number | null): number | null =>
    dayBranchByDate.get(date) ?? punchBranch;

  // วันพิเศษ (pt_special=1) → PT premium 1.5× (same as the engine).
  // Public holidays (all rows) are info-only — they drive the "วันหยุด"
  // status row, NOT pay (owner 2026-06-03).
  const phRows = db.prepare(`
    SELECT date, pt_special, double_pay FROM public_holidays WHERE date >= ? AND date <= ?
  `).all(period.period_start, period.period_end) as Array<{ date: string; pt_special: number; double_pay: number }>;
  const holidaySet = new Set(phRows.filter((h) => h.pt_special === 1).map((h) => h.date));
  const publicHolidaySet = new Set(phRows.map((h) => h.date));
  // วันจ่ายสองเท่า (double_pay=1) → PT 2× on both base + OT, and it WINS over the
  // 1.5× วันพิเศษ premium. This must mirror the pay engine (payroll-compute.ts
  // computeShiftBasedPay, `mult = isDouble ? 2 : isHoliday ? 1.5 : 1`) — without
  // it the modal showed PT days at 1× while the actual line was paid 2× (owner
  // 2026-07-28: "2x ยังไม่มีผลกับพาร์ทไทม์").
  const doubleSet = new Set(phRows.filter((h) => h.double_pay === 1).map((h) => h.date));
  // ทำงานวันหยุดประเพณี "ใช้สิทธิ์" ของ user คนนี้ (owner 2026-08-04) → 2× เฉพาะเขา,
  // mirror doubleSetFor() ในเครื่องคิดเงิน เพื่อให้ modal per-day ตรงกับยอดจริง.
  const holidayChoiceByDate = new Map<string, "defer" | "use">();
  for (const r of db.prepare(
    `SELECT work_date, choice FROM holiday_work_choices
     WHERE user_id = ? AND work_date >= ? AND work_date <= ?`
  ).all(userId, period.period_start, period.period_end) as Array<{ work_date: string; choice: "defer" | "use" }>) {
    holidayChoiceByDate.set(r.work_date, r.choice);
    if (r.choice === "use") doubleSet.add(r.work_date);
  }

  // Scheduled work shifts in the period, keyed by BKK assignment date.
  // Same anchoring rule as the pay engine (lib/payroll-compute.ts).
  const addDayYmd = (ymd: string): string => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const rosterRows = db.prepare(`
    SELECT ra.assignment_date, sc.start_time, sc.end_time, sc.break_start, sc.break_end,
           sc.code, sc.name AS shift_name, sc.color
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.user_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'work'
  `).all(userId, period.period_start, period.period_end) as Array<{
    assignment_date: string; start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
    code: string; shift_name: string | null; color: string | null;
  }>;
  const scheduledByDate = new Map<string, ScheduledShift[]>();
  // The work shift assigned to each date — for the กะ tag on worked days +
  // to tell "scheduled-but-absent" from a real rest day (owner 2026-06-18).
  type ShiftTag = { code: string; name: string | null; color: string | null };
  const shiftByDate = new Map<string, ShiftTag>();
  for (const r of rosterRows) {
    if (!r.start_time || !r.end_time || r.start_time === r.end_time) continue;
    if (!shiftByDate.has(r.assignment_date)) {
      shiftByDate.set(r.assignment_date, { code: r.code, name: r.shift_name, color: r.color });
    }
    const startTs = new Date(`${r.assignment_date}T${r.start_time}:00+07:00`).toISOString();
    const endDate = r.end_time < r.start_time ? addDayYmd(r.assignment_date) : r.assignment_date;
    const endTs = new Date(`${endDate}T${r.end_time}:00+07:00`).toISOString();
    let breakStartTs: string | null = null;
    let breakEndTs: string | null = null;
    if (r.break_start && r.break_end && r.break_start !== r.break_end) {
      breakStartTs = new Date(`${r.assignment_date}T${r.break_start}:00+07:00`).toISOString();
      const bEndDate = r.break_end < r.break_start ? addDayYmd(r.assignment_date) : r.assignment_date;
      breakEndTs = new Date(`${bEndDate}T${r.break_end}:00+07:00`).toISOString();
    }
    const list = scheduledByDate.get(r.assignment_date) ?? [];
    list.push({ startTs, endTs, breakStartTs, breakEndTs });
    scheduledByDate.set(r.assignment_date, list);
  }
  // Shift-swap overlay — show the swapped (friend's) shift in the calc
  // view so it matches what the pay engine used (owner 2026-06-08).
  overlaySwapShifts(db, userId, period.period_start, period.period_end, scheduledByDate);

  // Per-day overrides (payroll_line_days) — admin corrections that win
  // over the time-clock for a given date (clock times + field overrides).
  type FieldOv = {
    clock_in: string | null; clock_out: string | null;
    sched_in: string | null; sched_out: string | null;
    break_min: number | null; worked_min: number | null;
    ot_min: number | null; ot_pay: number | null; ot_until: string | null;
    unpaid_absence: number | null;
  };
  const overrideRows = db.prepare(`
    SELECT work_date, clock_in, clock_out,
           sched_in, sched_out, break_min, worked_min, ot_min, ot_pay, ot_until, unpaid_absence
    FROM payroll_line_days WHERE period_id = ? AND user_id = ?
  `).all(periodId, userId) as Array<{ work_date: string } & FieldOv>;
  const overrideByDate = new Map<string, { clock_in: string | null; clock_out: string | null }>();
  const fieldOvByDate = new Map<string, FieldOv>();
  for (const r of overrideRows) {
    overrideByDate.set(r.work_date, { clock_in: r.clock_in, clock_out: r.clock_out });
    fieldOvByDate.set(r.work_date, r);
  }

  // Approved OT for this user → date. Late/early gated independently
  // (owner 2026-08-04): late by `status`, early by `early_status`.
  const otApprovedRows = db.prepare(`
    SELECT work_date, requested_until, requested_from, status, early_status
    FROM ot_requests
    WHERE user_id = ? AND (status = 'approved' OR early_status = 'approved')
      AND work_date >= ? AND work_date <= ?
  `).all(userId, period.period_start, period.period_end) as Array<{
    work_date: string; requested_until: string; requested_from: string | null;
    status: string; early_status: string | null;
  }>;
  const approvedOtByDate = new Map<string, string>();
  const approvedEarlyByDate = new Map<string, string>();
  for (const r of otApprovedRows) {
    if (r.status === "approved" && r.requested_until) approvedOtByDate.set(r.work_date, r.requested_until);
    if (r.early_status === "approved" && r.requested_from) approvedEarlyByDate.set(r.work_date, r.requested_from);
  }

  // Build a fully-populated pair from a raw in/out couple — replicating
  // the engine: grace clamp → scheduled break → regular/OT split →
  // approved OT → pay.
  // Whole-minute duration (seconds ignored) — matches the pay engine.
  const floorMin = (ts: string) => Math.floor(new Date(ts).getTime() / 60000);

  function buildPair(inTs: string, outTs: string | null, edited = false, branchId: number | null = null): DayPair {
    const date = bkkDate(inTs);
    const ov = fieldOvByDate.get(date);
    const rawMin = outTs ? Math.max(0, floorMin(outTs) - floorMin(inTs)) : 0;
    const holiday = isPt && holidaySet.has(date);
    // Double-pay applies to everyone (FT + PT), same as the pay engine — so an FT's
    // 2× day is flagged per day too (owner 2026-08-03). The 1.5× วันพิเศษ stays PT-only.
    const isDoubleDay = doubleSet.has(date);

    // Scheduled window — per-day override wins over the roster (both PT + FT,
    // matching the pay engine).
    let sched = pickScheduled(scheduledByDate.get(date) ?? [], { startTs: inTs });
    if (ov?.sched_in && ov?.sched_out) {
      const sStart = new Date(`${date}T${ov.sched_in}:00+07:00`).toISOString();
      const sEndDate = ov.sched_out < ov.sched_in ? addDayYmd(date) : date;
      const sEnd = new Date(`${sEndDate}T${ov.sched_out}:00+07:00`).toISOString();
      sched = { startTs: sStart, endTs: sEnd, breakStartTs: sched?.breakStartTs ?? null, breakEndTs: sched?.breakEndTs ?? null };
    }

    // OT window is approval-gated for everyone (owner 2026-07-14): extends past
    // the scheduled end only up to an approved OT request's "until" (or an admin
    // per-day ot_until override). No auto over-8h. Execs never get OT.
    const reqUntil = isExec ? null : (ov?.ot_until ?? approvedOtByDate.get(date) ?? null);
    const reqFrom = isExec ? null : (approvedEarlyByDate.get(date) ?? null);
    const lateApproved = !!(reqUntil && /^\d{2}:\d{2}$/.test(reqUntil));
    const earlyApproved = !!(reqFrom && /^\d{2}:\d{2}$/.test(reqFrom));
    const otApproved = lateApproved || earlyApproved;  // keeps split.ot below
    let otUntilTs: string | null = null;
    let otFromTs: string | null = null;
    if (sched && outTs && lateApproved) {
      otUntilTs = new Date(`${date}T${reqUntil}:00+07:00`).toISOString();
    }
    if (sched && outTs && earlyApproved) {
      otFromTs = new Date(`${date}T${reqFrom}:00+07:00`).toISOString();
    }

    let breakMinutes = 0;
    let workedMin = rawMin;       // after break, before OT split
    let lateMin = 0;
    let earlyMin = 0;
    if (outTs) {
      if (sched) {
        const g = applyPtGrace({ startTs: inTs, endTs: outTs }, sched, otUntilTs, otFromTs);
        breakMinutes = Math.round(g.breakMinutes);
        workedMin = Math.round(g.workedMinutes);
        lateMin = Math.round(g.lateMinutes);
        earlyMin = Math.round(g.earlyMinutes);
      } else {
        const db2 = deductBreak(rawMin, settings);
        breakMinutes = Math.round(db2.deducted);
        workedMin = Math.round(db2.workedMinutes);
      }
    }
    // Per-day break override (recompute worked from gross − new break).
    const grossForBreak = outTs && sched ? workedMin + breakMinutes : rawMin;
    if (ov?.break_min != null) {
      breakMinutes = ov.break_min;
      workedMin = Math.max(0, grossForBreak - ov.break_min);
    }

    const split = splitRegularOt(workedMin);
    // Per-day field overrides win over the computed split. Otherwise OT counts
    // only when approved (matches the pay engine); unapproved over-8h on an
    // unscheduled day rolls into regular so the day still ties out to worked
    // minutes. On a scheduled day the window is already capped so split.ot = 0.
    const autoOt = otApproved ? split.ot : 0;
    const regMin = ov?.worked_min != null ? ov.worked_min : split.regular + (split.ot - autoOt);
    const otMin = ov?.ot_min != null ? ov.ot_min : autoOt;

    // 2× (double_pay) wins over 1.5× (วันพิเศษ) — same precedence as the engine.
    const mult = isDoubleDay ? 2 : holiday ? 1.5 : 1;
    // Per-day amounts for BOTH PT and FT (owner 2026-08-03). FT uses the daily
    // salary-equivalent so a 2× day shows base×2 per day; exec (no clock) has no OT.
    const regularPay = (regMin / 60) * rateForPay * mult;
    const otPay = isExec ? 0
      : (ov?.ot_pay != null ? ov.ot_pay : computeOtPay(otMin, rateForPay, settings, mult));

    const hasFieldOv = !!ov && (
      ov.sched_in != null || ov.break_min != null || ov.worked_min != null ||
      ov.ot_min != null || ov.ot_pay != null
    );

    return {
      date,
      workIn: bkkHHMM(inTs),
      workOut: outTs ? bkkHHMM(outTs) : null,
      durationMinutes: rawMin,
      schedIn: sched ? bkkHHMM(sched.startTs) : null,
      schedOut: sched ? bkkHHMM(sched.endTs) : null,
      breakMinutes,
      effectiveMinutes: regMin,
      otMinutes: otMin,
      otPay: Math.round(otPay * 100) / 100,
      pay: Math.round((regularPay + otPay) * 100) / 100,
      edited: edited || hasFieldOv,
      lateMin,
      earlyMin,
      holiday,
      double: isDoubleDay,
      publicHoliday: publicHolidaySet.has(date),
      holidayChoice: holidayChoiceByDate.get(date) ?? null,
      branch: effBranchId(date, branchId) != null ? (branchNameById.get(effBranchId(date, branchId)!) ?? null) : null,
      branch_id: effBranchId(date, branchId),
      statusLabel: null
    };
  }

  // Build a pair from a per-day override (HH:MM strings on work_date).
  function buildOverridePair(date: string, clockIn: string, clockOut: string): DayPair {
    const inTs = new Date(`${date}T${clockIn}:00+07:00`).toISOString();
    const endDate = clockOut < clockIn ? addDayYmd(date) : date;
    const outTs = new Date(`${endDate}T${clockOut}:00+07:00`).toISOString();
    return buildPair(inTs, outTs, true);
  }

  // ── Non-working days (status rows) ────────────────────────────
  // Roster day-off + approved leave + public holidays are surfaced as
  // status rows so the admin can verify the period at a glance even
  // when there's no clock-in (owner 2026-06-03).
  const dayOffRows = db.prepare(`
    SELECT ra.assignment_date AS d
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.user_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'day_off'
  `).all(userId, period.period_start, period.period_end) as Array<{ d: string }>;
  const dayOffSet = new Set(dayOffRows.map((r) => r.d));

  const leaveLabelTh = (type: string): string => ({
    sick: "ลาป่วย", personal: "ลากิจ", annual: "ลาพักร้อน",
    pt_emergency: "ลาฉุกเฉิน", maternity: "ลาคลอด", ordination: "ลาอุปสมบท",
    sterilization: "ลาทำหมัน", military: "ลาเกณฑ์ทหาร", business: "ลาประชุมงาน"
  } as Record<string, string>)[type] ?? "ลา";
  const leaveRows = db.prepare(`
    SELECT type, date_from, date_to FROM leave_requests
    WHERE user_id = ? AND status = 'approved'
      AND NOT (date_to < ? OR date_from > ?)
  `).all(userId, period.period_start, period.period_end) as Array<{
    type: string; date_from: string; date_to: string;
  }>;
  const leaveByDate = new Map<string, string>();
  for (const lv of leaveRows) {
    let cur = lv.date_from < period.period_start ? period.period_start : lv.date_from;
    const end = lv.date_to > period.period_end ? period.period_end : lv.date_to;
    while (cur <= end) {
      leaveByDate.set(cur, leaveLabelTh(lv.type));
      cur = addDayYmd(cur);
    }
  }

  // Pull all entries within the period (inclusive on both ends).
  // We expand the end to 23:59:59 BKK so an entry at, say, 21:14 on
  // the last day still falls inside. Stored ts is UTC; the period
  // bounds are date-only strings — comparing lexicographically is
  // safe because ISO sorts correctly.
  const fromIso = `${period.period_start}T00:00:00`;
  const toIso = `${period.period_end}T23:59:59`;
  const rawEntries = db.prepare(`
    SELECT id, ts, type, selfie_path, branch_id FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(userId, fromIso, toIso) as EntryRow[];
  // Scope to THIS period's branch by EFFECTIVE branch — EXACTLY as the pay engine
  // does (owner 2026-08-18): a cross-branch worker (ศรุตา นามะ+ไฮโป) must see only
  // the days booked to THIS branch here, so the modal total ties out to the line
  // and doesn't look like two branches lumped together. Reattribution (moved day)
  // pulls a day in / pushes it out; an approved NULL-branch cert is always kept.
  // Legacy NULL-branch periods stay unfiltered (whole pay period across branches).
  const dayBranch = period.branch_id != null
    ? loadDayBranchMap(db, period.period_start, period.period_end)
    : new Map<string, number>();
  const certIds = period.branch_id != null
    ? new Set((db.prepare(
        "SELECT entry_id FROM time_certifications WHERE status = 'approved' AND entry_id IS NOT NULL"
      ).all() as Array<{ entry_id: number }>).map((r) => r.entry_id))
    : new Set<number>();
  const entries = rawEntries.filter((e) =>
    keepEntryForBranch({ id: e.id, user_id: userId, ts: e.ts, type: e.type, branch_id: e.branch_id },
      period.branch_id, dayBranch, certIds));
  // Dates the person clocked in at ANOTHER branch this period (dropped by the
  // filter above). Those days belong to that branch's round — don't surface them
  // here as a "ขาดงาน"/"วันหยุด" status row, which would wrongly read as absent.
  const keptIds = new Set(entries.map((e) => e.id));
  const workedElsewhereDates = new Set(
    rawEntries.filter((e) => e.type === "in" && !keptIds.has(e.id)).map((e) => bkkDate(e.ts))
  );

  // Pair entries: each "in" looks for the next "out" before the next "in".
  // Output groups by BKK calendar date.
  type Day = {
    date: string;
    pairs: DayPair[];
    totalMinutes: number;        // raw clocked
    effectiveMinutes: number;    // ชั่วโมงทำงาน (regular, after break)
    breakMinutes: number;        // เวลาพัก
    otMinutes: number;           // ทำงานล่วงเวลา
    otPay: number;               // ค่าล่วงเวลา
    pay: number;                 // ค่าตอบแทน (regular + OT)
    edited: boolean;             // has an admin per-day override
    // Raw saved overrides for this day (null fields = not overridden) —
    // so the edit panel can prefill exactly what was pinned.
    override: FieldOv | null;
    // OT "until" time (HH:MM) in effect for the day: the admin override
    // when set, otherwise the approved ot_requests row. The edit panel
    // prefills the OT field from this. otApprovedUntil is the approved
    // request alone (for the "ขออนุมัติถึง …" hint).
    otUntil: string | null;
    otApprovedUntil: string | null;
    // The work shift (กะ) assigned to this date, for the tag on worked days.
    shift: ShiftTag | null;
  };
  const days = new Map<string, Day>();
  function ensureDay(date: string): Day {
    let d = days.get(date);
    if (!d) {
      const approved = approvedOtByDate.get(date) ?? null;
      d = { date, pairs: [], totalMinutes: 0, effectiveMinutes: 0,
            breakMinutes: 0, otMinutes: 0, otPay: 0, pay: 0, edited: false,
            override: fieldOvByDate.get(date) ?? null,
            otUntil: (fieldOvByDate.get(date)?.ot_until ?? approved) || null,
            otApprovedUntil: approved,
            shift: shiftByDate.get(date) ?? null };
      days.set(date, d);
    }
    return d;
  }
  function pushPair(p: DayPair): void {
    const day = ensureDay(p.date);
    day.pairs.push(p);
    day.totalMinutes += p.durationMinutes;
    day.effectiveMinutes += p.effectiveMinutes;
    day.breakMinutes += p.breakMinutes;
    day.otMinutes += p.otMinutes;
    day.otPay += p.otPay;
    day.pay += p.pay;
    if (p.edited) day.edited = true;
  }

  let openIn: EntryRow | null = null;
  for (const e of entries) {
    // Dates with an admin override are rebuilt from the override below —
    // skip the time-clock pairs for those days entirely.
    if (e.type === "in") {
      if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null, false, openIn.branch_id));
      openIn = e;
    } else {
      // type === "out"
      if (openIn) {
        if (!overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, e.ts, false, openIn.branch_id));
        openIn = null;
      } else if (!overrideByDate.has(bkkDate(e.ts))) {
        // Orphan out — clock-out with no clock-in. Surface it under
        // its own day so admin sees the broken pair.
        const day = ensureDay(bkkDate(e.ts));
        day.pairs.push({
          date: bkkDate(e.ts),
          workIn: null,
          workOut: bkkHHMM(e.ts),
          durationMinutes: 0,
          schedIn: null,
          schedOut: null,
          breakMinutes: 0,
          effectiveMinutes: 0,
          otMinutes: 0,
          otPay: 0,
          pay: 0,
          edited: false,
          lateMin: 0,
          earlyMin: 0,
          holiday: false,
          double: false,
          publicHoliday: publicHolidaySet.has(bkkDate(e.ts)),
          holidayChoice: holidayChoiceByDate.get(bkkDate(e.ts)) ?? null,
          branch: effBranchId(bkkDate(e.ts), e.branch_id) != null ? (branchNameById.get(effBranchId(bkkDate(e.ts), e.branch_id)!) ?? null) : null,
          branch_id: effBranchId(bkkDate(e.ts), e.branch_id),
          statusLabel: null
        });
      }
    }
  }
  // Trailing unmatched "in" (still on shift at period end / forgot
  // to clock out) — flush as orphan too (unless overridden).
  if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null, false, openIn.branch_id));

  // Now lay down the admin per-day overrides — each wins over the
  // time-clock for its date.
  for (const [date, o] of overrideByDate) {
    const day = ensureDay(date);
    day.edited = true;
    if (o.clock_in && o.clock_out) {
      pushPair(buildOverridePair(date, o.clock_in, o.clock_out));
    } else {
      // Cleared/absent override with no usable times — show an empty
      // edited row so the admin sees the day is intentionally zeroed.
      day.pairs.push({
        date, workIn: null, workOut: null, durationMinutes: 0,
        schedIn: null, schedOut: null, breakMinutes: 0,
        effectiveMinutes: 0, otMinutes: 0, otPay: 0, pay: 0, edited: true,
        lateMin: 0, earlyMin: 0, holiday: false, double: false,
        publicHoliday: publicHolidaySet.has(date), holidayChoice: holidayChoiceByDate.get(date) ?? null,
        branch: null, branch_id: null, statusLabel: "ขาดงาน"
      });
    }
  }

  // Emit a status row for EVERY non-worked day in the period (owner
  // 2026-06-18 — show every day, never skip): ลา (filed + approved) wins;
  // a roster day-off / public holiday / no work assignment = วันหยุด; a day
  // they WERE scheduled to work but didn't clock in (and no leave) = ขาดงาน.
  for (let d = period.period_start; d <= period.period_end; d = addDayYmd(d)) {
    if (days.has(d)) continue;
    // Worked at another branch that day → its own round shows it; skip here.
    if (workedElsewhereDates.has(d)) continue;
    const label = leaveByDate.get(d)
      ?? ((dayOffSet.has(d) || publicHolidaySet.has(d) || !shiftByDate.has(d)) ? "วันหยุด" : "ขาดงาน");
    const day = ensureDay(d);
    day.pairs.push({
      date: d, workIn: null, workOut: null, durationMinutes: 0,
      schedIn: null, schedOut: null, breakMinutes: 0,
      effectiveMinutes: 0, otMinutes: 0, otPay: 0, pay: 0, edited: false,
      lateMin: 0, earlyMin: 0, holiday: holidaySet.has(d), double: false,
      publicHoliday: publicHolidaySet.has(d), holidayChoice: holidayChoiceByDate.get(d) ?? null,
      branch: null, branch_id: null, statusLabel: label
    });
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  // ── FT ประจำ: แปลง pay รายวันเป็น "ส่วนเพิ่ม/หัก" จากเงินเดือน ──────────────
  // FT ประจำได้เงินเดือนก้อนเดียว (รวมวันหยุด/วัน off) — ตารางจึงไม่ควรบวกยอดเต็ม
  // ต่อวัน (ได้ผลรวมน้อยกว่ายอดจริง). แทนที่ pay ของแต่ละวันด้วย DELTA:
  //   - วันทำงานที่เป็นวันจ่าย 2 เท่า → พรีเมียม +1 เท่า = (regMin/60) × ftHourlyEquiv
  //     (ตรงกับ ftDoubleBonus ที่ถูกฝังใน base_pay: payroll-compute.ts บรรทัด 957)
  //   - วันปกติ/วันหยุด/วัน off/ลา → 0 (รวมอยู่ในเงินเดือนแล้ว)
  //   - ล่วงเวลา (otPay) บวกเพิ่มเสมอ
  // ผลรวม delta = doublePremium + ล่วงเวลา → บวกกลับ salaryBase ได้ยอดจ่ายจริง.
  let doublePremiumTotal = 0;
  if (ftMonthly) {
    for (const day of sortedDays) {
      let dayPay = 0;
      for (const p of day.pairs) {
        const regularDelta = p.double ? round2((p.effectiveMinutes / 60) * ftHourlyEquiv) : 0;
        doublePremiumTotal += regularDelta;
        p.pay = round2(regularDelta + p.otPay);
        dayPay += p.pay;
      }
      day.pay = round2(dayPay);
    }
    doublePremiumTotal = round2(doublePremiumTotal);
  }

  // Selfies captured at clock-in/out (owner 2026-07-14) — flat list keyed by
  // entry id so the admin can spot-check "who actually punched" per day. Only
  // punches that carry a selfie are returned.
  const selfies = entries
    .filter((e) => e.selfie_path)
    .map((e) => ({ entryId: e.id, date: bkkDate(e.ts), time: bkkHHMM(e.ts), type: e.type }));

  return NextResponse.json({
    ok: true,
    is_pt: isPt,
    period_start: period.period_start,
    period_end: period.period_end,
    period_branch_id: period.branch_id,
    // Sibling branches the day can be reattributed to (incl. this one). Empty /
    // single-entry → the client hides the branch picker.
    branch_options: branchOptions,
    // FT ประจำ (เงินเดือน) — client ใช้ธงนี้เปิดโหมดกระทบยอด "เงินเดือน + ส่วนเพิ่ม/หัก".
    // salaryBase = base_pay − doublePremium = เงินเดือน (หลังหักลาถ้ามี, รวมวันหยุด).
    ftMonthly,
    salaryBase: round2(actualBase - doublePremiumTotal),
    doublePremium: round2(doublePremiumTotal),
    actualBase,
    actualOt,
    actualTotal: round2(actualBase + actualOt),
    days: sortedDays,
    selfies
  });
}
