// รายงานผู้จัดการ → เตรียมประชุมประจำสัปดาห์ (owner 2026-08-04).
//
// ผู้จัดการสาขาส่งรายงานปิดกะ + สถานการณ์ประจำวัน + เรื่องที่อยากยกเข้าประชุม.
// helper ที่ใช้ร่วมกันระหว่าง route (บันทึก) และหน้าเตรียมประชุม (รวมทั้งสัปดาห์
// ให้ AI สรุป). Query แยกรายสาขา — branchId ที่ส่งเข้ามาจะรวมรายงานของสาขานั้น
// + รายงานระดับบริษัท (branch_id IS NULL) ตามแนวเดียวกับ listMeetings.
import type Database from "better-sqlite3";

export type ManagerReportRow = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  report_date: string;
  author_user_id: number | null;
  author_name: string | null;
  author_prefix: string | null;
  shift_summary: string;
  situation: string;
  meeting_topics: string;
  created_at: string;
  updated_at: string | null;
};

const SELECT = `
  SELECT r.id, r.branch_id, b.name AS branch_name, r.report_date,
         r.author_user_id, au.display_name AS author_name, au.title_prefix AS author_prefix,
         r.shift_summary, r.situation, r.meeting_topics, r.created_at, r.updated_at
  FROM manager_reports r
  LEFT JOIN branches b ON b.id = r.branch_id
  LEFT JOIN users au ON au.id = r.author_user_id
`;

/** รายงานของสาขา (รวมระดับบริษัท) ในช่วงวันที่ [from, to] — ใหม่ก่อน. ใช้ทั้งหน้า
 *  รายการและตอนรวมส่งให้ AI สรุป. ถ้าไม่ส่ง branchId → ทุกสาขา. */
export function listManagerReports(
  db: Database.Database,
  opts: { branchId?: number | null; from?: string; to?: string; limit?: number; authorUserId?: number } = {}
): ManagerReportRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.branchId != null) {
    clauses.push("(r.branch_id = ? OR r.branch_id IS NULL)");
    params.push(opts.branchId);
  }
  if (opts.authorUserId != null) { clauses.push("r.author_user_id = ?"); params.push(opts.authorUserId); }
  if (opts.from) { clauses.push("r.report_date >= ?"); params.push(opts.from); }
  if (opts.to) { clauses.push("r.report_date <= ?"); params.push(opts.to); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  return db.prepare(
    `${SELECT} ${where} ORDER BY r.report_date DESC, r.id DESC LIMIT ${limit}`
  ).all(...params) as ManagerReportRow[];
}

export function getManagerReport(db: Database.Database, id: number): ManagerReportRow | undefined {
  return db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as ManagerReportRow | undefined;
}

/** เพิ่มรายงานใหม่เสมอ (ไม่ทับของเดิม) — 1 คนส่งได้หลายเรื่องต่อวัน (owner
 *  2026-09-03). คืน id. */
export function createManagerReport(db: Database.Database, d: {
  branchId: number | null;
  reportDate: string;
  authorUserId: number;
  shiftSummary: string;
  situation: string;
  meetingTopics: string;
}): number {
  const res = db.prepare(
    `INSERT INTO manager_reports
       (branch_id, report_date, author_user_id, shift_summary, situation, meeting_topics)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(d.branchId, d.reportDate, d.authorUserId, d.shiftSummary, d.situation, d.meetingTopics);
  return Number(res.lastInsertRowid);
}

/** แก้ไขเนื้อหารายงานตาม id (ผู้เรียกตรวจสิทธิ์/PIN มาก่อนแล้ว). */
export function updateManagerReport(db: Database.Database, id: number, d: {
  shiftSummary: string; situation: string; meetingTopics: string;
}): void {
  db.prepare(
    `UPDATE manager_reports
     SET shift_summary = ?, situation = ?, meeting_topics = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(d.shiftSummary, d.situation, d.meetingTopics, id);
}

export function deleteManagerReport(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM manager_reports WHERE id = ?").run(id);
}
