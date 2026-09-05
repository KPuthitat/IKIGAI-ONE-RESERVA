// Per-day breakdown of a single staff's pay-period line (owner 2026-09-05,
// extracted from the admin breakdown route so the payslip and the admin modal
// share ONE source of truth — a dispute document must match the modal exactly).
//
// Reads the raw time_entries inside [period_start, period_end], pairs them up
// (in → out), replays the pay engine per day (grace clamp → scheduled break →
// regular/OT split → approved OT → pay), and lays admin per-day overrides on
// top. Non-worked days become status rows (ลา / วันหยุด / ขาดงาน). FT ประจำ days
// carry a DELTA (double-pay premium + OT) from the monthly salary, not a full
// per-day amount, so the table ties out to payroll_lines.

import type Database from "better-sqlite3";
import {
  applyPtGrace, pickScheduled, deductBreak, splitRegularOt, computeOtPay,
  overlaySwapShifts, branchHourlyRateSelect, keepEntryForBranch, loadDayBranchMap,
  holidayPremiumApplies,
  type ScheduledShift, type PayrollSettings
} from "@/lib/payroll-compute";
import { resolveSiblingPeriods } from "@/lib/payroll-cycle";

type EntryRow = { id: number; ts: string; type: "in" | "out"; selfie_path: string | null; branch_id: number | null };

export type DayPair = {
  date: string;
  workIn: string | null;
  workOut: string | null;
  durationMinutes: number;
  schedIn: string | null;
  schedOut: string | null;
  breakMinutes: number;
  effectiveMinutes: number;
  otMinutes: number;
  otPay: number;
  // Premium baht earned on a ×2 / ×1.5 day = worked-hours × rate × (mult−1).
  // Uniform for PT and FT (for a salaried FT this equals the double-pay bonus
  // that rides in other_additions). 0 on a normal day.
  premiumPay: number;
  pay: number;
  edited: boolean;
  lateMin: number;
  earlyMin: number;
  holiday: boolean;
  double: boolean;
  publicHoliday: boolean;
  holidayChoice: "defer" | "use" | null;
  branch: string | null;
  branch_id: number | null;
  statusLabel: string | null;
};

type FieldOv = {
  clock_in: string | null; clock_out: string | null;
  sched_in: string | null; sched_out: string | null;
  break_min: number | null; worked_min: number | null;
  ot_min: number | null; ot_pay: number | null; ot_until: string | null;
  unpaid_absence: number | null;
};

type ShiftTag = { code: string; name: string | null; color: string | null };

export type BreakdownDay = {
  date: string;
  pairs: DayPair[];
  totalMinutes: number;
  effectiveMinutes: number;
  breakMinutes: number;
  otMinutes: number;
  otPay: number;
  premiumPay: number;         // ×2 / ×1.5 premium baht for the day
  absenceDeduction: number;   // ฿ deducted for a confirmed unpaid absence (FT salary/30), else 0
  pay: number;
  edited: boolean;
  override: FieldOv | null;
  otUntil: string | null;
  otApprovedUntil: string | null;
  shift: ShiftTag | null;
};

export type LineBreakdown = {
  is_pt: boolean;
  period_start: string;
  period_end: string;
  period_branch_id: number | null;
  branch_options: Array<{ id: number; name: string; status: string }>;
  ftMonthly: boolean;
  salaryBase: number;
  doublePremium: number;
  actualBase: number;
  actualOt: number;
  actualTotal: number;
  days: BreakdownDay[];
  selfies: Array<{ entryId: number; date: string; time: string; type: "in" | "out" }>;
};

// Asia/Bangkok ISO date (YYYY-MM-DD) for a given UTC ISO timestamp.
function bkkDate(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(0, 10);
}
function bkkHHMM(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().slice(11, 16);
}

/**
 * Build the per-day breakdown for (periodId, userId). Returns null when the
 * period doesn't exist. Pure read — never writes. Shared by the admin modal
 * route and the payslip's per-day log.
 */
