// Quality document control (WI/WP) — owner 2026-09-04.
//
// Proves the document-control state machine: numbering, revisions, the
// draft→pending→approved→obsolete workflow, reject, and read acknowledgements.
//
// Run:  node --import tsx scripts/test-quality-docs.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-quality-docs.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const q = await import("../src/lib/quality-docs");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const mkUser = (name: string) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES (?,?,?,'staff','active','ft')"
  ).run(name, "x", name).lastInsertRowid);
  const admin = mkUser("admin"), staffA = mkUser("staffA"), staffB = mkUser("staffB");

  console.log("nextDocCode + createDocument:");
  ok("code แรก = WI-001", q.nextDocCode(db, "WI") === "WI-001");
  const d1 = q.createDocument(db, { docType: "WI", title: "ล้างมือ 7 ขั้นตอน", createdBy: admin, content: "<p>ขั้นตอน…</p>" });
  ok("สร้างเอกสาร → doc_code WI-001", d1.docCode === "WI-001");
  ok("code ถัดไป = WI-002", q.nextDocCode(db, "WI") === "WI-002");
  ok("WP นับแยก = WP-001", q.nextDocCode(db, "WP") === "WP-001");

  console.log("\nworkflow ร่าง→รออนุมัติ→อนุมัติ:");
  const got = q.getDocument(db, d1.documentId)!;
  ok("rev 1 เริ่มเป็น draft", got.versions[0].status === "draft" && got.versions[0].rev === 1);
  ok("submit → pending", q.submitVersion(db, d1.versionId));
  ok("approve → true", q.approveVersion(db, d1.versionId, admin, "2026-10-01"));
  const eff1 = q.effectiveVersion(db, d1.documentId)!;
  ok("มี effective version (approved)", eff1?.status === "approved" && eff1.rev === 1);
  ok("effective_date ตั้งแล้ว", eff1.effective_date === "2026-10-01");
  ok("อนุมัติซ้ำไม่ได้ (ไม่ pending แล้ว)", !q.approveVersion(db, d1.versionId, admin));

  console.log("\nรับทราบ (acknowledge):");
  ok("staffA รับทราบ", q.acknowledgeVersion(db, eff1.id, staffA));
  ok("รับทราบซ้ำ = ไม่เพิ่ม (idempotent)", !q.acknowledgeVersion(db, eff1.id, staffA));
  const as1 = q.ackStatus(db, eff1.id);
  ok("ackStatus: total 3 คน (admin+staffA+staffB)", as1.total === 3);
  ok("ackStatus: รับทราบแล้ว 1", as1.acked === 1 && as1.ackedUsers[0].user_id === staffA);
  ok("ackStatus: ค้าง 2", as1.pendingUsers.length === 2);

  console.log("\nrevision ใหม่ + supersede:");
  const r2 = q.addRevision(db, d1.documentId, { createdBy: admin, content: "<p>แก้ไข…</p>", changeSummary: "ปรับขั้นตอนที่ 3" });
  ok("rev 2 = draft", r2.rev === 2);
  q.submitVersion(db, r2.versionId);
  ok("approve rev 2", q.approveVersion(db, r2.versionId, admin, "2026-11-01"));
  const eff2 = q.effectiveVersion(db, d1.documentId)!;
  ok("effective ตอนนี้ = rev 2", eff2.rev === 2);
  ok("rev 1 กลายเป็น obsolete",
    (db.prepare("SELECT status FROM quality_document_versions WHERE id=?").get(eff1.id) as { status: string }).status === "obsolete");

  console.log("\nreject:");
  const d2 = q.createDocument(db, { docType: "WP", title: "รับสินค้า", createdBy: admin });
  q.submitVersion(db, d2.versionId);
  ok("reject → rejected + เหตุผล", q.rejectVersion(db, d2.versionId, "ยังไม่ครบขั้นตอน"));
  ok("แก้ไข rejected ได้", q.updateDraftVersion(db, d2.versionId, { content: "<p>เพิ่มขั้นตอน</p>" }));
  ok("resubmit ได้", q.submitVersion(db, d2.versionId));

  console.log("\nlistDocuments:");
  const list = q.listDocuments(db);
  ok("มี 2 เอกสาร", list.length === 2);
  const wi = list.find((x) => x.doc_code === "WI-001")!;
  ok("WI-001 effective rev = 2", wi.effective_rev === 2 && wi.latest_rev === 2);

  console.log(`\ntest-quality-docs: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
