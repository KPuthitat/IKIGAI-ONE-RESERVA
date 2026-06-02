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

  // Public holidays in range → PT premium 1.5× (same as the engine).
  const holidays = db.prepare(`
    SELECT date FROM public_holidays WHERE date >= ? AND date <= ?
  `).all(period.period_start, period.period_end) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));

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

  // Build a fully-populated pair from a raw in/out couple — replicating
  // the engine: grace clamp → scheduled break → regular/OT split → pay.
  function buildPair(inTs: string, outTs: string | null): DayPair {
    const date = bkkDate(inTs);
    const sched = pickScheduled(scheduledByDate.get(date) ?? [], { startTs: inTs });
    const rawMin = outTs
      ? Math.max(0, Math.round((new Date(outTs).getTime() - new Date(inTs).getTime()) / 60000))
      : 0;

    let breakMinutes = 0;
    let workedMin = rawMin;       // after break, before OT split
    if (outTs) {
      if (isPt && sched) {
        const g = applyPtGrace({ startTs: inTs, endTs: outTs }, sched);
        breakMinutes = Math.round(g.breakMinutes);
        workedMin = Math.round(g.workedMinutes);
      } else {
        const db2 = deductBreak(rawMin, settings);
        breakMinutes = Math.round(db2.deducted);
        workedMin = Math.round(db2.workedMinutes);
      }
    }
    const split = splitRegularOt(workedMin);
    const mult = isPt && holidaySet.has(date) ? 1.5 : 1;
    const regularPay = isPt ? (split.regular / 60) * ptRate * mult : 0;
    const otPay = isPt ? computeOtPay(split.ot, ptRate, settings, mult) : 0;

    return {
      date,
      workIn: bkkHHMM(inTs),
      workOut: outTs ? bkkHHMM(outTs) : null,
      durationMinutes: rawMin,
      schedIn: sched ? bkkHHMM(sched.startTs) : null,
      schedOut: sched ? bkkHHMM(sched.endTs) : null,
      breakMinutes,
      effectiveMinutes: split.regular,
      otMinutes: split.ot,
      otPay: Math.round(otPay * 100) / 100,
      pay: Math.round((regularPay + otPay) * 100) / 100
    };
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
  };
  const days = new Map<string, Day>();
  function ensureDay(date: string): Day {
    let d = days.get(date);
    if (!d) {
      d = { date, pairs: [], totalMinutes: 0, effectiveMinutes: 0,
            breakMinutes: 0, otMinutes: 0, otPay: 0, pay: 0 };
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
  }

  let openIn: EntryRow | null = null;
  for (const e of entries) {
    if (e.type === "in") {
      // If we already had an unmatched "in", flush it as an orphan
      // before starting a new one — admin needs to see both.
      if (openIn) pushPair(buildPair(openIn.ts, null));
      openIn = e;
    } else {
      // type === "out"
      if (openIn) {
        pushPair(buildPair(openIn.ts, e.ts));
        openIn = null;
      } else {
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
          pay: 0
        });
      }
    }
  }
  // Trailing unmatched "in" (still on shift at period end / forgot
  // to clock out) — flush as orphan too.
  if (openIn) pushPair(buildPair(openIn.ts, null));

  const sortedDays = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return NextResponse.json({
    ok: true,
    is_pt: isPt,
    period_start: period.period_start,
    period_end: period.period_end,
    days: sortedDays
  });
}
