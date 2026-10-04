// Work on a weekly rest day — Thai labour law (owner 2026-10-04). A monthly (FT)
// employee asks first (ขอเพิ่มกะ), the admin approves + assigns the shift (e.g. FD-11
// 11:00–20:00 with a 1h lunch break); each regular hour then earns an EXTRA 1× hourly
// wage and approved OT beyond the shift pays 3× the COMPANY OT rate (100/h → 300/h). Part-timers' extra shifts, swaps and
// salaried execs get nothing extra. Run:  node --import tsx scripts/test-rest-day-pay.ts

import fs from "node:fs";
import path from "node:path";
import type { PayrollSettings, EmployeePayrollSnapshot, ScheduledShift } from "../src/lib/payroll-compute";

const TMP = path.join(process.cwd(), "data", "test-rest-day-pay.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

const SETTINGS: PayrollSettings = {
  ot_mode: "flat", ot_flat_per_15min: 25,   // company OT: 25 baht / 15 min = 100 / hour
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
const REST = "2026-09-07";
const iso = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+07:00`).toISOString();
// The approved extra shift (FD-11): 11:00–20:00 with the lunch break 12:00–13:00 = 8h.
const fd11: ScheduledShift = { startTs: iso(REST, "11:00"), endTs: iso(REST, "20:00"), breakStartTs: iso(REST, "12:00"), breakEndTs: iso(REST, "13:00") };
const scheduledByDate = new Map<string, ScheduledShift[]>([[REST, [fd11]]]);
const shiftOn = (d: string, from: string, to: string) => ({ startTs: iso(d, from), endTs: iso(d, to), durationMinutes: Math.round((Date.parse(iso(d, to)) - Date.parse(iso(d, from))) / 60000) });
const UNTIL_21 = new Map<string, string>([[REST, "21:00"]]);   // OT request approved until 21:00
const base = {
  unpaired: 0, leaveDays: 0, unpaidLeaveDays: 0, cycle: "monthly" as const,
  periodStart: P_START, periodEnd: P_END, settings: SETTINGS, holidaySet: new Set<string>(), scheduledByDate,
  restWorkDates: new Set<string>([REST])
};

(async () => {
  const { computeLineForEmployee, isRestDayWork, REST_DAY_RULE_FROM } = await import("../src/lib/payroll-compute");

  console.log("rule gate:");
  okv("rule starts 2026-09-01", REST_DAY_RULE_FROM === "2026-09-01");
  const g = { eligible: true, restDates: new Set([REST]), holiday: false, double: false };
  okv("an approved extra-shift date is rest-day work", isRestDayWork({ ...g, date: REST }) === true);
  okv("any other date is not", isRestDayWork({ ...g, date: "2026-09-08" }) === false);
  okv("no approved request → never", isRestDayWork({ ...g, date: REST, restDates: undefined }) === false);
  okv("วันพิเศษ / วันจ่ายสองเท่า keep their own premium", isRestDayWork({ ...g, date: REST, holiday: true }) === false && isRestDayWork({ ...g, date: REST, double: true }) === false);
  okv("not eligible (PT / exec) → never", isRestDayWork({ ...g, date: REST, eligible: false }) === false);
  okv("days before the rule date are untouched", isRestDayWork({ ...g, date: "2026-08-07", restDates: new Set(["2026-08-07"]) }) === false);

  console.log("\nowner's example — FT 12,000 (50/hr), FD-11 11:00–20:00 + OT until 21:00, clocked 10:48–21:00:");
  {
    const L = computeLineForEmployee({ ...base, employee: ft(12000), shifts: [shiftOn(REST, "10:48", "21:00")], approvedOtByDate: UNTIL_21 });
    eq("base stays the salary", L.base_pay, 12000);
    eq("regular hours = the shift's 8h (early arrival not counted)", L.regular_minutes, 480);
    eq("OT = exactly 1h (20:00 → 21:00)", L.ot_minutes, 60);
    eq("ค่าล่วงเวลา = extra 1× 8h×50 = 400 + OT 1h at 3 × the company 100/h = 300 → 700", L.ot_pay, 700);
  }

  console.log("\nthe same hours WITHOUT an approved extra-shift request (company OT rate applies):");
  {
    const L = computeLineForEmployee({ ...base, restWorkDates: new Set(), employee: ft(12000), shifts: [shiftOn(REST, "10:48", "21:00")], approvedOtByDate: UNTIL_21 });
    eq("OT 1h at the company rate (100/h) = 100, no premium", L.ot_pay, 100);
  }

  console.log("\nFT 30,000 (125/hr), 8h on the approved rest day, no OT:");
  {
    const L = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "11:00", "20:00")] });
    eq("extra 1× = 8h × 125 = 1,000", L.ot_pay, 1000);
  }

  console.log("\nOT on a rest day = 3× the company OT rule (2h OT):");
  {
    const until22 = new Map([[REST, "22:00"]]);
    const L = computeLineForEmployee({ ...base, employee: ft(30000), shifts: [shiftOn(REST, "11:00", "22:00")], approvedOtByDate: until22 });
    eq("OT minutes 120", L.ot_minutes, 120);
    eq("ค่าล่วงเวลา = 1,000 + 2h × 100 × 3 = 600 → 1,600 (company rate, not the salary's hourly)", L.ot_pay, 1600);
    const legal = computeLineForEmployee({ ...base, settings: { ...SETTINGS, ot_mode: "legal" }, employee: ft(30000), shifts: [shiftOn(REST, "11:00", "22:00")], approvedOtByDate: until22 });
    eq("legal OT mode: 1.5 × hourly × 3 × 2h = 1,125 → 2,125", legal.ot_pay, 1000 + 1125);
  }

  console.log("\nguards:");
  {
    const p = computeLineForEmployee({ ...base, employee: pt(50), shifts: [shiftOn(REST, "11:00", "20:00")] });
    eq("part-timer's extra shift is a normal shift: 8h × 50 = 400, nothing extra", p.base_pay + p.ot_pay, 400);
    const pOt = computeLineForEmployee({ ...base, employee: pt(50), shifts: [shiftOn(REST, "10:48", "21:00")], approvedOtByDate: UNTIL_21 });
    eq("part-timer's OT stays at the company rate (100)", pOt.ot_pay, 100);
    const exec = computeLineForEmployee({ ...base, employee: ft(30000, 0), shifts: [shiftOn(REST, "11:00", "20:00")] });
    eq("salaried exec (no time clock): nothing extra", exec.ot_pay, 0);
    const aug = computeLineForEmployee({ ...base, periodStart: "2026-08-01", periodEnd: "2026-08-31", employee: ft(30000), shifts: [shiftOn("2026-08-07", "11:00", "20:00")], scheduledByDate: new Map([["2026-08-07", [{ ...fd11, startTs: iso("2026-08-07", "11:00"), endTs: iso("2026-08-07", "20:00"), breakStartTs: iso("2026-08-07", "12:00"), breakEndTs: iso("2026-08-07", "13:00") }]]]), restWorkDates: new Set(["2026-08-07"]) });
    eq("a day before the rule date: nothing extra", aug.ot_pay, 0);
    const typed = computeLineForEmployee({
      ...base, employee: ft(12000), shifts: [shiftOn(REST, "10:48", "21:00")], approvedOtByDate: UNTIL_21,
      fieldOverridesByDate: new Map([[REST, { clock_in: null, clock_out: null, sched_in: null, sched_out: null, break_min: null, worked_min: null, ot_min: null, ot_pay: 100, ot_until: null, unpaid_absence: null } as never]])
    });
    eq("a typed ค่าล่วงเวลา still wins for the OT amount (extra 1× = 400 remains)", typed.ot_pay, 500);
  }

  // ── The per-day breakdown (modal + payslip) must agree with the engine ──
  console.log("\nbreakdown parity:");
  const { getDb } = await import("../src/lib/db");
  const { buildLineBreakdown } = await import("../src/lib/payroll-breakdown");
  const db = getDb();
  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('restday','NAMA')").run().lastInsertRowid);
  const mk = (u: string, et: string, col: string, val: number) => Number(db.prepare(
    `INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,${col}) VALUES (?,?,?,?,?,?,1,?)`
  ).run(u, "x", u, "staff", "active", et, val).lastInsertRowid);
  const ftU = mk("ft", "ft", "monthly_salary", 12000), ptU = mk("pt", "pt", "hourly_rate", 50);
  const sh = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,break_start,break_end) VALUES (?,?,?,?,?,?,?)").run(br, "FD-11", "FD-11", "11:00", "20:00", "12:00", "13:00").lastInsertRowid);
  let posN = 0;
  for (const u of [ftU, ptU]) {
    const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(br, `P${++posN}`).lastInsertRowid);
    db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(br, REST, pos, u, sh);
    for (const [t, d] of [["in", "10:48"], ["out", "21:00"]] as const) db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(u, t, iso(REST, d), br);
    db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,status) VALUES (?,?,?,?, 'approved')").run(u, br, REST, "21:00");
    // Both people have an approved extra-shift request — only the FT gets the premium.
    db.prepare("INSERT INTO shift_change_requests (user_id,branch_id,kind,work_date,status) VALUES (?,?, 'extra_shift', ?, 'approved')").run(u, br, REST);
  }
  const period = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly',?,?,'2026-10-05','draft',NULL,'ft','auto')"
  ).run(P_START, P_END).lastInsertRowid);
  const f = buildLineBreakdown(db, period, ftU)!, p = buildLineBreakdown(db, period, ptU)!;
  const fd = f.days.find((d) => d.date === REST)!, pd = p.days.find((d) => d.date === REST)!;
  okv("FT: the day is flagged rest-day work", fd.pairs[0].restDay === true);
  eq("FT: regular 8h, OT 1h", fd.effectiveMinutes + fd.otMinutes, 540);
  eq("FT: OT pay = 1h × 100 × 3 = 300", fd.otPay, 300);
  eq("FT: premium (extra 1×) = 400", fd.premiumPay, 400);
  eq("FT: day total = 400 + 300 = 700", fd.pay, 700);
  eq("FT: restDayPremium total = 400", f.restDayPremium, 400);
  okv("PT: not flagged (an extra shift is a normal shift)", pd.pairs[0].restDay === false);
  eq("PT: no rest-day premium", p.restDayPremium, 0);

  // Clock-in gate: only an APPROVED shift request opens the clock on a day with no roster shift.
  const { hasApprovedShiftRequestOn } = await import("../src/lib/shift-requests");
  const gateU = mk("gate", "ft", "monthly_salary", 12000);
  const d2 = "2026-09-20";
  okv("no request → clock stays closed", hasApprovedShiftRequestOn(gateU, d2) === false);
  db.prepare("INSERT INTO shift_change_requests (user_id,branch_id,kind,work_date,status) VALUES (?,?, 'extra_shift', ?, 'pending')").run(gateU, br, d2);
  okv("a PENDING request does not open the clock", hasApprovedShiftRequestOn(gateU, d2) === false);
  db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,status) VALUES (?,?,?,?, 'pending')").run(gateU, br, d2, "21:00");
  okv("an OT request alone does not open it either", hasApprovedShiftRequestOn(gateU, d2) === false);
  db.prepare("UPDATE shift_change_requests SET status='approved' WHERE user_id=? AND work_date=?").run(gateU, d2);
  okv("an APPROVED request opens the clock for that date only", hasApprovedShiftRequestOn(gateU, d2) === true && hasApprovedShiftRequestOn(gateU, "2026-09-21") === false);

  // Admin records the request ON BEHALF of an employee (a day worked without ever filing one).
  console.log("\nadmin records the extra shift on behalf:");
  const { recordExtraShiftOnBehalf } = await import("../src/lib/shift-requests");
  const adminU = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('adm','x','Adm','admin','active')").run().lastInsertRowid);
  const onb = mk("onb", "ft", "monthly_salary", 12000);
  db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(onb, br);
  const D14 = "2026-09-14";
  for (const [t, d] of [["in", "10:48"], ["out", "21:00"]] as const) db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(onb, t, iso(D14, d), br);
  db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,status) VALUES (?,?,?,?, 'approved')").run(onb, br, D14, "21:00");
  const posA = Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(br, "Onb").lastInsertRowid);
  const flagOf = () => buildLineBreakdown(db, period, onb)!.days.find((d) => d.date === D14)?.pairs[0]?.restDay;
  okv("before: no request → not rest-day work", flagOf() === false);
  const bad = recordExtraShiftOnBehalf({ branchId: br, adminId: adminU, userId: onb, workDate: D14, positionId: posA, shiftCodeId: 999999, note: "x y z" });
  okv("an invalid shift is refused", bad.ok === false && bad.error === "invalid_slot");
  const stranger = recordExtraShiftOnBehalf({ branchId: br, adminId: adminU, userId: 999999, workDate: D14, positionId: posA, shiftCodeId: sh, note: "x y z" });
  okv("a person outside the branch is refused", stranger.ok === false && stranger.error === "user_not_in_branch");
  const r = recordExtraShiftOnBehalf({ branchId: br, adminId: adminU, userId: onb, workDate: D14, positionId: posA, shiftCodeId: sh, note: "ทำงานวันหยุดตามที่ตกลง ไม่ได้ส่งคำขอ" });
  okv("recorded: approved request with a ref no", r.ok === true && /^SC202609-\d+$/.test(r.ok ? r.refNo : ""));
  okv("the shift is on the roster", (db.prepare("SELECT COUNT(*) n FROM roster_assignments WHERE user_id=? AND assignment_date=? AND shift_code_id=?").get(onb, D14, sh) as { n: number }).n === 1);
  okv("after: the day is rest-day work", flagOf() === true);
  const again = recordExtraShiftOnBehalf({ branchId: br, adminId: adminU, userId: onb, workDate: D14, positionId: posA, shiftCodeId: sh, note: "x y z" });
  okv("recording it twice is refused", again.ok === false && again.error === "already_approved");
  const other = mk("onb2", "ft", "monthly_salary", 12000);
  db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(other, br);
  const taken = recordExtraShiftOnBehalf({ branchId: br, adminId: adminU, userId: other, workDate: D14, positionId: posA, shiftCodeId: sh, note: "x y z" });
  okv("a position already filled that day is refused", taken.ok === false && taken.error === "slot_taken");

  console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
