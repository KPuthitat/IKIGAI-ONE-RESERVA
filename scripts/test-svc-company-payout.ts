// เซอร์วิสชาร์จ · company-wide payout state (owner 2026-09-03).
//
// Proves companySvcPayoutState: participating branches, per-branch month
// completeness, and the aggregate status = least-advanced branch — the logic
// that gates the company-wide close → pay → post flow.
//
// Run:  node --import tsx scripts/test-svc-company-payout.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-svc-company-payout.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const sc = await import("../src/lib/service-charge");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('IKIGAI')").run().lastInsertRowid);
  const A = Number(db.prepare("INSERT INTO branches (slug,name,company_id,display_order) VALUES ('a','NAMA',?,1)").run(co).lastInsertRowid);
  const B = Number(db.prepare("INSERT INTO branches (slug,name,company_id,display_order) VALUES ('b','HYPO',?,2)").run(co).lastInsertRowid);
  const C = Number(db.prepare("INSERT INTO branches (slug,name,company_id,display_order) VALUES ('c','CLINIC',?,3)").run(co).lastInsertRowid);
  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('x','x','X','staff','active')").run().lastInsertRowid);

  const ym = "2026-09";              // live (computed) month, 30 days
  const insDay = db.prepare("INSERT OR IGNORE INTO daily_service_charge (branch_id,date,amount_baht,entered_by_user_id,entered_at) VALUES (?,?,?,?,datetime('now'))");
  const fill = (branch: number, days: number) => {
    for (let d = 1; d <= days; d++) insDay.run(branch, `${ym}-${String(d).padStart(2, "0")}`, 100, uid);
  };
  fill(A, 30);   // A complete
  fill(B, 10);   // B incomplete (10/30)
  // C (clinic) enters nothing → not participating

  // ── participating branches + completeness ──
  const parts = sc.svcParticipatingBranches(co, ym).map((b) => b.id).sort((a, b) => a - b);
  ok("participating = branches with svc (A,B) not C", parts.length === 2 && parts.includes(A) && parts.includes(B));
  ok("svcMonthFill: A complete (30/30)", sc.svcMonthFill(A, ym).complete);
  ok("svcMonthFill: B incomplete (10/30)", !sc.svcMonthFill(B, ym).complete && sc.svcMonthFill(B, ym).filled === 10);

  let st = sc.companySvcPayoutState(co, ym);
  ok("state: not all complete (B missing days)", st.allComplete === false && st.incomplete.some((x) => x.id === B));
  ok("state: status draft (no batches)", st.status === "draft");

  // Complete B → allComplete true
  fill(B, 30);   // re-insert days 1..30 (11..30 new; 1..10 duplicate rows are harmless for DISTINCT date)
  st = sc.companySvcPayoutState(co, ym);
  ok("state: all complete after B filled", st.allComplete === true && st.incomplete.length === 0);

  const setStatus = (branch: number, status: string) =>
    db.prepare("INSERT INTO svc_payout_batches (branch_id,year_month,status) VALUES (?,?,?) ON CONFLICT(branch_id,year_month) DO UPDATE SET status=excluded.status").run(branch, ym, status);

  // A finalized, B still draft → aggregate = least-advanced = draft
  setStatus(A, "finalized");
  ok("aggregate = least-advanced (A finalized, B draft → draft)", sc.companySvcPayoutState(co, ym).status === "draft");

  setStatus(B, "finalized");
  ok("both finalized → finalized", sc.companySvcPayoutState(co, ym).status === "finalized");

  setStatus(A, "paid"); setStatus(B, "paid");
  ok("both paid → paid", sc.companySvcPayoutState(co, ym).status === "paid");

  setStatus(A, "posted");   // B still paid
  ok("A posted, B paid → paid (least-advanced)", sc.companySvcPayoutState(co, ym).status === "paid");

  setStatus(B, "posted");
  ok("both posted → posted", sc.companySvcPayoutState(co, ym).status === "posted");

  console.log(`\nsvc company-payout test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
