// การขอไม่พัก (ทำงานช่วงพัก) — owner 2026-09-13.
//
// พนักงานที่ไม่ต้องการพักในวันนั้น กดขอ "ทำงานช่วงพัก" ก่อนถึงเวลาพักของวันนั้น →
// หัวหน้า/แอดมินสาขา (หรือผู้ดูแลสูงสุด) อนุมัติ (อนุมัติย้อนหลังได้). วันที่อนุมัติแล้ว
// ระบบเงินเดือนจะ"ไม่หักเวลาพัก" ของวันนั้น เวลาพักที่คืนมาจึงถูกนับเป็นเวลาทำงาน และ
// ส่วนที่เกิน 8 ชม. จะจ่ายเป็นค่าล่วงเวลา (OT) — ทั้งประจำและพาร์ทไทม์. เลียนแบบ
// ot_requests: หนึ่งแถวต่อ (user, วัน) ยื่นซ้ำได้และรีเซ็ตเป็น pending.

import type Database from "better-sqlite3";
import { breakWindowForUserDate } from "@/lib/roster";

export type BreakSkipStatus = "pending" | "approved" | "rejected";

export type BreakSkipRow = {
  id: number;
  user_id: number;
  branch_id: number | null;
  work_date: string;
  break_label: string | null;
  reason: string | null;
  status: BreakSkipStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

/** Today's date + wall-clock minutes in Asia/Bangkok. */
function bkkNow(): { date: string; minutes: number } {
  const b = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return {
    date: b.toISOString().slice(0, 10),
    minutes: b.getUTCHours() * 60 + b.getUTCMinutes()
  };
}

function hhmmToMin(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export type CreateBreakSkipError =
  | "already_approved" | "no_active_branch" | "not_today" | "no_break" | "too_late";

/**
 * File (or re-file) a "work through the break" request for TODAY. Rules:
 *   • work_date must be today (BKK) — you decide before the day's break.
 *   • the day must have a scheduled break window at this branch (else nothing to
 *     skip).
 *   • it must be filed BEFORE that break starts.
 * One row per (user, work_date): a pending/rejected row is overwritten, an
 * already-approved day is locked. Returns the row id or a typed error.
 */
export function createBreakSkipRequest(
  db: Database.Database,
  args: { userId: number; workDate: string; branchId: number | null; reason: string | null }
): { id: number } | { error: CreateBreakSkipError } {
  if (args.branchId == null) return { error: "no_active_branch" };
  const now = bkkNow();
  if (args.workDate !== now.date) return { error: "not_today" };

  const win = breakWindowForUserDate(args.userId, args.branchId, args.workDate);
  if (!win) return { error: "no_break" };
  const breakStartMin = hhmmToMin(win.start);
  if (breakStartMin != null && now.minutes >= breakStartMin) return { error: "too_late" };
  const label = `${win.start}–${win.end}`;

  const existing = db.prepare(
    "SELECT id, status FROM break_skip_requests WHERE user_id = ? AND work_date = ?"
  ).get(args.userId, args.workDate) as { id: number; status: BreakSkipStatus } | undefined;
  if (existing?.status === "approved") return { error: "already_approved" };

  const reason = args.reason?.trim() || null;
  if (existing) {
    db.prepare(`
      UPDATE break_skip_requests
      SET branch_id = ?, break_label = ?, reason = ?, status = 'pending',
          decided_by = NULL, decided_at = NULL, decision_note = NULL, created_at = ?
      WHERE id = ?
    `).run(args.branchId, label, reason, new Date().toISOString(), existing.id);
    return { id: existing.id };
  }
  const r = db.prepare(`
    INSERT INTO break_skip_requests (user_id, branch_id, work_date, break_label, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(args.userId, args.branchId, args.workDate, label, reason, new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

/** Approve / reject a pending request. True when a pending row changed. */
export function decideBreakSkip(
  db: Database.Database, id: number, deciderId: number, approve: boolean, note: string | null
): boolean {
  const r = db.prepare(`
    UPDATE break_skip_requests
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ? AND status = 'pending'
  `).run(approve ? "approved" : "rejected", deciderId, new Date().toISOString(), note, id);
  return r.changes > 0;
}

/** A staffer's own requests, newest first. */
export function listMyBreakSkips(db: Database.Database, userId: number, limit = 60): BreakSkipRow[] {
  return db.prepare(
    "SELECT * FROM break_skip_requests WHERE user_id = ? ORDER BY work_date DESC, id DESC LIMIT ?"
  ).all(userId, limit) as BreakSkipRow[];
}

export type BreakSkipWithName = BreakSkipRow & {
  display_name: string; title_prefix: string | null; branch_name: string | null;
};

/**
 * Pending (and optionally recently decided) requests for a reviewer. null
 * branchIds = super-admin (all branches); otherwise scope to those branches (a
 * NULL-branch row is visible to everyone).
 */
export function listBreakSkipsForReview(
  db: Database.Database, branchIds: number[] | null, includeDecided = false
): BreakSkipWithName[] {
  const statusClause = includeDecided ? "" : "AND e.status = 'pending'";
  let branchClause = "";
  const params: unknown[] = [];
  if (branchIds != null) {
    if (branchIds.length === 0) return [];
    branchClause = `AND (e.branch_id IS NULL OR e.branch_id IN (${branchIds.map(() => "?").join(",")}))`;
    params.push(...branchIds);
  }
  return db.prepare(`
    SELECT e.*, u.display_name, u.title_prefix, b.name AS branch_name
    FROM break_skip_requests e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN branches b ON b.id = e.branch_id
    WHERE 1=1 ${statusClause} ${branchClause}
    ORDER BY (e.status = 'pending') DESC, e.work_date DESC, e.id DESC
    LIMIT 300
  `).all(...params) as BreakSkipWithName[];
}

/** Count of pending requests a reviewer can act on (for a nav badge). */
export function pendingBreakSkipCount(db: Database.Database, branchIds: number[] | null): number {
  if (branchIds != null && branchIds.length === 0) return 0;
  const branchClause = branchIds != null
    ? `AND (branch_id IS NULL OR branch_id IN (${branchIds.map(() => "?").join(",")}))` : "";
  const params = branchIds ?? [];
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM break_skip_requests WHERE status = 'pending' ${branchClause}`
  ).get(...params) as { c: number }).c;
}

// NOTE: the payroll engine reads approved break-skip dates with inline SQL in
// computePayrollPeriod / recomputeLine (same style as ot_requests), so no
// month/range helper lives here.
