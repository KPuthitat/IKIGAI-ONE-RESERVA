// Pending-OT warning for a payroll round (owner 2026-10-05).
// Run:  node --import tsx scripts/test-payroll-pending-ot.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-payroll-pending-ot.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { listPendingOtForPeriod } = await import("../src/lib/payroll-pending-ot");
  const db = getDb();
  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const mkUser = (u: string, name: string) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?, 'x', ?, 'staff', 'active')").run(u, name).lastInsertRowid);
  const u1 = mkUser("u1", "Alice"), u2 = mkUser("u2", "Bob"), u3 = mkUser("u3", "Cara"), outsider = mkUser("u4", "Dan");
  const period = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('weekly','2026-09-28','2026-10-04','2026-10-05','finalized',NULL,'pt','auto')"
  ).run().lastInsertRowid);
  for (const u of [u1, u2, u3]) {
    db.prepare("INSERT INTO payroll_lines (period_id,user_id,display_name,employment_type,gross_pay,is_helper) VALUES (?,?,?,'pt',0,0)").run(period, u, `U${u}`);
  }
  const ot = (user: number, date: string, until: string, status: string, from: string | null, early: string | null) =>
    db.prepare("INSERT INTO ot_requests (user_id,branch_id,work_date,requested_until,requested_from,status,early_status) VALUES (?,?,?,?,?,?,?)").run(user, br, date, until, from, status, early);

  ot(u1, "2026-10-04", "21:30", "pending", null, null);       // late pending → listed
  ot(u1, "2026-10-03", "20:45", "approved", null, null);      // approved → not listed
  ot(u2, "2026-10-02", "20:30", "rejected", null, null);      // rejected → not listed
  ot(u2, "2026-09-30", "", "pending", "10:30", "pending");    // early-only pending (late side empty) → listed as early
  ot(u3, "2026-10-01", "21:00", "pending", "10:30", "pending"); // both pending → both
  ot(u3, "2026-09-20", "21:00", "pending", null, null);       // before the round → not listed
  ot(u3, "2026-10-09", "21:00", "pending", null, null);       // after the round → not listed
  ot(outsider, "2026-10-01", "21:00", "pending", null, null); // not in this round → not listed

  const list = listPendingOtForPeriod(db, period);
  ok("lists exactly the 3 pending requests inside the round for its staff", list.length === 3);
  ok("sorted by date: Bob early (09-30), Cara both (10-01), Alice late (10-04)",
    list[0].work_date === "2026-09-30" && list[1].work_date === "2026-10-01" && list[2].work_date === "2026-10-04");
  ok("kinds: early-only / both / late", list[0].kind === "early" && list[1].kind === "both" && list[2].kind === "late");
  ok("carries the staff name", list[2].name.includes("Alice") && list[0].name.includes("Bob"));
  ok("approved, rejected, out-of-range and non-round staff are ignored", !list.some((l) => l.user_id === outsider || l.work_date === "2026-10-03" || l.work_date === "2026-10-02" || l.work_date === "2026-09-20" || l.work_date === "2026-10-09"));

  // Once decided, nothing is pending.
  db.prepare("UPDATE ot_requests SET status='approved', early_status=CASE WHEN early_status IS NULL THEN NULL ELSE 'approved' END WHERE status='pending' OR early_status='pending'").run();
  ok("after approving everything → empty", listPendingOtForPeriod(db, period).length === 0);
  ok("unknown period → empty", listPendingOtForPeriod(db, 9999).length === 0);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
