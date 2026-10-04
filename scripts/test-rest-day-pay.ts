// Work on a weekly rest day — Thai labour law (owner 2026-10-04): monthly staff get
// an EXTRA 1× hourly wage per regular hour, hourly staff 2× in total, approved OT on
// that day 3×. Run:  node --import tsx scripts/test-rest-day-pay.ts

import fs from "node:fs";
import path from "node:path";
import type { PayrollSettings, EmployeePayrollSnapshot, ScheduledShift } from "../src/lib/payroll-compute";

const TMP = path.join(process.cwd(), "data", "test-rest-day-pay.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

const SETTINGS: PayrollSettings = {
  ot_mode: "flat", ot_flat_per_15min: 25,
  break_threshold_minutes: 360, break_deduction_minutes: 60,
  long_shift_threshold_minutes: 600, long_shift_break_minutes: 60,
  sso_rate: 0.05, sso_cap: 750, pt_default_hourly_rate: 50, wht_rate: 0.03
};
const ft = (salary: number, track = 1): EmployeePayrollSnapshot => ({
  user_id: 1, display_name: "FT", employment_type: "ft", employee_code: "FT01",
  hourly_rate: null, monthly_salary: salary, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: track, is_primary_branch: 1, is_home_company: 1, hire_date: null, last_working_day: null, ft_started_at: null
});
const pt = (rate: number): EmployeePayrollSnapshot => ({
  user_id: 2, display_name: "PT", employment_type: "pt", employee_code: "PT01",
  hourly_rate: rate, monthly_salary: null, pay_cycle: "monthly", salary_tax_mode: "sso",
  track_attendance: 1, is_primary_branch: 1, is_home_company: 1, hire_date: null, last_working_day: null, ft_started_at: null
});

let pass = 0, fail = 0;
const eq = (n: string, got: number, want: number) => { if (Math.abs(got - want) < 0.01) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}: got ${got}, want ${want}`); } };
const okv = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

const P_START = "2026-09-01", P_END = "2026-09-30";
const REST = "2026-09-07", WORKDAY = "2026-09-08";
const iso = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+07:00`).toISOString();
// 09-08 has a rostered work shift; 09-07 does not (their weekly rest day).
const rosterShift: ScheduledShift = { startTs: iso(WORKDAY, "11:00"), endTs: iso(WORKDAY, "20:00"), breakStartTs: iso(WORKDAY, "12:00"), breakEndTs: iso(WORKDAY, "13:00") };
const scheduledByDate = new Map<string, ScheduledShift[]>([[WORKDAY, [rosterShift]]]);
const workDates = new Set<string>([WORKDAY]);
// 10:00–19:00 with the 60-min break = 8h regular (480 min).
const shiftOn = (d: string, from: string, to: string) => ({ startTs: iso(d, from), endTs: iso(d, to), durationMinutes: Math.round((Date.parse(iso(d, to)) - Date.parse(iso(d, from))) / 60000) });
const APPROVED_19 = new Map<string, string>([[REST, "19:00"]]);   // OT request approved until 19:00 for the rest day
const base = {
  unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0, cycle: "monthly" as const,
  periodStart: P_START, periodEnd: P_END, settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate, rosterWorkDates: workDates
};

(async () => {
const { computeLineForEmployee, isRestDayWork, REST_DAY_RULE_FROM } = await import("../src/lib/payroll-compute");
console.log("rule gate:");
okv("rule starts 2026-09-01", REST_DAY_RULE_FROM === "2026-09-01");
const g = { eligible: true, workDates, holiday: false, double: false, approved: true };
okv("a day with no work shift (roster in use) is a rest day", isRestDayWork({ ...g, date: REST }) === true);
okv("a rostered work day is not", isRestDayWork({ ...g, date: WORKDAY }) === false);
okv("roster not in use at all → never a rest day", isRestDayWork({ ...g, date: REST, workDates: new Set() }) === false && isRestDayWork({ ...g, date: REST, workDates: undefined }) === false);
okv("วันพิเศษ / วันจ่ายสองเท่า keep their own premium", isRestDayWork({ ...g, date: REST, holiday: true }) === false && isRestDayWork({ ...g, date: REST, double: true }) === false);
okv("ineligible (exec / no clock) never", isRestDayWork({ ...g, date: REST, eligible: false }) === false);
okv("days before the rule date are untouched", isRestDayWork({ ...g, date: "2026-08-07" }) === false);
okv("no approved OT request / admin-set day → no premium", isRestDayWork({ ...g, date: REST, approved: false }) === false);

console.log("\nFT monthly 30,000 (125/hr) works 8h on the rest day:");
{
  const L = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "19:00")], approvedOtByDate: APPROVED_19 });
  eq("base stays the salary", L.base_pay, 30000);
  eq("regular minutes 480", L.regular_minutes, 480);
  eq("extra 1× → ค่าล่วงเวลา = 8h × 125 = 1,000", L.ot_pay, 1000);
  // Same hours on a normal rostered day add nothing.
  const N = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(WORKDAY, "11:00", "20:00")] });
  eq("normal rostered day: no extra", N.ot_pay, 0);
}

