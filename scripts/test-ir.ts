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
//   • detailed self-report (owner 2026-10-01): RCA columns + people round-trip,
//     the reporter may edit their own open report (not others', not anonymous,
//     not once closed), the RM verdict is untouched by a reporter edit, and
//     reportIdsTouching finds reports a user filed or is named in
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
  const irLine = await import("../src/lib/ir-line");
  const { getDb } = dbMod;
  const { createReport, updateReport, listReports, getReport, openCount, trendFor,
    getReportDetail, updateReporterSections, canReporterEdit, reportIdsTouching, setPeople } = ir;

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

  // 7) Detailed self-report + RCA + people (owner 2026-10-01)
  const other = db.prepare(
    "SELECT id, display_name FROM users WHERE role IN ('staff','admin') AND id != ? AND status NOT IN ('disabled','resigned') ORDER BY id LIMIT 1"
  ).get(uid) as { id: number; display_name: string } | undefined;
  const c = createReport({
    branchId, reporterUserId: uid, isAnonymous: false,
    occurredAt: `${year}-06-03T12:40`,
    category: "resto.kitchen_accident", incidentType: "actual", severity: 3,
    description: "ซุปหกใส่ข้อมือลูกค้า", immediateAction: "ล้างน้ำเย็น",
    timeline: "12:30 รับออเดอร์\n12:40 ซุปหก", impact: "ลูกค้าแดงที่ข้อมือ",
    whyChain: ["ยกถาด 3 ถ้วยคนเดียว", "คนเสิร์ฟมีคนเดียว", "", "  ", "ไม่มีกติกาช่วงพีค", "เกิน 5 ชั้น ต้องถูกตัด"],
    contributing: ["process", "people", "bogus", "process"],
    reporterRootCause: "ไม่มีขั้นตอนรับมือช่วงพีค",
    recommendations: ["จำกัด 2 ถ้วยต่อถาด", "ครัวช่วยเสิร์ฟช่วงพีค"],
    selfInvolved: true,
    people: [
      ...(other ? [{ userId: other.id, name: "ชื่อปลอมที่ต้องถูกแทนที่", role: "witness" as const, note: "เห็นตอนเกิดเหตุ" }] : []),
      { userId: null, name: "ลูกค้าโต๊ะ 5", role: "affected" as const },
      { userId: null, name: "   ", role: "involved" as const },           // blank → dropped
      { userId: 999999999, name: "ไม่มีจริง", role: "involved" as const }  // unknown user → dropped
    ]
  });
  const cd = getReportDetail(c.id, branchId)!;
  ok("detail decodes the why chain (blanks dropped)", cd.rca.whyChain.length === 4 && cd.rca.whyChain[2] === "ไม่มีกติกาช่วงพีค");
  ok("detail keeps only known contributing factors", cd.rca.contributing.length === 2 && cd.rca.contributing.includes("process") && cd.rca.contributing.includes("people") && !cd.rca.contributing.includes("bogus"));
  ok("detail carries recommendations, timeline, impact, self_involved", cd.rca.recommendations.length === 2 && !!cd.timeline?.startsWith("12:30") && cd.impact === "ลูกค้าแดงที่ข้อมือ" && cd.self_involved === 1);
  ok("people: blank + unknown-user entries dropped", cd.people.length === (other ? 2 : 1));
  if (other) {
    const w = cd.people.find((p) => p.user_id === other.id);
    ok("people: employee entry takes the real display name, not the typed one", !!w && w.name === other.display_name && w.role === "witness" && w.note === "เห็นตอนเกิดเหตุ");
  }
  ok("people: outsider keeps the typed name with user_id null", cd.people.some((p) => p.user_id === null && p.name === "ลูกค้าโต๊ะ 5" && p.role === "affected"));
  ok("reporter_updated_at stamped on create", cd.reporter_updated_at != null);

  // reporter edit rules
  ok("canReporterEdit: owner of an open report", canReporterEdit(cd, uid));
  ok("canReporterEdit: someone else cannot", !canReporterEdit(cd, uid + 123456));
  ok("canReporterEdit: anonymous report has no owner", !canReporterEdit(bView, uid));
  const notOwner = updateReporterSections(c.id, branchId, uid + 123456, { description: "แก้โดยคนอื่น" });
  ok("edit by non-owner refused (not_owner)", !notOwner.ok && notOwner.error === "not_owner");
  const anonEdit = updateReporterSections(b.id, branchId, uid, { description: "x" });
  ok("edit of an anonymous report refused", !anonEdit.ok && anonEdit.error === "not_owner");
  // RM verdict first, then the reporter edits → verdict must survive.
  updateReport(c.id, branchId, { status: "reviewing", rootCause: "RM: ขั้นตอนช่วงพีค", correctiveAction: "RM: ออกกติกา" }, uid);
  const capped = updateReporterSections(c.id, branchId, uid, { whyChain: ["1", "2", "3", "4", "5", "6", "7"] });
  ok("why chain capped at 5 on edit", capped.ok && capped.report.rca.whyChain.length === 5);
  const edited = updateReporterSections(c.id, branchId, uid, {
    whyChain: ["ยกถาดหนัก", "ไม่มีคนช่วย"], contributing: ["equipment"],
    recommendations: ["เปลี่ยนถาดกันลื่น"], people: [{ userId: null, name: "ไรเดอร์", role: "witness" }]
  });
  ok("owner edit succeeds while open", edited.ok);
  if (edited.ok) {
    ok("edit replaces why chain + factors + recommendations", edited.report.rca.whyChain.length === 2 && edited.report.rca.contributing.join() === "equipment" && edited.report.rca.recommendations[0] === "เปลี่ยนถาดกันลื่น");
    ok("edit replaces the people list", edited.report.people.length === 1 && edited.report.people[0].name === "ไรเดอร์");
    ok("edit leaves the RM verdict untouched", edited.report.root_cause === "RM: ขั้นตอนช่วงพีค" && edited.report.corrective_action === "RM: ออกกติกา" && edited.report.status === "reviewing");
    ok("edit keeps untouched reporter fields", edited.report.description === "ซุปหกใส่ข้อมือลูกค้า" && edited.report.reporter_root_cause === "ไม่มีขั้นตอนรับมือช่วงพีค");
  }
  const codeBefore = getReport(c.id, branchId)!.code;
  const movedYear = updateReporterSections(c.id, branchId, uid, { occurredAt: `${year - 1}-06-03T12:40` });
  ok("moving the incident to another year re-issues the code in that year", movedYear.ok && movedYear.report.code !== codeBefore && movedYear.report.code!.startsWith(`IR-${year - 1}-`));
  updateReporterSections(c.id, branchId, uid, { occurredAt: `${year}-06-03T12:40` });
  const noPeopleEdit = updateReporterSections(c.id, branchId, uid, { impact: "อัปเดตผลกระทบ" });
  ok("edit without a people key keeps the existing people", noPeopleEdit.ok && noPeopleEdit.report.people.length === 1 && noPeopleEdit.report.impact === "อัปเดตผลกระทบ");
  updateReport(c.id, branchId, { status: "closed" }, uid);
  const closedEdit = updateReporterSections(c.id, branchId, uid, { description: "หลังปิดเคส" });
  ok("edit after close refused (closed)", !closedEdit.ok && closedEdit.error === "closed");
  ok("canReporterEdit false once closed", !canReporterEdit(getReport(c.id, branchId)!, uid));

  // reportIdsTouching: filed or named in
  const touchingUid = reportIdsTouching(branchId, uid);
  ok("reportIdsTouching includes reports I filed (a, c) but not the anonymous one", touchingUid.has(a.id) && touchingUid.has(c.id) && !touchingUid.has(b.id));
  if (other) {
    setPeople(c.id, [{ userId: other.id, role: "involved" }]);
    ok("reportIdsTouching includes a report I'm named in", reportIdsTouching(branchId, other.id).has(c.id));
    ok("setPeople de-duplicates the same employee", setPeople(c.id, [{ userId: other.id, role: "involved" }, { userId: other.id, role: "witness" }]).length === 1);
  }
  // old rows (no RCA) decode to empty lists
  ok("legacy row without RCA decodes to empty lists", (() => { const d = getReportDetail(a.id, branchId)!; return d.rca.whyChain.length === 0 && d.rca.contributing.length === 0 && d.rca.recommendations.length === 0 && d.people.length === 0; })());

  // 8) RM LINE group settings + the new-report card (owner 2026-10-02)
  ok("ir line group unset by default", ir.getIrLineGroupId(branchId) === null);
  ir.setIrLineGroupId(branchId, "  Cabc123  ");
  ok("setIrLineGroupId trims + stores", ir.getIrLineGroupId(branchId) === "Cabc123");
  ir.setIrLineGroupId(branchId, "   ");
  ok("blank group id clears the binding", ir.getIrLineGroupId(branchId) === null);
  const card = irLine.irNewReportFlex(getReportDetail(c.id, branchId)!, { branchName: "NAMA", reportUrl: "https://x.test/admin/ir/1" });
  const cardJson = JSON.stringify(card);
  ok("card altText names the code, severity and branch", card.altText.includes(getReport(c.id, branchId)!.code!) && card.altText.includes("ปานกลาง") && card.altText.includes("NAMA"));
  ok("card carries description, root cause, recommendations and the open button", cardJson.includes("ซุปหกใส่ข้อมือลูกค้า") && cardJson.includes("ไม่มีขั้นตอนรับมือช่วงพีค") && cardJson.includes("เปลี่ยนถาดกันลื่น") && cardJson.includes("https://x.test/admin/ir/1"));
  const reporterName = (db.prepare("SELECT display_name FROM users WHERE id = ?").get(uid) as { display_name: string }).display_name;
  const anonCard = JSON.stringify(irLine.irNewReportFlex(getReportDetail(b.id, branchId)!, { branchName: "NAMA", reportUrl: null }));
  ok("anonymous card says ไม่ระบุตัวตน and never carries the reporter's name", anonCard.includes("ไม่ระบุตัวตน") && !anonCard.includes(reporterName) && !anonCard.includes("\"uri\""));
  ok("named card does carry the reporter's name", cardJson.includes(reporterName));
  const skipped = await irLine.notifyIrRmGroup(branchId, c.id);
  ok("notify without a group id is a skip, not an error", !skipped.ok && skipped.skipped === "no_group");

  // 9) Reporter feedback card when the RM closes the case (owner 2026-10-02)
  const closedDetail = getReportDetail(c.id, branchId)!;   // c was closed above with an RM verdict
  const closedCard = irLine.irCaseClosedFlex(closedDetail, { branchName: "NAMA", reportUrl: "https://x.test/staff/ir/9" });
  const closedJson = JSON.stringify(closedCard);
  ok("closed card: title says ปิดแล้ว, carries the RM root cause + corrective action + link", closedCard.altText.includes("ปิดเคสแล้ว") && closedJson.includes("RM: ขั้นตอนช่วงพีค") && closedJson.includes("RM: ออกกติกา") && closedJson.includes("https://x.test/staff/ir/9"));
  updateReport(c.id, branchId, { status: "dismissed" }, uid);
  const dismissedCard = irLine.irCaseClosedFlex(getReportDetail(c.id, branchId)!, { branchName: "NAMA", reportUrl: null });
  ok("dismissed card: says ไม่นับเป็นเหตุการณ์ and reassures it's not the reporter's fault", dismissedCard.altText.includes("ไม่นับเป็นเหตุการณ์") && JSON.stringify(dismissedCard).includes("ไม่ใช่ความผิดของผู้แจ้ง"));
  const anonClose = await irLine.notifyIrReporterClosed(branchId, b.id);
  ok("notify reporter: anonymous report is skipped", !anonClose.ok && anonClose.skipped === "anonymous");
  const savedLine = (db.prepare("SELECT line_user_id FROM users WHERE id = ?").get(uid) as { line_user_id: string | null }).line_user_id;
  db.prepare("UPDATE users SET line_user_id = NULL WHERE id = ?").run(uid);
  const noLine = await irLine.notifyIrReporterClosed(branchId, c.id);
  ok("notify reporter: reporter without LINE is skipped", !noLine.ok && noLine.skipped === "no_line_user_id");
  db.prepare("UPDATE users SET line_user_id = ? WHERE id = ?").run(savedLine, uid);

  console.log(`\nir test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
