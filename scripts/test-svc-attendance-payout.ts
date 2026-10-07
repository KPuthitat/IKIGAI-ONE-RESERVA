// SVC payout under the attendance criteria (owner 2026-10-07): full / half / none,
// per-event and whole-month waivers, company pool, branch parity, old months untouched.
// Run:  node --import tsx scripts/test-svc-attendance-payout.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-svc-attendance-payout.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const sc = await import("../src/lib/service-charge");
  const att = await import("../src/lib/svc-attendance");
  const db = getDb();
  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.011;

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('CO')").run().lastInsertRowid);
  const A = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('a','A',?)").run(co).lastInsertRowid);
  const shift = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time) VALUES (?,?,?,?,?)").run(A, "M", "M", "09:00", "17:00").lastInsertRowid);
  const mkUser = (u: string) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,receives_service_charge) VALUES (?,?,?,'staff','active','ft',1,1)").run(u, "x", u).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(id, A);
    return id;
  };
  const admin = mkUser("admin");
  const P = mkUser("full"), Q = mkUser("half"), R = mkUser("none");
  const DAYS = ["01", "02", "03", "04", "07", "08", "09", "10", "11", "14"];
  let pos = 0;
  const posOf = new Map<number, number>();
  const at = (d: string, hhmm: string) => new Date(`2026-09-${d}T${hhmm}:00+07:00`).toISOString();
  const punch = (u: number, d: string) => {
    db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(u, "in", at(d, "09:00"), A);
    db.prepare("INSERT INTO time_entries (user_id,type,ts,branch_id) VALUES (?,?,?,?)").run(u, "out", at(d, "17:00"), A);
  };
  for (const u of [P, Q, R]) {
    posOf.set(u, Number(db.prepare("INSERT INTO roster_positions (branch_id,title) VALUES (?,?)").run(A, `P${++pos}`).lastInsertRowid));
    DAYS.forEach((d, i) => {
      db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(A, `2026-09-${d}`, posOf.get(u), u, shift);
      const absentDays = u === Q ? 3 : u === R ? 6 : 0;     // Q misses the first 3 days, R the first 6
      if (i >= absentDays) punch(u, d);
    });
  }
  for (const d of DAYS) db.prepare("INSERT INTO daily_service_charge (branch_id,date,amount_baht,entered_by_user_id,entered_at) VALUES (?,?,1000,?,datetime('now'))").run(A, `2026-09-${d}`, admin);
  // Pin "today" past the month so every rostered day without a punch is judged ขาด.
  // (computeSvcAttendance defaults to the real clock, which is after Sept 2026.)

  const row = (s: Awaited<ReturnType<typeof sc.computeCompanySvcSummary>>, u: number) => s.rows.find((r) => r.userId === u)!;
  let s = sc.computeCompanySvcSummary(co, "2026-09");
  const rp = row(s, P), rq = row(s, Q), rr = row(s, R);
  ok("P: 0 events → full, paid in full", rp.attendance?.tier === "full" && !rp.forfeited && !rp.halved && near(rp.netPayout, rp.grossAllocation));
  ok("Q: 3 absent of 10 = 30% → half", rq.attendance?.tier === "half" && rq.attendance?.absent === 3 && rq.halved === true);
  ok("Q: paid on half of the accrual; the other half is the penalty", near(rq.grossAllocation, (rq.grossBeforePenalty ?? 0) / 2) && near(rq.penaltyAmount ?? 0, (rq.grossBeforePenalty ?? 0) / 2) && near(rq.netPayout, rq.grossAllocation));
  ok("R: 6 absent of 10 = 60% → none → forfeited, reason attendance, paid 0", rr.attendance?.tier === "none" && rr.forfeited && rr.forfeitReason === "attendance" && rr.netPayout === 0);
  ok("company pool = 40% + R's accrual + Q's withheld half", near(s.companyPoolTotal, s.totalCollected * 0.4 + rr.grossAllocation + (rq.penaltyAmount ?? 0)));
  ok("staff pool reconciles: paid + withheld = 60% of the collected", near(s.totalNetPayout + rr.grossAllocation + (rq.penaltyAmount ?? 0), s.totalCollected * 0.6));

  // The branch view agrees with the company view for the same person.
  const bs = sc.computeMonthlySvcSummary(A, "2026-09");
  const bq = bs.rows.find((r) => r.userId === Q)!, br = bs.rows.find((r) => r.userId === R)!;
  ok("branch view: same tier and same net as the company view", bq.halved === true && near(bq.netPayout, rq.netPayout) && br.forfeited && br.netPayout === 0);
  const payout = sc.computeBranchSvcPayout(A, "2026-09");
  ok("branch payout (what is posted) uses the company figures", near(payout.find((x) => x.userId === Q)!.net, rq.netPayout) && payout.find((x) => x.userId === R)!.net === 0);

  // Per-event waivers move a person between tiers.
  att.setSvcAttendanceExemption({ userId: Q, date: "2026-09-01", kind: "absent", exempted: true, byUserId: admin, reason: "ระบบเข้างานขัดข้อง" });
  att.setSvcAttendanceExemption({ userId: Q, date: "2026-09-02", kind: "absent", exempted: true, byUserId: admin });
  s = sc.computeCompanySvcSummary(co, "2026-09");
  const rq2 = row(s, Q);
  ok("Q: 2 absences waived → 1 of 10 = 10% → full, paid in full, nothing withheld", rq2.attendance?.tier === "full" && !rq2.halved && (rq2.penaltyAmount ?? 0) === 0 && near(rq2.netPayout, rq2.grossAllocation) && rq2.attendance?.waived === 2);

  // Whole-month waiver clears a forfeit (and is labelled).
  sc.setSvcForfeitExemption({ userId: R, yearMonth: "2026-09", exempted: true, byUserId: admin });
  s = sc.computeCompanySvcSummary(co, "2026-09");
  const rr2 = row(s, R);
  ok("R: whole-month waiver → paid in full, flagged exempted (was attendance)", !rr2.forfeited && rr2.exempted && rr2.exemptReason === "attendance" && near(rr2.netPayout, rr2.grossAllocation) && rr2.netPayout > 0);

  // A month before the criteria keeps the old late-minutes rule (no attendance object, no halving).
  const old = sc.computeCompanySvcSummary(co, "2026-08");
  ok("August 2026 (before the start month) is untouched by the new rule", old.rows.every((r) => !r.halved && !r.attendance && (r.penaltyAmount ?? 0) === 0));

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
