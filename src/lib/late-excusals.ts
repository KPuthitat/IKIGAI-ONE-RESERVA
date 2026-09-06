// การขออนุโลมการมาสาย (owner 2026-09-05).
//
// พนักงานที่มาสายด้วยเหตุผลอันสมควร (ติดเรียน เลิกเรียนช้า ประชุมด่วน ฯลฯ) กรอกคำขอ
// อนุโลม → หัวหน้า/แอดมินสาขา หรือ ผู้ดูแลสูงสุด อนุมัติ. วันที่อนุมัติแล้วจะถูกตัดออกจาก
// การนับ "นาทีสาย" ในเกณฑ์ 20% ที่ริบเซอร์วิสชาร์จ (service-charge.ts) แต่ยังเก็บบันทึก
// ไว้เป็นสถิติ. ต่างจาก time_certifications ที่ใช้แก้เวลาที่ลงผิด/ลืมลง — ที่นี่เวลาที่ลง
// ถูกต้อง เพียงแต่ขอ "อนุโลม" ความสาย.

import type Database from "better-sqlite3";
import { effectiveShiftStartForUserDate } from "@/lib/roster";
import { LATE_GRACE_MINUTES } from "@/lib/late-detection";

export type LateExcusalStatus = "pending" | "approved" | "rejected";

export type LateExcusalRow = {
  id: number;
  user_id: number;
  work_date: string;
  branch_id: number | null;
  late_minutes: number;
  reason: string;
  status: LateExcusalStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

function hhmmToMin(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Minutes the user's FIRST clock-in on a date ran past their scheduled shift
 * start (0 when on time / within grace / no schedule / no punch). Mirrors the
 * service-charge lateness rule so the recorded stat matches what would be
 * counted. Uses the day's clock branch when not given.
 */
export function computeLateMinutesForDay(
  db: Database.Database, userId: number, workDate: string, branchId: number | null
): number {
  const firstIn = db.prepare(`
    SELECT ts, branch_id FROM time_entries
    WHERE user_id = ? AND type = 'in' AND ts >= ? AND ts <= ?
    ORDER BY ts ASC LIMIT 1
  `).get(userId, `${workDate}T00:00:00`, `${workDate}T23:59:59`) as { ts: string; branch_id: number | null } | undefined;
  if (!firstIn) return 0;
  const effBranch = branchId ?? firstIn.branch_id;
  if (effBranch == null) return 0;
  const effStart = effectiveShiftStartForUserDate(userId, effBranch, workDate);
  const startMin = hhmmToMin(effStart);
  if (startMin == null) return 0;
  const bkk = new Date(new Date(firstIn.ts).getTime() + 7 * 60 * 60 * 1000);
  const actualMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
  const diff = actualMin - startMin;
  return diff > LATE_GRACE_MINUTES ? diff : 0;
}

/**
 * File (or re-file) a late-arrival excusal for one day. One row per
 * (user, work_date): a pending/rejected row is overwritten (re-submit), but an
 * already-APPROVED day is locked. Returns the row id, or null when locked.
 */
export function createExcusal(
  db: Database.Database, args: { userId: number; workDate: string; branchId: number | null; reason: string }
): { id: number } | { error: "already_approved" } {
  const existing = db.prepare(
    "SELECT id, status FROM late_excusals WHERE user_id = ? AND work_date = ?"
  ).get(args.userId, args.workDate) as { id: number; status: LateExcusalStatus } | undefined;
  if (existing?.status === "approved") return { error: "already_approved" };

  const lateMin = computeLateMinutesForDay(db, args.userId, args.workDate, args.branchId);
  if (existing) {
    db.prepare(`
      UPDATE late_excusals
      SET reason = ?, branch_id = ?, late_minutes = ?, status = 'pending',
          decided_by = NULL, decided_at = NULL, decision_note = NULL, created_at = ?
      WHERE id = ?
    `).run(args.reason.trim(), args.branchId, lateMin, new Date().toISOString(), existing.id);
    return { id: existing.id };
  }
  const r = db.prepare(`
    INSERT INTO late_excusals (user_id, work_date, branch_id, late_minutes, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(args.userId, args.workDate, args.branchId, lateMin, args.reason.trim(), new Date().toISOString());
  return { id: Number(r.lastInsertRowid) };
}

/** Approve / reject a pending excusal. Returns true when a pending row changed. */
export function decideExcusal(
  db: Database.Database, id: number, deciderId: number, approve: boolean, note: string | null
): boolean {
  const r = db.prepare(`
    UPDATE late_excusals
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
    WHERE id = ? AND status = 'pending'
  `).run(approve ? "approved" : "rejected", deciderId, new Date().toISOString(), note, id);
  return r.changes > 0;
}

/** A staffer's own excusals, newest first. */
export function listMyExcusals(db: Database.Database, userId: number, limit = 60): LateExcusalRow[] {
  return db.prepare(
    "SELECT * FROM late_excusals WHERE user_id = ? ORDER BY work_date DESC, id DESC LIMIT ?"
  ).all(userId, limit) as LateExcusalRow[];
}

export type LateExcusalWithName = LateExcusalRow & {
  display_name: string; title_prefix: string | null; branch_name: string | null;
};

/**
 * Pending (and optionally recently decided) excusals for a reviewer. When
 * branchIds is null the caller is a super-admin (all branches); otherwise scope
 * to those branches (an excusal with NULL branch is shown to everyone).
 */
export function listExcusalsForReview(
  db: Database.Database, branchIds: number[] | null, includeDecided = false
): LateExcusalWithName[] {
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
    FROM late_excusals e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN branches b ON b.id = e.branch_id
    WHERE 1=1 ${statusClause} ${branchClause}
    ORDER BY (e.status = 'pending') DESC, e.work_date DESC, e.id DESC
    LIMIT 300
  `).all(...params) as LateExcusalWithName[];
}

/** Count of pending excusals a reviewer can act on (for a nav badge). */
export function pendingExcusalCount(db: Database.Database, branchIds: number[] | null): number {
  if (branchIds != null && branchIds.length === 0) return 0;
  const branchClause = branchIds != null
    ? `AND (branch_id IS NULL OR branch_id IN (${branchIds.map(() => "?").join(",")}))` : "";
  const params = branchIds ?? [];
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM late_excusals WHERE status = 'pending' ${branchClause}`
  ).get(...params) as { c: number }).c;
}

/**
 * Approved-excused dates for a month → Map(userId → Set(YYYY-MM-DD)). The
 * service-charge lateness loop skips these days so an อนุโลม'd late arrival
 * doesn't count toward the 20% forfeiture.
 */
export function approvedExcusedDatesForMonth(
  db: Database.Database, yearMonth: string
): Map<number, Set<string>> {
  const rows = db.prepare(
    "SELECT user_id, work_date FROM late_excusals WHERE status = 'approved' AND substr(work_date,1,7) = ?"
  ).all(yearMonth) as Array<{ user_id: number; work_date: string }>;
  const map = new Map<number, Set<string>>();
  for (const r of rows) {
    let s = map.get(r.user_id);
    if (!s) { s = new Set(); map.set(r.user_id, s); }
    s.add(r.work_date);
  }
  return map;
}
