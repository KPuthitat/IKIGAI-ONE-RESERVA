// Fixture: รายงานผู้จัดการ — upsert dedup + company-wide visibility (owner 2026-08-04).
//
// พิสูจน์ตรรกะ lib ที่ไม่ trivial: (1) ผู้เขียนคนเดียว สาขา+วันเดียวกัน บันทึกซ้ำ =
// ทับของเดิม (ไม่เกิดแถวซ้ำ), (2) รายงานระดับบริษัท (branch_id NULL) โผล่ในลิสต์ของ
// ทุกสาขา, (3) กรองช่วงวันที่. รันบน in-memory schema ย่อ — ไม่พึ่ง seed จริง.
//
// Run:  node --import tsx scripts/verify-manager-reports.ts
import Database from "better-sqlite3";
import {
  upsertManagerReport, listManagerReports, getTodayReportForAuthor, getManagerReport, deleteManagerReport
} from "../src/lib/manager-reports";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE branches (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT, title_prefix TEXT);
  CREATE TABLE manager_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
    report_date TEXT NOT NULL,
    author_user_id INTEGER REFERENCES users(id),
    shift_summary TEXT NOT NULL DEFAULT '',
    situation TEXT NOT NULL DEFAULT '',
    meeting_topics TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
`);
db.prepare("INSERT INTO branches VALUES (1,'NAMA'),(2,'HYPO')").run();
db.prepare("INSERT INTO users VALUES (9,'สมชาย','นาย'),(10,'สมหญิง','นางสาว')").run();

// (1) upsert dedup — same author/branch/date twice = one row, latest wins
const a = upsertManagerReport(db, { branchId: 1, reportDate: "2026-08-04", authorUserId: 9,
  shiftSummary: "ยอด 5 หมื่น", situation: "แอร์เสีย", meetingTopics: "ขอเพิ่มคน" });
const b = upsertManagerReport(db, { branchId: 1, reportDate: "2026-08-04", authorUserId: 9,
  shiftSummary: "ยอด 6 หมื่น", situation: "", meetingTopics: "" });
assert(a === b, "same author/branch/date → upsert reuses same row id");
const t = getTodayReportForAuthor(db, 9, 1, "2026-08-04");
assert(t?.shift_summary === "ยอด 6 หมื่น", "upsert overwrites with latest content");
assert(t?.author_name === "สมชาย" && t?.branch_name === "NAMA", "joins author + branch name");

// (2) different author same day/branch = separate row
upsertManagerReport(db, { branchId: 1, reportDate: "2026-08-04", authorUserId: 10,
  shiftSummary: "กะดึกปกติ", situation: "", meetingTopics: "" });
const day = listManagerReports(db, { branchId: 1, from: "2026-08-04", to: "2026-08-04" });
assert(day.length === 2, "two managers same day → two rows");

// (3) company-wide (branch NULL) visible to every branch's list; other branch's row not
upsertManagerReport(db, { branchId: null, reportDate: "2026-08-04", authorUserId: 9,
  shiftSummary: "", situation: "", meetingTopics: "นโยบายบริษัท" });
upsertManagerReport(db, { branchId: 2, reportDate: "2026-08-04", authorUserId: 10,
  shiftSummary: "สาขาอื่น", situation: "", meetingTopics: "" });
const b1 = listManagerReports(db, { branchId: 1, from: "2026-08-04", to: "2026-08-04" });
assert(b1.length === 3, "branch-1 list = 2 own + 1 company-wide (excludes branch-2)");
assert(b1.some((r) => r.branch_name === null), "company-wide row (branch_name null) present in branch list");

// (4) date filter
upsertManagerReport(db, { branchId: 1, reportDate: "2026-07-01", authorUserId: 9,
  shiftSummary: "เดือนก่อน", situation: "", meetingTopics: "" });
const win = listManagerReports(db, { branchId: 1, from: "2026-08-01", to: "2026-08-31" });
assert(!win.some((r) => r.report_date === "2026-07-01"), "date window excludes out-of-range report");

// (5) delete
deleteManagerReport(db, a);
assert(getManagerReport(db, a) === undefined, "delete removes the row");

console.log("\nmanager reports: all checks passed ✓");
