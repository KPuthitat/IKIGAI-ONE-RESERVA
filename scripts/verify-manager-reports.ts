// Fixture: รายงานผู้จัดการ — add-not-overwrite + edit + company-wide visibility
// (owner 2026-08-04, ปรับเป็นหลายเรื่อง/วัน 2026-09-03).
//
// พิสูจน์ตรรกะ lib ที่ไม่ trivial: (1) ผู้เขียนคนเดียว สาขา+วันเดียวกัน บันทึกซ้ำ =
// เพิ่มแถวใหม่ (ไม่ทับ) — 1 คนส่งได้หลายเรื่อง/วัน, (2) แก้ไขเนื้อหาตาม id +
// ตั้ง updated_at, (3) รายงานระดับบริษัท (branch_id NULL) โผล่ในลิสต์ทุกสาขา,
// (4) กรองช่วงวันที่ + (5) กรองตามผู้เขียน. รันบน in-memory schema ย่อ.
//
// Run:  node --import tsx scripts/verify-manager-reports.ts
import Database from "better-sqlite3";
import {
  createManagerReport, updateManagerReport, listManagerReports, getManagerReport, deleteManagerReport
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

const day = "2026-08-04";
const listDay = (branchId: number) => listManagerReports(db, { branchId, from: day, to: day });

// (1) add-not-overwrite — same author/branch/date twice = two separate rows
const a = createManagerReport(db, { branchId: 1, reportDate: day, authorUserId: 9,
  shiftSummary: "ยอด 5 หมื่น", situation: "แอร์เสีย", meetingTopics: "ขอเพิ่มคน" });
const b = createManagerReport(db, { branchId: 1, reportDate: day, authorUserId: 9,
  shiftSummary: "ยอด 6 หมื่น", situation: "", meetingTopics: "" });
assert(a !== b, "same author/branch/date twice → two separate rows (เพิ่ม ไม่ทับ)");
assert(listDay(1).length === 2, "both entries kept");

// (2) edit content by id + sets updated_at
updateManagerReport(db, a, { shiftSummary: "แก้แล้ว", situation: "s", meetingTopics: "m" });
const ra = getManagerReport(db, a);
assert(ra?.shift_summary === "แก้แล้ว", "update edits content");
assert(ra?.updated_at != null, "update sets updated_at");
assert(ra?.author_name === "สมชาย" && ra?.branch_name === "NAMA", "joins author + branch name");

// (3) another author same day → +1 row
createManagerReport(db, { branchId: 1, reportDate: day, authorUserId: 10,
  shiftSummary: "กะดึกปกติ", situation: "", meetingTopics: "" });
assert(listDay(1).length === 3, "three rows this day");

// (4) company-wide (branch NULL) visible to every branch's list; other branch's row not
createManagerReport(db, { branchId: null, reportDate: day, authorUserId: 9,
  shiftSummary: "", situation: "", meetingTopics: "นโยบายบริษัท" });
createManagerReport(db, { branchId: 2, reportDate: day, authorUserId: 10,
  shiftSummary: "สาขาอื่น", situation: "", meetingTopics: "" });
const b1 = listDay(1);
assert(b1.length === 4, "branch-1 list = 3 own + 1 company-wide (excludes branch-2)");
assert(b1.some((r) => r.branch_name === null), "company-wide row (branch_name null) present");

// (5) date filter
createManagerReport(db, { branchId: 1, reportDate: "2026-07-01", authorUserId: 9,
  shiftSummary: "เดือนก่อน", situation: "", meetingTopics: "" });
const win = listManagerReports(db, { branchId: 1, from: "2026-08-01", to: "2026-08-31" });
assert(!win.some((r) => r.report_date === "2026-07-01"), "date window excludes out-of-range report");

// (6) authorUserId filter — staff เห็นเฉพาะรายงานของตัวเอง
const mineOnly = listManagerReports(db, { branchId: 1, authorUserId: 10 });
assert(mineOnly.length > 0 && mineOnly.every((r) => r.author_user_id === 10),
  "authorUserId filter returns only that author's rows");

// (7) delete
deleteManagerReport(db, a);
assert(getManagerReport(db, a) === undefined, "delete removes the row");

console.log("\nmanager reports: all checks passed ✓");