export function buildLineBreakdown(
  db: Database.Database, periodId: number, userId: number
): LineBreakdown | null {
  const period = db.prepare(`
    SELECT period_start, period_end, branch_id FROM payroll_periods WHERE id = ?
  `).get(periodId) as { period_start: string; period_end: string; branch_id: number | null } | undefined;
  if (!period) return null;

  const siblings = period.branch_id != null ? resolveSiblingPeriods(db, periodId) : [];
  const branchOptions = siblings
    .filter((s) => s.branch_name != null)
    .map((s) => ({ id: s.branch_id, name: s.branch_name as string, status: s.status }));

  const emp = db.prepare(`
    SELECT employment_type, ${branchHourlyRateSelect(period.branch_id)}, monthly_salary, track_attendance FROM users WHERE id = ?
  `).get(userId) as { employment_type: "pt" | "ft" | null; hourly_rate: number | null; monthly_salary: number | null; track_attendance: number | null } | undefined;
  const isPt = emp?.employment_type === "pt";
  const isExec = emp?.employment_type === "ft" && emp?.track_attendance === 0;

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;
  const ptRate = emp?.hourly_rate ?? settings.pt_default_hourly_rate;
  const ftHourlyEquiv = emp?.monthly_salary ? emp.monthly_salary / 30 / 8 : 0;
  const rateForPay = isPt ? ptRate : ftHourlyEquiv;
  const round2 = (x: number) => Math.round(x * 100) / 100;
  const ftMonthly = emp?.employment_type === "ft" && !!emp?.monthly_salary;
  const lineRow = db.prepare(
    `SELECT base_pay, ot_pay FROM payroll_lines WHERE period_id = ? AND user_id = ?`
  ).get(periodId, userId) as { base_pay: number; ot_pay: number } | undefined;
  const actualBase = lineRow?.base_pay ?? 0;
  const actualOt = lineRow?.ot_pay ?? 0;
  const branchNameById = new Map<number, string>(
    (db.prepare("SELECT id, name FROM branches").all() as Array<{ id: number; name: string }>).map((b) => [b.id, b.name])
  );
  const dayBranchByDate = new Map<string, number>(
    (db.prepare(
      "SELECT work_date, branch_id FROM payroll_day_branch WHERE user_id = ? AND work_date >= ? AND work_date <= ?"
    ).all(userId, period.period_start, period.period_end) as Array<{ work_date: string; branch_id: number }>)
      .map((r) => [r.work_date, r.branch_id])
  );
  const effBranchId = (date: string, punchBranch: number | null): number | null =>
    dayBranchByDate.get(date) ?? punchBranch;

  const phRows = db.prepare(`
    SELECT date, pt_special, double_pay FROM public_holidays WHERE date >= ? AND date <= ?
  `).all(period.period_start, period.period_end) as Array<{ date: string; pt_special: number; double_pay: number }>;
  // Per-branch premium scope (owner 2026-09-05) — mirror the pay engine.
  const premiumScope = new Map<string, number[]>();
  for (const r of db.prepare(
    "SELECT date, branch_id FROM holiday_branch_scope WHERE date >= ? AND date <= ?"
  ).all(period.period_start, period.period_end) as Array<{ date: string; branch_id: number }>) {
    (premiumScope.get(r.date) ?? premiumScope.set(r.date, []).get(r.date)!).push(r.branch_id);
  }
  const premiumApplies = (date: string) => holidayPremiumApplies(premiumScope.get(date), period.branch_id);
  const holidaySet = new Set(phRows.filter((h) => h.pt_special === 1 && premiumApplies(h.date)).map((h) => h.date));
  const publicHolidaySet = new Set(phRows.map((h) => h.date));
  const doubleSet = new Set(phRows.filter((h) => h.double_pay === 1 && premiumApplies(h.date)).map((h) => h.date));
  const holidayChoiceByDate = new Map<string, "defer" | "use">();
  for (const r of db.prepare(
    `SELECT work_date, choice FROM holiday_work_choices
     WHERE user_id = ? AND work_date >= ? AND work_date <= ?`
  ).all(userId, period.period_start, period.period_end) as Array<{ work_date: string; choice: "defer" | "use" }>) {
    holidayChoiceByDate.set(r.work_date, r.choice);
    if (r.choice === "use") doubleSet.add(r.work_date);
  }

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
  overlaySwapShifts(db, userId, period.period_start, period.period_end, scheduledByDate);

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

  const floorMin = (ts: string) => Math.floor(new Date(ts).getTime() / 60000);

  function buildPair(inTs: string, outTs: string | null, edited = false, branchId: number | null = null): DayPair {
    const date = bkkDate(inTs);
    const ov = fieldOvByDate.get(date);
    const rawMin = outTs ? Math.max(0, floorMin(outTs) - floorMin(inTs)) : 0;
    const holiday = isPt && holidaySet.has(date);
    const isDoubleDay = doubleSet.has(date);

    let sched = pickScheduled(scheduledByDate.get(date) ?? [], { startTs: inTs });
    if (ov?.sched_in && ov?.sched_out) {
      const sStart = new Date(`${date}T${ov.sched_in}:00+07:00`).toISOString();
      const sEndDate = ov.sched_out < ov.sched_in ? addDayYmd(date) : date;
      const sEnd = new Date(`${sEndDate}T${ov.sched_out}:00+07:00`).toISOString();
      sched = { startTs: sStart, endTs: sEnd, breakStartTs: sched?.breakStartTs ?? null, breakEndTs: sched?.breakEndTs ?? null };
    }

    const reqUntil = isExec ? null : (ov?.ot_until ?? approvedOtByDate.get(date) ?? null);
    const reqFrom = isExec ? null : (approvedEarlyByDate.get(date) ?? null);
    const lateApproved = !!(reqUntil && /^\d{2}:\d{2}$/.test(reqUntil));
    const earlyApproved = !!(reqFrom && /^\d{2}:\d{2}$/.test(reqFrom));
    const otApproved = lateApproved || earlyApproved;
    let otUntilTs: string | null = null;
    let otFromTs: string | null = null;
    if (sched && outTs && lateApproved) {
      otUntilTs = new Date(`${date}T${reqUntil}:00+07:00`).toISOString();
    }
    if (sched && outTs && earlyApproved) {
      otFromTs = new Date(`${date}T${reqFrom}:00+07:00`).toISOString();
    }

    let breakMinutes = 0;
    let workedMin = rawMin;
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
    const grossForBreak = outTs && sched ? workedMin + breakMinutes : rawMin;
    if (ov?.break_min != null) {
      breakMinutes = ov.break_min;
      workedMin = Math.max(0, grossForBreak - ov.break_min);
    }

    const split = splitRegularOt(workedMin);
    const autoOt = otApproved ? split.ot : 0;
    const regMin = ov?.worked_min != null ? ov.worked_min : split.regular + (split.ot - autoOt);
    const otMin = ov?.ot_min != null ? ov.ot_min : autoOt;

    const mult = isDoubleDay ? 2 : holiday ? 1.5 : 1;
    const regularPay = (regMin / 60) * rateForPay * mult;
    // Premium = the portion above the normal 1× rate (the extra from ×2/×1.5).
    const premiumPay = (regMin / 60) * rateForPay * (mult - 1);
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
      premiumPay: Math.round(premiumPay * 100) / 100,
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

  function buildOverridePair(date: string, clockIn: string, clockOut: string): DayPair {
    const inTs = new Date(`${date}T${clockIn}:00+07:00`).toISOString();
    const endDate = clockOut < clockIn ? addDayYmd(date) : date;
    const outTs = new Date(`${endDate}T${clockOut}:00+07:00`).toISOString();
    return buildPair(inTs, outTs, true);
  }

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

  const fromIso = `${period.period_start}T00:00:00`;
  const toIso = `${period.period_end}T23:59:59`;
  const rawEntries = db.prepare(`
    SELECT id, ts, type, selfie_path, branch_id FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(userId, fromIso, toIso) as EntryRow[];
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
  const keptIds = new Set(entries.map((e) => e.id));
  const workedElsewhereDates = new Set(
    rawEntries.filter((e) => e.type === "in" && !keptIds.has(e.id)).map((e) => bkkDate(e.ts))
  );

  const days = new Map<string, BreakdownDay>();
  function ensureDay(date: string): BreakdownDay {
    let d = days.get(date);
    if (!d) {
      const approved = approvedOtByDate.get(date) ?? null;
      d = { date, pairs: [], totalMinutes: 0, effectiveMinutes: 0,
            breakMinutes: 0, otMinutes: 0, otPay: 0, premiumPay: 0, absenceDeduction: 0, pay: 0, edited: false,
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
    day.premiumPay += p.premiumPay;
    day.pay += p.pay;
    if (p.edited) day.edited = true;
  }

  let openIn: EntryRow | null = null;
  for (const e of entries) {
    if (e.type === "in") {
      if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null, false, openIn.branch_id));
      openIn = e;
    } else {
      if (openIn) {
        if (!overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, e.ts, false, openIn.branch_id));
        openIn = null;
      } else if (!overrideByDate.has(bkkDate(e.ts))) {
        const day = ensureDay(bkkDate(e.ts));
        day.pairs.push({
          date: bkkDate(e.ts), workIn: null, workOut: bkkHHMM(e.ts), durationMinutes: 0,
          schedIn: null, schedOut: null, breakMinutes: 0, effectiveMinutes: 0,
          otMinutes: 0, otPay: 0, premiumPay: 0, pay: 0, edited: false, lateMin: 0, earlyMin: 0,
          holiday: false, double: false, publicHoliday: publicHolidaySet.has(bkkDate(e.ts)),
          holidayChoice: holidayChoiceByDate.get(bkkDate(e.ts)) ?? null,
          branch: effBranchId(bkkDate(e.ts), e.branch_id) != null ? (branchNameById.get(effBranchId(bkkDate(e.ts), e.branch_id)!) ?? null) : null,
          branch_id: effBranchId(bkkDate(e.ts), e.branch_id), statusLabel: null
        });
      }
    }
  }
  if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null, false, openIn.branch_id));

  for (const [date, o] of overrideByDate) {
    const day = ensureDay(date);
    day.edited = true;
    if (o.clock_in && o.clock_out) {
      pushPair(buildOverridePair(date, o.clock_in, o.clock_out));
    } else {
      day.pairs.push({
        date, workIn: null, workOut: null, durationMinutes: 0,
        schedIn: null, schedOut: null, breakMinutes: 0,
        effectiveMinutes: 0, otMinutes: 0, otPay: 0, premiumPay: 0, pay: 0, edited: true,
        lateMin: 0, earlyMin: 0, holiday: false, double: false,
        publicHoliday: publicHolidaySet.has(date), holidayChoice: holidayChoiceByDate.get(date) ?? null,
        branch: null, branch_id: null, statusLabel: "ขาดงาน"
      });
    }
  }

  for (let d = period.period_start; d <= period.period_end; d = addDayYmd(d)) {
    if (days.has(d)) continue;
    if (workedElsewhereDates.has(d)) continue;
    const label = leaveByDate.get(d)
      ?? ((dayOffSet.has(d) || publicHolidaySet.has(d) || !shiftByDate.has(d)) ? "วันหยุด" : "ขาดงาน");
    const day = ensureDay(d);
    day.pairs.push({
      date: d, workIn: null, workOut: null, durationMinutes: 0,
      schedIn: null, schedOut: null, breakMinutes: 0,
      effectiveMinutes: 0, otMinutes: 0, otPay: 0, premiumPay: 0, pay: 0, edited: false,
      lateMin: 0, earlyMin: 0, holiday: holidaySet.has(d), double: false,
      publicHoliday: publicHolidaySet.has(d), holidayChoice: holidayChoiceByDate.get(d) ?? null,
      branch: null, branch_id: null, statusLabel: label
    });
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

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

  // Per-day unpaid-absence deduction (owner 2026-09-05): a salaried FT loses
  // salary/30 for each day the admin CONFIRMED as ขาดงานไม่ลา (payroll_line_days
  // .unpaid_absence). Mirrors the engine's confirmedAbsence deduction. PT has no
  // deduction — an absent PT day is simply unpaid (0), so this stays 0.
  if (ftMonthly && emp?.monthly_salary) {
    const perDay = round2(emp.monthly_salary / 30);
    for (const day of sortedDays) {
      if (fieldOvByDate.get(day.date)?.unpaid_absence) day.absenceDeduction = perDay;
    }
  }

  const selfies = entries
    .filter((e) => e.selfie_path)
    .map((e) => ({ entryId: e.id, date: bkkDate(e.ts), time: bkkHHMM(e.ts), type: e.type }));

  return {
    is_pt: isPt,
    period_start: period.period_start,
    period_end: period.period_end,
    period_branch_id: period.branch_id,
    branch_options: branchOptions,
    ftMonthly,
    salaryBase: round2(actualBase - doublePremiumTotal),
    doublePremium: round2(doublePremiumTotal),
    actualBase,
    actualOt,
    actualTotal: round2(actualBase + actualOt),
    days: sortedDays,
    selfies
  };
}
