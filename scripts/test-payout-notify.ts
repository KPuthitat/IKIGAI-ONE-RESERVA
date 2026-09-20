// Paid-notification recipients (owner 2026-09-20). LINE sending itself no-ops
// outside production (sendLinePush dev guard), so this proves who gets picked
// and that the notify entry points never throw.
//
// Run:  node --import tsx scripts/test-payout-notify.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-payout-notify.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const pn = await import("../src/lib/payout-notify");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const mkUser = (uname: string, line: string | null) =>
    Number(db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,status,line_user_id) VALUES (?,?,?,'staff','active',?)"
    ).run(uname, "x", uname, line).lastInsertRowid);

  const bound = mkUser("bound", "U-bound-123");
  const unbound = mkUser("unbound", null);
  const empty = mkUser("empty", "");

  ok("boundLineUsers keeps only LINE-bound users", (() => {
    const r = pn.boundLineUsers([bound, unbound, empty]).map((x) => x.userId);
    return r.length === 1 && r[0] === bound;
  })());
  ok("boundLineUsers de-dups + ignores junk ids", pn.boundLineUsers([bound, bound, 0, -1]).length === 1);
  ok("boundLineUsers empty input → empty", pn.boundLineUsers([]).length === 0);

  // A payroll period with two lines (one bound, one not) — notify must not throw
  // and must no-op the real send (dev guard).
  const pid = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status) VALUES ('weekly','2026-09-01','2026-09-07','2026-09-08','finalized')"
  ).run().lastInsertRowid);
  const addLine = (uid: number, net: number) =>
    db.prepare("INSERT INTO payroll_lines (period_id,user_id,display_name,net_pay) VALUES (?,?,?,?)")
      .run(pid, uid, "n", net);
  addLine(bound, 1000);
  addLine(unbound, 800);
  let threw = false;
  try { await pn.notifyPayrollPeriodPaid(pid); } catch { threw = true; }
  ok("notifyPayrollPeriodPaid does not throw", !threw);

  let threw2 = false;
  try { await pn.notifyPayrollPeriodPaid(999999); } catch { threw2 = true; }
  ok("notifyPayrollPeriodPaid on a missing period is a safe no-op", !threw2);

  console.log(`\npayout-notify test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
