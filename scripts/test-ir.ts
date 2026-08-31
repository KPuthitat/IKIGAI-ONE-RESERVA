// IR (incident report / risk management) behaviour proof.
//
// Clones the dev DB, lets getDb() run the ir_reports migration, then proves:
//   • createReport assigns a per-branch-year code and starts at 'new'
//   • an anonymous report withholds the reporter (null id, view name hidden)
//   • a non-anonymous report keeps the reporter and the view shows the name
//   • listReports filters by open vs all vs a single status
//   • updateReport stamps reviewed_* on first move out of 'new', stamps
//     resolved_* on reaching a terminal status, and CLEARS it on reopen
//   • trendFor / openCount tie out
//
// Run:  node --import tsx scripts/test-ir.ts   (or: npm run test:ir)

import fs from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "data", "reserva.db");
const TMP = path.join(process.cwd(), "data", "test-ir.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
if (!fs.existsSync(SRC)) {
  console.log("ir test: skipped (no data/reserva.db to clone)");
  process.exit(0);
}
fs.copyFileSync(SRC, TMP);
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(`${SRC}${ext}`)) fs.copyFileSync(`${SRC}${ext}`, `${TMP}${ext}`);
}
process.env.DATABASE_PATH = TMP;

(async () => {
  const dbMod = await import("../src/lib/db");
  const ir = await import("../src/lib/ir-db");
  const { getDb } = dbMod;
  const { createReport, updateReport, listReports, getReport, openCount, trendFor } = ir;

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const db = getDb();
  const branch = db.prepare("SELECT id FROM branches ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  const someUser = db.prepare(
    "SELECT id FROM users WHERE role IN ('staff','admin') ORDER BY id LIMIT 1"
  ).get() as { id: number } | undefined;
  if (!branch || !someUser) {
    console.log("ir test: skipped (clone has no branch/user)");
    cleanup();
    process.exit(0);
  }
  const branchId = branch.id;
  const uid = someUser.id;
  const year = new Date().getFullYear();

  // 1) non-anonymous create
  const a = createReport({
    branchId, reporterUserId: uid, isAnonymous: false,
    occurredAt: `${year}-06-01T10:00:00`,
    category: "resto.food_safety", incidentType: "actual", severity: 3,
    description: "อาหารตกพื้นแล้วเสิร์ฟ", immediateAction: "ทิ้งและทำใหม่"
  });
  ok("create assigns code IR-YYYY-0001", a.code === `IR-${year}-0001`);
  ok("create starts at status 'new'", a.status === "new");
  ok("non-anon keeps reporter id", a.reporter_user_id === uid && a.is_anonymous === 0);
  const aView = getReport(a.id, branchId)!;
  ok("non-anon view exposes reporter join", aView.reporter_name !== undefined);

  // 2) anonymous create — reporter withheld end to end
  const b = createReport({
    branchId, reporterUserId: uid, isAnonymous: true,
    occurredAt: `${year}-06-02T09:00:00`,
    category: "clinic.medication", incidentType: "near_miss", severity: 1,
    description: "เกือบจ่ายยาผิดขนาด"
  });
  ok("anon stores null reporter id", b.reporter_user_id === null && b.is_anonymous === 1);
  ok("anon code increments to 0002", b.code === `IR-${year}-0002`);
  const bView = getReport(b.id, branchId)!;
  ok("anon view hides reporter name", bView.reporter_name === null && bView.reporter_prefix === null);

  // 3) list filters
  ok("list all sees both", listReports({ branchId, status: "all" }).filter((r) => r.id === a.id || r.id === b.id).length === 2);
  ok("list open sees both (both open)", listReports({ branchId, status: "open" }).filter((r) => r.id === a.id || r.id === b.id).length === 2);
  ok("openCount ≥ 2", openCount(branchId) >= 2);

  // 4) status stamping
  const rev = updateReport(a.id, branchId, { status: "reviewing" }, uid)!;
  ok("new→reviewing stamps reviewed_at", rev.reviewed_at != null && rev.reviewed_by === uid);
  ok("reviewing not yet resolved", rev.resolved_at == null);

  const closed = updateReport(a.id, branchId, {
    status: "closed", rootCause: "ไม่มีป้ายเตือน", correctiveAction: "ติดป้าย + อบรม", assignedTo: uid
  }, uid)!;
  ok("→closed stamps resolved_at", closed.resolved_at != null && closed.resolved_by === uid);
  ok("closed keeps corrective action", closed.corrective_action === "ติดป้าย + อบรม");
  ok("closed is not in open list", listReports({ branchId, status: "open" }).every((r) => r.id !== a.id));

  const reopened = updateReport(a.id, branchId, { status: "action" }, uid)!;
  ok("reopen clears resolved_at", reopened.resolved_at == null && reopened.resolved_by == null);
  ok("reopen keeps original reviewed_at", reopened.reviewed_at === rev.reviewed_at);

  // 5) branch scoping — a foreign id returns null
  ok("getReport rejects wrong branch", getReport(a.id, branchId + 9999) === null);
  ok("update rejects wrong branch", updateReport(a.id, branchId + 9999, { status: "closed" }, uid) === null);

  // 6) trend
  const tr = trendFor(branchId);
  ok("trend counts our two reports", tr.total >= 2);
  ok("trend byMonth has 6 buckets", tr.byMonth.length === 6);
  ok("trend severity buckets present", Object.keys(tr.bySeverity).length === 5);

  console.log(`\nir test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
