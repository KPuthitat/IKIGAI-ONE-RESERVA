// Forgot-to-clock-out warning (owner 2026-10-04): stepped severity ladder, the
// warning is recorded already acknowledged by PIN, admin can void it (not counted,
// hidden from staff). Run:  node --import tsx scripts/test-missing-out-ack.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-missing-out-ack.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/discipline");
  const T = await import("../src/lib/discipline-text");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  // Pure ladder + wording.
  ok("ladder: 0 → verbal, 1–2 → written 1, 3+ → written 2 (never final)", T.missingOutSeverity(0) === "verbal" && T.missingOutSeverity(1) === "written_1" && T.missingOutSeverity(2) === "written_1" && T.missingOutSeverity(3) === "written_2" && T.missingOutSeverity(9) === "written_2");
  const w0 = T.missingOutWarningText(0, "2026-09-30");
  ok("first lapse: light verbal note, not a written letter", w0.severity === "verbal" && !w0.isWritten && w0.title.startsWith("ตักเตือน"));
  ok("wording carries the date in พ.ศ. and the count", w0.body.includes("30 กันยายน พ.ศ. 2569") && w0.body.includes("ครั้งที่ 1"));
  const w1 = T.missingOutWarningText(1, "2026-10-02");
  ok("repeat: written letter, 2nd occurrence", w1.isWritten && w1.title.includes("หนังสือเตือน") && w1.title.includes("ครั้งที่ 2"));

  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const staff = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('s','x','S','staff','active')").run().lastInsertRowid);
  const admin = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','A','admin','active')").run().lastInsertRowid);
  const row = (id: number) => db.prepare("SELECT * FROM disciplinary_warnings WHERE id=?").get(id) as { severity: string; acknowledged_at: string | null; acknowledged_method: string | null; reason_category: string; validity_months: number | null; effective_date: string; voided_at: string | null };

  // 1st lapse.
  const a = D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-09-30" });
  ok("1st: verbal, prior 0", a.severity === "verbal" && a.priorCount === 0);
  ok("recorded already acknowledged by PIN, category ลงเวลา, 12-month validity", row(a.id).acknowledged_at != null && row(a.id).acknowledged_method === "pin_explicit" && row(a.id).reason_category === "ลงเวลา" && row(a.id).validity_months === 12 && row(a.id).effective_date === "2026-09-30");
  ok("never shows as pending acknowledgement", D.listWarningsForUser(staff, "pending").length === 0);

  // 2nd and 3rd → written 1.
  const b = D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-10-01" });
  const c = D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-10-02" });
  ok("2nd and 3rd: written letter 1", b.severity === "written_1" && c.severity === "written_1" && c.priorCount === 2);
  const d = D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-10-03" });
  ok("4th: written letter 2", d.severity === "written_2" && d.priorCount === 3);
  ok("count of ลงเวลา notes = 4", D.recentMissingOutWarnings(staff) === 4 && D.countWarningsByCategory(staff, "ลงเวลา") === 4);

  // Void one (e.g. the app was down): kept on record, not counted, hidden from staff.
  ok("admin voids a warning", D.voidWarning(c.id, admin, "ระบบขัดข้อง") === true);
  ok("voiding twice is refused", D.voidWarning(c.id, admin, "x") === false);
  ok("voided warning stays on record with who/why", row(c.id).voided_at != null && (db.prepare("SELECT void_reason r, voided_by b FROM disciplinary_warnings WHERE id=?").get(c.id) as { r: string; b: number }).b === admin);
  ok("voided warning no longer counts", D.recentMissingOutWarnings(staff) === 3 && D.countWarningsByCategory(staff, "ลงเวลา") === 3);
  ok("voided warning hidden from the staff's list, still in the branch list", !D.listWarningsForUser(staff).some((w) => w.id === c.id) && D.listWarningsForBranch(br).some((w) => w.id === c.id));
  ok("the ladder steps down after a void (next is the 4th active → written 2 still; counts 3)", D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-10-04" }).priorCount === 3);

  // Old notes fall out of the 12-month window.
  const other = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','staff','active')").run().lastInsertRowid);
  const old = D.createMissingOutWarning({ branchId: br, userId: other, workDate: "2025-01-05" });
  db.prepare("UPDATE disciplinary_warnings SET issued_at = datetime('now','-400 days') WHERE id=?").run(old.id);
  ok("a note older than 12 months does not push the ladder", D.createMissingOutWarning({ branchId: br, userId: other, workDate: "2026-10-04" }).severity === "verbal");

  // One lapse = one warning: re-filing the same work date (admin rejected the time) reuses it.
  const again = D.createMissingOutWarning({ branchId: br, userId: staff, workDate: "2026-10-01" });
  ok("re-filing the same work date reuses the warning (ladder does not step)", again.reused === true && again.id === b.id && D.recentMissingOutWarnings(staff) === 4);

  // Other offences do not step the clock-out ladder.
  const third = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('t','x','T','staff','active')").run().lastInsertRowid);
  D.createWarning({ branchId: br, userId: third, issuedByUserId: third, severity: "verbal", title: "ลืมลงเวลาเข้างาน (บันทึกอัตโนมัติ)", body: "x", reasonCategory: "ลงเวลา" });
  D.createWarning({ branchId: br, userId: third, issuedByUserId: admin, severity: "written_1", title: "มาสาย", body: "x", reasonCategory: "ลงเวลา" });
  ok("forgot-IN and other admin notes do not step the forgot-OUT ladder", D.createMissingOutWarning({ branchId: br, userId: third, workDate: "2026-10-04" }).severity === "verbal");

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
