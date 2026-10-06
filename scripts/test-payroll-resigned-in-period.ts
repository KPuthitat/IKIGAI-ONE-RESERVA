// Staff who resigned/were terminated DURING a payroll round must still be in that
// round (owner 2026-10-06: ฐิติวรดา ลาออกต้นเดือน หายจากรอบ), prorated by their last
// working day — and still stay out of rounds that start after it.
// Run:  node --import tsx scripts/test-payroll-resigned-in-period.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-payroll-resigned-in-period.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { computePayrollPeriod } = await import("../src/lib/payroll-compute");
  const db = getDb();
  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const mk = (name: string, status: string) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,monthly_salary,pay_cycle) VALUES (?,?,?,'staff',?,'ft',1,30000,'monthly')"
  ).run(name, "x", name, status).lastInsertRowid);
  const active = mk("active", "active");
  const resignedEarly = mk("resigned-sep-5", "resigned");      // last day 2026-09-05 → in the Sept round, prorated
  const resignedAug = mk("resigned-aug-20", "resigned");       // last day 2026-08-20 → NOT in the Sept round
  const terminated = mk("terminated-sep-10", "terminated");    // last day 2026-09-10 → in the Sept round
  const disabled = mk("disabled", "disabled");                 // never
  const resignedNoRecord = mk("resigned-no-record", "resigned"); // no last day known → never
  const resignedPending = mk("resigned-pending-only", "resigned"); // resignation not approved → never

  const resign = (uid: number, day: string, status = "approved") => db.prepare(
    "INSERT INTO resignation_requests (user_id, proposed_last_day, computed_min_last_day, reason, status) VALUES (?,?,?,?,?)"
  ).run(uid, day, day, "x", status);
  resign(resignedEarly, "2026-09-05");
  resign(resignedAug, "2026-08-20");
  resign(resignedPending, "2026-09-05", "pending");
  db.prepare(
    "INSERT INTO termination_records (user_id, termination_type, reason, effective_date, status) VALUES (?, 'no_cause', 'x', '2026-09-10', 'executed')"
  ).run(terminated);

  const period = (start: string, end: string) => Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly',?,?,?, 'draft',NULL,'ft','auto')"
  ).run(start, end, end).lastInsertRowid);
  const lineOf = (pid: number, uid: number) =>
    db.prepare("SELECT gross_pay FROM payroll_lines WHERE period_id = ? AND user_id = ?").get(pid, uid) as { gross_pay: number } | undefined;

  const sep = period("2026-09-01", "2026-09-30");
  computePayrollPeriod(db, sep);
  ok("Sept round: active staff paid", !!lineOf(sep, active));
  ok("Sept round: resigned 5 Sep is still in the round", !!lineOf(sep, resignedEarly));
  ok("Sept round: resigned 5 Sep is prorated (5/30 of 30,000 = 5,000), not the full salary", Math.abs((lineOf(sep, resignedEarly)?.gross_pay ?? 0) - 5000) < 1);
  ok("Sept round: terminated 10 Sep is in the round, prorated (10/30 = 10,000)", Math.abs((lineOf(sep, terminated)?.gross_pay ?? 0) - 10000) < 1);
  ok("Sept round: someone who left 20 Aug is NOT in it", !lineOf(sep, resignedAug));
  ok("Sept round: disabled account never paid", !lineOf(sep, disabled));
  ok("Sept round: resigned with no known last day never paid", !lineOf(sep, resignedNoRecord));
  ok("Sept round: an unapproved resignation does not count as a last day", !lineOf(sep, resignedPending));

  const aug = period("2026-08-01", "2026-08-31");
  computePayrollPeriod(db, aug);
  ok("Aug round: resigned 20 Aug is in it, prorated (20/30 = 20,000)", Math.abs((lineOf(aug, resignedAug)?.gross_pay ?? 0) - 20000) < 1);
  ok("Aug round: someone leaving 5 Sep was employed all August → full salary", Math.abs((lineOf(aug, resignedEarly)?.gross_pay ?? 0) - 30000) < 1);

  const oct = period("2026-10-01", "2026-10-31");
  computePayrollPeriod(db, oct);
  ok("Oct round: nobody who already left appears", !lineOf(oct, resignedEarly) && !lineOf(oct, resignedAug) && !lineOf(oct, terminated));
  ok("Oct round: active staff still paid", !!lineOf(oct, active));

  // Doctor-fee rounds use the same rule: a doctor who left mid-round keeps the days they were rostered.
  const { rosterHoursByDoctor } = await import("../src/lib/df-db");
  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('df','AT HOME')").run().lastInsertRowid);
  const sh = Number(db.prepare("INSERT INTO shift_codes (branch_id, code, name, start_time, end_time) VALUES (?,?,?,?,?)").run(B, "D1", "D1", "09:00", "17:00").lastInsertRowid);
  const mkDoc = (name: string, status: string) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type,clinical_role) VALUES (?,?,?,'staff',?,'pt','doctor')"
  ).run(name, "x", name, status).lastInsertRowid);
  const docLeftInRound = mkDoc("doc-left-sep-5", "resigned");
  const docLeftBefore = mkDoc("doc-left-aug-20", "resigned");
  const docActive = mkDoc("doc-active", "active");
  resign(docLeftInRound, "2026-09-05");
  resign(docLeftBefore, "2026-08-20");
  let posN = 0;
  for (const d of [docLeftInRound, docLeftBefore, docActive]) {
    const pos = Number(db.prepare("INSERT INTO roster_positions (branch_id, title) VALUES (?, ?)").run(B, `P${++posN}`).lastInsertRowid);
    db.prepare("INSERT INTO roster_assignments (branch_id, assignment_date, position_id, user_id, shift_code_id) VALUES (?,?,?,?,?)").run(B, "2026-09-03", pos, d, sh);
  }
  const hours = rosterHoursByDoctor(B, "2026-09-01", "2026-09-07");
  ok("DF round: doctor who resigned 5 Sep keeps the shift rostered 3 Sep", hours.has(docLeftInRound));
  ok("DF round: doctor who left 20 Aug is not in the September round", !hours.has(docLeftBefore));
  ok("DF round: active doctor counted", hours.has(docActive));

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
