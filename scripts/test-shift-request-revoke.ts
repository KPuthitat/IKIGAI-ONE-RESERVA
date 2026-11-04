// Take back an approved shift request — Run: node --import tsx scripts/test-shift-request-revoke.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-shift-request-revoke.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const S = await import("../src/lib/shift-requests");
  const P = await import("../src/lib/payroll-compute");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const b1 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const admin = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','a','admin','active')").run().lastInsertRowid);
  const emp = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type,monthly_salary) VALUES ('e','x','e','staff','active','ft',15500)").run().lastInsertRowid);
  db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(emp, b1);
  const req = (date: string, status = "approved", branch = b1) => {
    const id = Number(db.prepare("INSERT INTO shift_change_requests (user_id, branch_id, kind, work_date, status, ref_no) VALUES (?, ?, 'extra_shift', ?, ?, 'SC-T')").run(emp, branch, date, status).lastInsertRowid);
    return id;
  };
  const rest = (date: string) => P.loadRestDayWorkDates(db, date, date, emp).get(emp)?.has(date) === true;
  const rv = (id: number, o: Partial<{ branchId: number; reason: string }> = {}) => S.revokeApprovedShiftRequest({ branchId: b1, adminId: admin, id, reason: "พนักงานย้ายวันลา ไม่ได้ทำงานวันหยุดจริง", ...o });

  const r1 = req("2026-10-24");
  ok("an approved extra-shift marks the day as rest-day work", rest("2026-10-24"));
  ok("a reason is required", (() => { const r = rv(r1, { reason: " " }); return !r.ok && r.error === "reason_required"; })());
  ok("another branch cannot revoke it", (() => { const r = rv(r1, { branchId: b2 }); return !r.ok && r.error === "not_found"; })());
  const out = rv(r1);
  ok("revoking cancels it, so the day is no longer rest-day work", out.ok === true && !rest("2026-10-24") && (db.prepare("SELECT status FROM shift_change_requests WHERE id = ?").get(r1) as { status: string }).status === "cancelled");
  ok("the reason is kept on the request", ((db.prepare("SELECT decision_note n FROM shift_change_requests WHERE id = ?").get(r1) as { n: string }).n).includes("ยกเลิกการอนุมัติ: พนักงานย้ายวันลา"));
  ok("revoking twice is refused", (() => { const r = rv(r1); return !r.ok && r.error === "not_approved"; })());
  ok("a pending or rejected request cannot be 'revoked'", (() => { const r = rv(req("2026-10-25", "pending")); return !r.ok && r.error === "not_approved"; })());
  // a date already inside a closed payroll period is refused
  const per = Number(db.prepare("INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-10-01','2026-10-31','2026-11-05','paid',NULL,'ft','auto')").run().lastInsertRowid);
  db.prepare("INSERT INTO payroll_lines (period_id, user_id, display_name) VALUES (?, ?, 'e')").run(per, emp);
  ok("a date inside a closed period cannot be taken back", (() => { const r = rv(req("2026-10-27")); return !r.ok && r.error === "period_locked"; })());
  ok("…and that request stays approved", ((db.prepare("SELECT status s FROM shift_change_requests WHERE work_date = '2026-10-27'").get() as { s: string }).s) === "approved");

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