console.log("\nFT monthly: 10h on the rest day, OT approved until 21:00 (2h OT):");
{
  const L = computeLineForEmployee({
    ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "21:00")],
    approvedOtByDate: new Map([[REST, "21:00"]])
  });
  eq("OT minutes 120 (10h−1h break = 10h → 8 regular + 2 OT)", L.ot_minutes, 120);
  eq("ค่าล่วงเวลา = 8×125 (extra 1×) + 2h × 125 × 3 = 1,750", L.ot_pay, 1000 + 750);
}

console.log("\nPT 50/hr works 8h on the rest day:");
{
  const L = computeLineForEmployee({ ...base, employee: pt(50), shifts: [shiftOn(REST, "10:00", "19:00")], approvedOtByDate: APPROVED_19 });
  eq("base 1× = 8h × 50 = 400", L.base_pay, 400);
  eq("2nd 1× booked as ค่าล่วงเวลา = 400 (total 2× = 800)", L.ot_pay, 400);
  eq("total earned 800", L.base_pay + L.ot_pay, 800);
  const N = computeLineForEmployee({ ...base, employee: pt(50), shifts: [shiftOn(WORKDAY, "11:00", "20:00")] });
  eq("normal rostered day stays 1× = 400", N.base_pay + N.ot_pay, 400);
}

console.log("\nPT: 2h OT on the rest day pays 3× (not the flat rate):");
{
  const L = computeLineForEmployee({
    ...base, employee: pt(50), shifts: [shiftOn(REST, "10:00", "21:00")],
    approvedOtByDate: new Map([[REST, "21:00"]])
  });
  eq("base 8h × 50 = 400", L.base_pay, 400);
  eq("ค่าล่วงเวลา = extra 1× 400 + 2h × 50 × 3 = 300", L.ot_pay, 400 + 300);
}

console.log("\nGuards:");
{
  const exec = computeLineForEmployee({ ...base, employee: ft(30000, 0), shifts: [shiftOn(REST, "10:00", "19:00")], approvedOtByDate: APPROVED_19 });
  eq("salaried exec (no time clock): nothing extra", exec.ot_pay, 0);
  const noRoster = computeLineForEmployee({ ...base, scheduledByDate: undefined, rosterWorkDates: undefined, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "19:00")], approvedOtByDate: APPROVED_19 });
  eq("no roster in use: nothing extra", noRoster.ot_pay, 0);
  const aug = computeLineForEmployee({ ...base, periodStart: "2026-08-01", periodEnd: "2026-08-31", employee: ft(30000), shifts: [shiftOn("2026-08-07", "10:00", "19:00")], rosterWorkDates: new Set(["2026-08-08"]), approvedOtByDate: new Map([["2026-08-07", "19:00"]]) });
  eq("a period before the rule date: nothing extra", aug.ot_pay, 0);
  // A person rostered at ANOTHER branch that day (work date present via the all-branch set).
  const other = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "19:00")], rosterWorkDates: new Set([WORKDAY, REST]), approvedOtByDate: APPROVED_19 });
  eq("helper rostered at another branch that day: not a rest day", other.ot_pay, 0);
  // Not approved: a stray punch on an unrostered day earns no premium (legacy 1× only).
  const unapproved = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "19:00")] });
  eq("no approved OT request: no rest-day premium", unapproved.ot_pay, 0);
  const unapprovedPt = computeLineForEmployee({ ...base, employee: pt(50), shifts: [shiftOn(REST, "10:00", "19:00")] });
  eq("PT without approval: plain 1× = 400", unapprovedPt.base_pay + unapprovedPt.ot_pay, 400);
  // An admin-set day counts as approval.
  const admin = computeLineForEmployee({
    ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "19:00")],
    fieldOverridesByDate: new Map([[REST, { clock_in: "10:00", clock_out: "19:00", sched_in: null, sched_out: null, break_min: null, worked_min: null, ot_min: null, ot_pay: null, ot_until: null, unpaid_absence: null } as never]])
  });
  eq("an admin-set day counts as approval → 1,000", admin.ot_pay, 1000);
  // The approved "until" time caps the window: punched 10:00–23:00, approved until 19:00.
  const capped = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "23:00")], approvedOtByDate: APPROVED_19 });
  eq("approved until 19:00, punched until 23:00 → only 8h counted", capped.regular_minutes + capped.ot_minutes, 480);
  eq("…and no 3× OT beyond the approved time (extra 1× only = 1,000)", capped.ot_pay, 1000);
  const typed = computeLineForEmployee({
    ...base, employee: ft(30000), shifts: [shiftOn(REST, "10:00", "21:00")],
    approvedOtByDate: new Map([[REST, "21:00"]]),
    fieldOverridesByDate: new Map([[REST, { clock_in: null, clock_out: null, sched_in: null, sched_out: null, break_min: null, worked_min: null, ot_min: null, ot_pay: 500, ot_until: null, unpaid_absence: null } as never]])
  });
  eq("a typed ค่าล่วงเวลา override still wins for OT (extra 1× remains)", typed.ot_pay, 1000 + 500);
}

