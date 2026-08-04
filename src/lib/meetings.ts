// การประชุม + เชคลิสต์หลังประชุม (owner 2026-08-04).
//
// สรุปการประชุม (meetings) + รายการงานที่ต้องทำต่อ (meeting_action_items) ที่
// มอบหมายรายคนและติดตามสถานะ open/done ได้ เพื่อให้มติที่ประชุม "มีคนทำ" จริง
// ไม่ใช่แค่คุยกันแล้วจบ. Query helper ที่ใช้ร่วมกันระหว่างหน้าแอดมินและหน้าพนักงาน.
import type Database from "better-sqlite3";

export type MeetingRow = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  title: string;
  meeting_date: string;
  summary: string;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  item_count: number;
  open_count: number;
};

export type ActionItemRow = {
  id: number;
  meeting_id: number;
  title: string;
  assignee_user_id: number | null;
  assignee_name: string | null;
  assignee_prefix: string | null;
  due_date: string | null;
  status: "open" | "done";
  done_at: string | null;
  done_by: number | null;
  sort_order: number;
};

export type MyActionItem = ActionItemRow & {
  meeting_title: string;
  meeting_date: string;
};

// รายการประชุม (ใหม่สุดก่อน) พร้อมจำนวน action item + ค้าง. branchId ที่ส่งเข้ามา
// จะรวมประชุมของสาขานั้น + ประชุมระดับบริษัท (branch_id IS NULL). ถ้าไม่ส่ง → ทั้งหมด.
export function listMeetings(db: Database.Database, branchId?: number | null): MeetingRow[] {
  const where = branchId != null ? "WHERE m.branch_id = ? OR m.branch_id IS NULL" : "";
  const params = branchId != null ? [branchId] : [];
  return db.prepare(`
    SELECT m.id, m.branch_id, b.name AS branch_name, m.title, m.meeting_date,
           m.summary, m.created_by, cu.display_name AS created_by_name, m.created_at,
           (SELECT COUNT(*) FROM meeting_action_items ai WHERE ai.meeting_id = m.id) AS item_count,
           (SELECT COUNT(*) FROM meeting_action_items ai WHERE ai.meeting_id = m.id AND ai.status = 'open') AS open_count
    FROM meetings m
    LEFT JOIN branches b ON b.id = m.branch_id
    LEFT JOIN users cu ON cu.id = m.created_by
    ${where}
    ORDER BY m.meeting_date DESC, m.id DESC
    LIMIT 300
  `).all(...params) as MeetingRow[];
}

export function getMeeting(db: Database.Database, id: number): MeetingRow | undefined {
  return db.prepare(`
    SELECT m.id, m.branch_id, b.name AS branch_name, m.title, m.meeting_date,
           m.summary, m.created_by, cu.display_name AS created_by_name, m.created_at,
           (SELECT COUNT(*) FROM meeting_action_items ai WHERE ai.meeting_id = m.id) AS item_count,
           (SELECT COUNT(*) FROM meeting_action_items ai WHERE ai.meeting_id = m.id AND ai.status = 'open') AS open_count
    FROM meetings m
    LEFT JOIN branches b ON b.id = m.branch_id
    LEFT JOIN users cu ON cu.id = m.created_by
    WHERE m.id = ?
  `).get(id) as MeetingRow | undefined;
}

export function listActionItems(db: Database.Database, meetingId: number): ActionItemRow[] {
  return db.prepare(`
    SELECT ai.id, ai.meeting_id, ai.title, ai.assignee_user_id,
           u.display_name AS assignee_name, u.title_prefix AS assignee_prefix,
           ai.due_date, ai.status, ai.done_at, ai.done_by, ai.sort_order
    FROM meeting_action_items ai
    LEFT JOIN users u ON u.id = ai.assignee_user_id
    WHERE ai.meeting_id = ?
    ORDER BY ai.status ASC, ai.sort_order ASC, ai.id ASC
  `).all(meetingId) as ActionItemRow[];
}

// งานที่มอบหมายให้ผู้ใช้คนนี้ (open ก่อน แล้วตามด้วย done ล่าสุด) — สำหรับหน้าพนักงาน.
export function listMyActionItems(db: Database.Database, userId: number): MyActionItem[] {
  return db.prepare(`
    SELECT ai.id, ai.meeting_id, ai.title, ai.assignee_user_id,
           u.display_name AS assignee_name, u.title_prefix AS assignee_prefix,
           ai.due_date, ai.status, ai.done_at, ai.done_by, ai.sort_order,
           m.title AS meeting_title, m.meeting_date AS meeting_date
    FROM meeting_action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    LEFT JOIN users u ON u.id = ai.assignee_user_id
    WHERE ai.assignee_user_id = ?
    ORDER BY ai.status ASC, COALESCE(ai.due_date, '9999-12-31') ASC, ai.id ASC
    LIMIT 200
  `).all(userId) as MyActionItem[];
}

// จำนวนงานค้าง (open) ที่มอบหมายให้ผู้ใช้ — ใช้โชว์ badge บนหน้าแรกพนักงาน.
export function myOpenActionItemCount(db: Database.Database, userId: number): number {
  const r = db.prepare(
    "SELECT COUNT(*) AS c FROM meeting_action_items WHERE assignee_user_id = ? AND status = 'open'"
  ).get(userId) as { c: number };
  return r.c;
}
