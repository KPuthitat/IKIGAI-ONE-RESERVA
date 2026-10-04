// Payroll per-day breakdown for staff who do NOT clock in (ไม่ต้องลงเวลา,
// owner 2026-10-04): the roster is the record of the days worked, so rostered
// days show the scheduled shift (not ขาดงาน). Run:
//   node --import tsx scripts/test-payroll-breakdown-noclock.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-payroll-breakdown-noclock.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { buildLineBreakdown, ROSTER_LABEL } = await import("../src/lib/payroll-breakdown");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('c','AT HOME')").run().lastInsertRowid);
  const mkPos = (t: string) => Number(db.prepare("INSERT INTO roster_positions (branch_id, title) VALUES (?, ?)").run(B, t).lastInsertRowid);
  const mkUser = (u: string, et: "pt" | "ft", track: 0 | 1, extra: string) =>
    Number(db.prepare(`INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,${extra.split("=")[0]}) VALUES (?,?,?,?,?,?,?,?)`)
      .run(u, "x", u, "staff", "active", et, track, Number(extra.split("=")[1])).lastInsertRowid);
  const execFt = mkUser("exec", "ft", 0, "monthly_salary=30000");
  const noClockPt = mkUser("ptnc", "pt", 0, "hourly_rate=100");
  const clockedFt = mkUser("clocked", "ft", 1, "monthly_salary=30000");

  const sh = Number(db.prepare("INSERT INTO shift_codes (branch_id, code, name, start_time, end_time) VALUES (?,?,?,?,?)").run(B, "CN", "CN", "17:00", "21:00").lastInsertRowid);
  const off = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind) VALUES (?,?,?,?,?,'day_off')").run(B, "OFF", "OFF", "00:00", "00:00").lastInsertRowid);
  const posOf = new Map<number, number>();
  const roster = (uid: number, date: string, shift: number) => {
    if (!posOf.has(uid)) posOf.set(uid, mkPos(`P${uid}`));   // one position per person (UNIQUE branch/date/position)
    db.prepare("INSERT INTO roster_assignments (branch_id, assignment_date, position_id, user_id, shift_code_id) VALUES (?,?,?,?,?)").run(B, date, posOf.get(uid), uid, shift);
  };
  for (const uid of [execFt, noClockPt, clockedFt]) {
    roster(uid, "2026-09-01", sh); roster(uid, "2026-09-02", sh); roster(uid, "2026-09-03", off);
  }
  const period = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-09-01','2026-09-04','2026-10-05','draft',NULL,'ft','auto')"
  ).run().lastInsertRowid);

  const day = (bd: ReturnType<typeof buildLineBreakdown>, date: string) => bd!.days.find((d) => d.date === date)!;

  // Salaried exec who never punches.
  const e = buildLineBreakdown(db, period, execFt)!;
  ok("exec: rostered day shows the shift, not ขาดงาน", day(e, "2026-09-01").pairs[0].statusLabel === ROSTER_LABEL);
  ok("exec: scheduled window 17:00–21:00 is shown", day(e, "2026-09-01").pairs[0].schedIn === "17:00" && day(e, "2026-09-01").pairs[0].schedOut === "21:00");
  ok("exec: shift tag attached to the day", day(e, "2026-09-01").shift?.code === "CN");
  ok("exec: scheduled hours counted (4h minus break rules = 240 or less, > 0)", day(e, "2026-09-01").effectiveMinutes > 0 && day(e, "2026-09-01").effectiveMinutes <= 240);
  ok("exec: no OT, no per-day pay on top of the salary", day(e, "2026-09-01").otMinutes === 0 && day(e, "2026-09-01").pay === 0);
  ok("exec: day off stays วันหยุด", day(e, "2026-09-03").pairs[0].statusLabel === "วันหยุด");
  ok("exec: an unrostered day is วันหยุด, never ขาดงาน", day(e, "2026-09-04").pairs[0].statusLabel === "วันหยุด");

  // No-clock part-timer: paid from the roster at the hourly rate.
  const p = buildLineBreakdown(db, period, noClockPt)!;
  const pd = day(p, "2026-09-01");
  ok("no-clock PT: rostered day is a worked row", pd.pairs[0].statusLabel === ROSTER_LABEL && pd.effectiveMinutes > 0);
  ok("no-clock PT: day pay = hours × hourly rate", Math.abs(pd.pay - (pd.effectiveMinutes / 60) * 100) < 0.02);

  // A person who DOES clock in keeps the old reading: rostered but no punch = ขาดงาน.
  const c = buildLineBreakdown(db, period, clockedFt)!;
  ok("clocked-in employee: rostered day with no punch is still ขาดงาน", day(c, "2026-09-01").pairs[0].statusLabel === "ขาดงาน");

  // Approved leave on a rostered day wins over the roster.
  db.prepare("INSERT INTO leave_requests (user_id, type, date_from, date_to, days, status, reason) VALUES (?, 'sick', '2026-09-02', '2026-09-02', 1, 'approved', 'x')").run(execFt);
  const e2 = buildLineBreakdown(db, period, execFt)!;
  ok("approved leave on a rostered day shows the leave", day(e2, "2026-09-02").pairs[0].statusLabel === "ลาป่วย");

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); cleanup(); process.exit(1); });