// ── The per-day breakdown (modal + payslip) must agree with the engine ──
{
  console.log("\nbreakdown parity:");
  const { getDb } = await import("../src/lib/db");
  const { buildLineBreakdown } = await import("../src/lib/payroll-breakdown");
  const db = getDb();
  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('restday','NAMA')").run().lastInsertRowid);
  const mk = (u: string, et: string, extraCol: string, extraVal: number) => Number(db.prepare(
    `INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,${extraCol}) VALUES (?,?,?,?,?,?,1,?)`
  ).run(u, "x", u, "staff", "active", et, extraVal).lastInsertRowid);
  const ftU = mk("ft", "ft", "monthly_salary", 30000), ptU = mk("pt", "pt", "hourly_rate", 50);
  const sh = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,break_start,break_end) VALUES (?,?,?,?,?,?,?)").run(br, "D", "D", "11:00", "20:00", "12:00", "13:00").lastInsertRowid);
  let posN = 0;
  for (const u of [ftU, ptU]) {
    const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(br, `P${++posN}`).lastInsertRowid);
    db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(br, WORKDAY, pos, u, sh);
    for (const [t, d] of [["in", "10:00"], ["out", "19:00"]] as const) db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(u, t, iso(REST, d), br);
  }
  const period = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly',?,?,'2026-10-05','draft',NULL,'ft','auto')"
  ).run(P_START, P_END).lastInsertRowid);
  for (const u of [ftU, ptU]) db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,status) VALUES (?,?,?,?, 'approved')").run(u, br, REST, "19:00");
  const f = buildLineBreakdown(db, period, ftU)!, p = buildLineBreakdown(db, period, ptU)!;
  const fd = f.days.find((d) => d.date === REST)!, pd = p.days.find((d) => d.date === REST)!;
  okv("FT: rest-day row flagged", fd.pairs[0].restDay === true && fd.pairs[0].statusLabel === null);
  eq("FT: day pay = extra 1× = 1,000", fd.pay, 1000);
  eq("FT: premium (extra 1×) = 1,000", fd.premiumPay, 1000);
  okv("PT: rest-day row flagged", pd.pairs[0].restDay === true);
  eq("PT: day pay = 2× = 800", pd.pay, 800);
  eq("PT: premium (extra 1×) = 400", pd.premiumPay, 400);
  eq("FT: breakdown restDayPremium total = 1,000", f.restDayPremium, 1000);
  eq("PT: breakdown restDayPremium total = 400", p.restDayPremium, 400);
  okv("the rostered work day is not flagged", !(f.days.find((d) => d.date === WORKDAY)?.pairs.some((x) => x.restDay)));

  console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
}
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
