import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  applyPtGrace, pickScheduled, deductBreak, splitRegularOt, computeOtPay,
  type ScheduledShift, type PayrollSettings
} from "@/lib/payroll-compute";

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

type EntryRow = { id: number; ts: string; type: "in" | "out" };

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
  // True when the day is a public holiday (PT pay ×1.5 applies).
  holiday: boolean;
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
    SELECT period_start, period_end FROM payroll_periods WHERE id = ?
  `).get(periodId) as Period | undefined;
  if (!period) {
    return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  }

  // PT grace + scheduled-break only apply to part-timers — FT days keep
  // raw clocked minutes. Load type + rate so the per-day money columns
  // match what the pay engine stored.
  const emp = db.prepare(`
    SELECT employment_type, hourly_rate FROM users WHERE id = ?
  `).get(userId) as { employment_type: "pt" | "ft" | null; hourly_rate: number | null } | undefined;
  const isPt = emp?.employment_type === "pt";

  const settings = db.prepare(`
    SELECT ot_mode, ot_flat_per_15min,
           break_threshold_minutes, break_deduction_minutes,
           long_shift_threshold_minutes, long_shift_break_minutes,
           sso_rate, sso_cap, pt_default_hourly_rate, wht_rate
    FROM payroll_settings WHERE id = 1
  `).get() as PayrollSettings;
  const ptRate = emp?.hourly_rate ?? settings.pt_default_hourly_rate;

  // วันพิเศษ (pt_special=1) → PT premium 1.5× (same as the engine).
  // Public holidays (all rows) are info-only — they drive the "วันหยุด"
  // status row, NOT pay (owner 2026-06-03).
  const phRows = db.prepare(`
    SELECT date, pt_special FROM public_holidays WHERE date >= ? AND date <= ?
  `).all(period.period_start, period.period_end) as Array<{ date: string; pt_special: number }>;
  const holidaySet = new Set(phRows.filter((h) => h.pt_special === 1).map((h) => h.date));
  const publicHolidaySet = new Set(phRows.map((h) => h.date));

  // Scheduled work shifts in the period, keyed by BKK assignment date.
  // Same anchoring rule as the pay engine (lib/payroll-compute.ts).
  const addDayYmd = (ymd: string): string => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const rosterRows = db.prepare(`
    SELECT ra.assignment_date, sc.start_time, sc.end_time, sc.break_start, sc.break_end
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.user_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'work'
  `).all(userId, period.period_start, period.period_end) as Array<{
    assignment_date: string; start_time: string; end_time: string;
    break_start: string | null; break_end: string | null;
  }>;
  const scheduledByDate = new Map<string, ScheduledShift[]>();
  for (const r of rosterRows) {
    if (!r.start_time || !r.end_time || r.start_time === r.end_time) continue;
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

  // Per-day overrides (payroll_line_days) — admin corrections that win
  // over the time-clock for a given date.
  const overrideRows = db.prepare(`
    SELECT work_date, clock_in, clock_out
    FROM payroll_line_days WHERE period_id = ? AND user_id = ?
  `).all(periodId, userId) as Array<{
    work_date: string; clock_in: string | null; clock_out: string | null;
  }>;
  const overrideByDate = new Map<string, { clock_in: string | null; clock_out: string | null }>();
  for (const r of overrideRows) overrideByDate.set(r.work_date, { clock_in: r.clock_in, clock_out: r.clock_out });

  // Approved OT for this user → date → requested_until.
  const otApprovedRows = db.prepare(`
    SELECT work_date, requested_until FROM ot_requests
    WHERE user_id = ? AND status = 'approved' AND work_date >= ? AND work_date <= ?
  `).all(userId, period.period_start, period.period_end) as Array<{
    work_date: string; requested_until: string;
  }>;
  const approvedOtByDate = new Map<string, string>();
  for (const r of otApprovedRows) approvedOtByDate.set(r.work_date, r.requested_until);

  // Build a fully-populated pair from a raw in/out couple — replicating
  // the engine: grace clamp → scheduled break → regular/OT split →
  // approved OT → pay.
  // Whole-minute duration (seconds ignored) — matches the pay engine.
  const floorMin = (ts: string) => Math.floor(new Date(ts).getTime() / 60000);

  function buildPair(inTs: string, outTs: string | null, edited = false): DayPair {
    const date = bkkDate(inTs);
    const sched = pickScheduled(scheduledByDate.get(date) ?? [], { startTs: inTs });
    const rawMin = outTs ? Math.max(0, floorMin(outTs) - floorMin(inTs)) : 0;
    const holiday = isPt && holidaySet.has(date);

    // Approved OT extends the worked window past the scheduled end.
    let otUntilTs: string | null = null;
    if (isPt && sched) {
      const reqUntil = approvedOtByDate.get(date);
      if (reqUntil && /^\d{2}:\d{2}$/.test(reqUntil)) {
        otUntilTs = new Date(`${date}T${reqUntil}:00+07:00`).toISOString();
      }
    }

    let breakMinutes = 0;
    let workedMin = rawMin;       // after break, before OT split
    let lateMin = 0;
    let earlyMin = 0;
    if (outTs) {
      if (isPt && sched) {
        const g = applyPtGrace({ startTs: inTs, endTs: outTs }, sched, otUntilTs);
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
    // ≤8h total stays regular rate (even past the scheduled end via an
    // approved OT); only the excess beyond 8h is OT rate.
    const split = splitRegularOt(workedMin);
    const otMin = split.ot;

    const mult = holiday ? 1.5 : 1;
    const regularPay = isPt ? (split.regular / 60) * ptRate * mult : 0;
    const otPay = isPt ? computeOtPay(otMin, ptRate, settings, mult) : 0;

    return {
      date,
      workIn: bkkHHMM(inTs),
      workOut: outTs ? bkkHHMM(outTs) : null,
      durationMinutes: rawMin,
      schedIn: sched ? bkkHHMM(sched.startTs) : null,
      schedOut: sched ? bkkHHMM(sched.endTs) : null,
      breakMinutes,
      effectiveMinutes: split.regular,
      otMinutes: otMin,
      otPay: Math.round(otPay * 100) / 100,
      pay: Math.round((regularPay + otPay) * 100) / 100,
      edited,
      lateMin,
      earlyMin,
      holiday,
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
  const entries = db.prepare(`
    SELECT id, ts, type FROM time_entries
    WHERE user_id = ? AND ts >= ? AND ts <= ?
    ORDER BY ts ASC
  `).all(userId, fromIso, toIso) as EntryRow[];

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
  };
  const days = new Map<string, Day>();
  function ensureDay(date: string): Day {
    let d = days.get(date);
    if (!d) {
      d = { date, pairs: [], totalMinutes: 0, effectiveMinutes: 0,
            breakMinutes: 0, otMinutes: 0, otPay: 0, pay: 0, edited: false };
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
      if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null));
      openIn = e;
    } else {
      // type === "out"
      if (openIn) {
        if (!overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, e.ts));
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
          statusLabel: null
        });
      }
    }
  }
  // Trailing unmatched "in" (still on shift at period end / forgot
  // to clock out) — flush as orphan too (unless overridden).
  if (openIn && !overrideByDate.has(bkkDate(openIn.ts))) pushPair(buildPair(openIn.ts, null));

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
        lateMin: 0, earlyMin: 0, holiday: false, statusLabel: "ขาดงาน"
      });
    }
  }

  // Emit status rows for non-worked days that are leave / day-off /
  // public holiday — only when the day has no clock activity already.
  for (let d = period.period_start; d <= period.period_end; d = addDayYmd(d)) {
    if (days.has(d)) continue;
    const label = leaveByDate.get(d)
      ?? (dayOffSet.has(d) || publicHolidaySet.has(d) ? "วันหยุด" : null);
    if (!label) continue;
    const day = ensureDay(d);
    day.pairs.push({
      date: d, workIn: null, workOut: null, durationMinutes: 0,
      schedIn: null, schedOut: null, breakMinutes: 0,
      effectiveMinutes: 0, otMinutes: 0, otPay: 0, pay: 0, edited: false,
      lateMin: 0, earlyMin: 0, holiday: holidaySet.has(d), statusLabel: label
    });
  }

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return NextResponse.json({
    ok: true,
    is_pt: isPt,
    period_start: period.period_start,
    period_end: period.period_end,
    days: sortedDays
  });
}
