// การขออนุโลมการมาสาย (owner 2026-09-05).
//
// Proves: create/re-file/lock, decide, review scoping, and that an approved
// excusal removes that day from approvedExcusedDatesForMonth (the set the SVC
// lateness loop skips).
//
// Run:  node --import tsx scripts/test-late-excusal.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-late-excusal.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const x = await import("../src/lib/late-excusals");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const mkUser = (name: string) => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES (?,?,?,'staff','active','pt')"
  ).run(name, "x", name).lastInsertRowid);
  const branchId = Number(db.prepare("INSERT INTO branches (name,slug,status) VALUES ('NAMA','nama','open')").run().lastInsertRowid);
  const staffA = mkUser("staffA"), staffB = mkUser("staffB"), admin = mkUser("admin");

  console.log("create + re-file + lock:");
  const c1 = x.createExcusal(db, { userId: staffA, workDate: "2026-09-02", branchId, reason: "ติดเรียน" });
  ok("สร้างคำขอได้", "id" in c1);
  const c2 = x.createExcusal(db, { userId: staffA, workDate: "2026-09-02", branchId, reason: "เลิกเรียนช้า" });
  ok("ยื่นซ้ำวันเดิม = แก้ของเดิม (id เท่าเดิม)", "id" in c2 && "id" in c1 && c2.id === c1.id);
  const mine = x.listMyExcusals(db, staffA);
  ok("มี 1 คำขอ (ไม่ซ้ำ)", mine.length === 1 && mine[0].reason === "เลิกเรียนช้า" && mine[0].status === "pending");

  console.log("\ndecide + lock after approve:");
  ok("อนุมัติได้", x.decideExcusal(db, ("id" in c1 ? c1.id : 0), admin, true, null));
  ok("อนุมัติซ้ำไม่ได้ (ไม่ pending แล้ว)", !x.decideExcusal(db, ("id" in c1 ? c1.id : 0), admin, true, null));
  const relock = x.createExcusal(db, { userId: staffA, workDate: "2026-09-02", branchId, reason: "x" });
  ok("ยื่นซ้ำวันที่อนุมัติแล้ว = ล็อก", "error" in relock && relock.error === "already_approved");

  console.log("\napprovedExcusedDatesForMonth (feeds SVC skip):");
  const excused = x.approvedExcusedDatesForMonth(db, "2026-09");
  ok("วันที่อนุมัติอยู่ในเซ็ต", !!excused.get(staffA)?.has("2026-09-02"));
  // A pending one must NOT be in the set.
  x.createExcusal(db, { userId: staffB, workDate: "2026-09-03", branchId, reason: "รถติด" });
  const excused2 = x.approvedExcusedDatesForMonth(db, "2026-09");
  ok("คำขอ pending ไม่อยู่ในเซ็ต", !excused2.get(staffB));
  ok("เดือนอื่นไม่ติดมา", x.approvedExcusedDatesForMonth(db, "2026-08").size === 0);

  console.log("\nreview scoping:");
  const superView = x.listExcusalsForReview(db, null, true);
  ok("super เห็นทั้งหมด (2 รายการ)", superView.length === 2);
  const branchView = x.listExcusalsForReview(db, [branchId]);
  ok("แอดมินสาขา เห็นเฉพาะ pending ของสาขา (staffB)", branchView.length === 1 && branchView[0].user_id === staffB);
  const otherBranchView = x.listExcusalsForReview(db, [branchId + 999]);
  ok("สาขาอื่น ไม่เห็น (branch-scoped)", otherBranchView.length === 0);
  ok("นับ pending ของสาขา = 1", x.pendingExcusalCount(db, [branchId]) === 1);

  console.log("\nreject:");
  const pend = branchView[0];
  ok("ไม่อนุมัติได้", x.decideExcusal(db, pend.id, admin, false, "ไม่มีหลักฐาน"));
  ok("รายการถูกปฏิเสธ ไม่เข้าเซ็ตอนุโลม", !x.approvedExcusedDatesForMonth(db, "2026-09").get(staffB));

  console.log(`\ntest-late-excusal: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
