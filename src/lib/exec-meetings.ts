// ประชุมผู้บริหาร + เบี้ยประชุม (owner 2026-09-02).
//
// A distinct module from การประชุม (manager reports, see meetings.ts): an admin
// schedules an after-hours executive meeting and invites specific staff. Only
// invitees may join. Attendance is timed (join → end) OUTSIDE the work clock —
// it never touches time_entries — and pays เบี้ยประชุม at 200 บาท/ชม. pro-rated
// per minute, taxable, folded into ค่าตอบแทน. A per-person meeting_fee_exempt
// flag (on users) drops the fee for execs. This file is the shared data layer
// for the admin management page, the staff join/minutes flow, the AI summary
// and the payroll integration.

import { getDb } from "./db";

// เบี้ยประชุม rate — 200 บาท/ชม., charged per minute (เศษของชั่วโมงคิดเป็นนาที
// เหมือนค่าตอบแทนพาร์ทไทม์). Kept here so the join/end flow and payroll agree.
export const MEETING_FEE_PER_HOUR = 200;

export function meetingFeeForMinutes(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round((MEETING_FEE_PER_HOUR * minutes) / 60 * 100) / 100;
}

export type ExecMeetingStatus = "scheduled" | "active" | "ended" | "closed";

export type ExecMeetingRow = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  title: string;
  meeting_date: string;
  scheduled_at: string | null;
  status: ExecMeetingStatus;
  summarized_at: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
  invitee_count: number;
  joined_count: number;      // how many have joined (attendance rows)
  ended_count: number;       // how many have ended
};

export type ExecMeetingDetail = ExecMeetingRow & {
  ai_summary: string | null;
  ai_checklist: string | null;
  ai_carryover: string | null;
  invitees: Array<{
    user_id: number;
    display_name: string;
    title_prefix: string | null;
    fee_exempt: boolean;
    joined_at: string | null;
    ended_at: string | null;
    minutes: number | null;
    fee_amount: number | null;
    minutes_complete: boolean;  // all four minute fields filled
  }>;
};

const LIST_SQL = `
  SELECT m.id, m.branch_id, b.name AS branch_name, m.title, m.meeting_date,
         m.scheduled_at, m.status, m.summarized_at, m.created_by,
         u.display_name AS created_by_name, m.created_at,
         (SELECT COUNT(*) FROM exec_meeting_invitees i WHERE i.meeting_id = m.id) AS invitee_count,
         (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id) AS joined_count,
         (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id AND a.ended_at IS NOT NULL) AS ended_count
  FROM exec_meetings m
  LEFT JOIN branches b ON b.id = m.branch_id
  LEFT JOIN users u ON u.id = m.created_by
`;

export function listExecMeetings(opts: { status?: ExecMeetingStatus; limit?: number } = {}): ExecMeetingRow[] {
  const db = getDb();
  const where = opts.status ? "WHERE m.status = ?" : "";
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const params = opts.status ? [opts.status, limit] : [limit];
  return db.prepare(
    `${LIST_SQL} ${where} ORDER BY m.meeting_date DESC, m.id DESC LIMIT ?`
  ).all(...params) as ExecMeetingRow[];
}

// Meetings a given staff member is invited to (for the staff-facing menu).
export function listExecMeetingsForUser(userId: number, limit = 60): ExecMeetingRow[] {
  const db = getDb();
  return db.prepare(
    `${LIST_SQL}
     WHERE m.id IN (SELECT meeting_id FROM exec_meeting_invitees WHERE user_id = ?)
     ORDER BY m.meeting_date DESC, m.id DESC LIMIT ?`
  ).all(userId, Math.min(Math.max(limit, 1), 200)) as ExecMeetingRow[];
}

export function isInvited(meetingId: number, userId: number): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM exec_meeting_invitees WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId);
}

function minutesComplete(m: { agenda: string; details: string; suggestions: string; action_plan: string } | undefined): boolean {
  if (!m) return false;
  return [m.agenda, m.details, m.suggestions, m.action_plan].every((s) => (s ?? "").trim().length > 0);
}

export function getExecMeeting(id: number): ExecMeetingDetail | null {
  const db = getDb();
  const m = db.prepare(
    `${LIST_SQL} WHERE m.id = ?`
  ).get(id) as ExecMeetingRow | undefined;
  if (!m) return null;
  const extra = db.prepare(
    "SELECT ai_summary, ai_checklist, ai_carryover FROM exec_meetings WHERE id = ?"
  ).get(id) as { ai_summary: string | null; ai_checklist: string | null; ai_carryover: string | null };

  const invitees = db.prepare(`
    SELECT i.user_id, u.display_name, u.title_prefix,
           COALESCE(u.meeting_fee_exempt, 0) AS fee_exempt,
           a.joined_at, a.ended_at, a.minutes, a.fee_amount,
           mm.agenda, mm.details, mm.suggestions, mm.action_plan
    FROM exec_meeting_invitees i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN exec_meeting_attendance a ON a.meeting_id = i.meeting_id AND a.user_id = i.user_id
    LEFT JOIN exec_meeting_minutes mm ON mm.meeting_id = i.meeting_id AND mm.user_id = i.user_id
    WHERE i.meeting_id = ?
    ORDER BY u.display_name COLLATE NOCASE
  `).all(id) as Array<{
    user_id: number; display_name: string; title_prefix: string | null; fee_exempt: number;
    joined_at: string | null; ended_at: string | null; minutes: number | null; fee_amount: number | null;
    agenda: string | null; details: string | null; suggestions: string | null; action_plan: string | null;
  }>;

  return {
    ...m,
    ...extra,
    invitees: invitees.map((r) => ({
      user_id: r.user_id,
      display_name: r.display_name,
      title_prefix: r.title_prefix,
      fee_exempt: r.fee_exempt === 1,
      joined_at: r.joined_at,
      ended_at: r.ended_at,
      minutes: r.minutes,
      fee_amount: r.fee_amount,
      minutes_complete: minutesComplete(
        r.agenda != null
          ? { agenda: r.agenda ?? "", details: r.details ?? "", suggestions: r.suggestions ?? "", action_plan: r.action_plan ?? "" }
          : undefined
      )
    }))
  };
}

export function createExecMeeting(d: {
  title: string;
  meeting_date: string;
  branch_id: number | null;
  scheduled_at?: string | null;
  invitee_user_ids: number[];
  created_by: number;
}): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO exec_meetings (branch_id, title, meeting_date, scheduled_at, status, created_by)
       VALUES (?, ?, ?, ?, 'scheduled', ?)`
    ).run(d.branch_id, d.title.trim(), d.meeting_date, d.scheduled_at ?? null, d.created_by);
    const meetingId = Number(info.lastInsertRowid);
    setInvitees(meetingId, d.invitee_user_ids);
    return meetingId;
  });
  return tx();
}

// Replace the invitee set. Never removes an invitee who already has attendance
// (they've joined — dropping them would orphan their minutes/fee).
export function setInvitees(meetingId: number, userIds: number[]): void {
  const db = getDb();
  const uniq = Array.from(new Set(userIds.filter((n) => Number.isInteger(n) && n > 0)));
  const tx = db.transaction(() => {
    const attended = new Set(
      (db.prepare("SELECT user_id FROM exec_meeting_attendance WHERE meeting_id = ?")
        .all(meetingId) as Array<{ user_id: number }>).map((r) => r.user_id)
    );
    // Keep anyone who already joined even if unchecked, plus the new set.
    const keep = new Set<number>([...uniq, ...attended]);
    db.prepare(
      `DELETE FROM exec_meeting_invitees WHERE meeting_id = ?
         AND user_id NOT IN (${keep.size ? Array.from(keep).map(() => "?").join(",") : "-1"})`
    ).run(meetingId, ...Array.from(keep));
    const ins = db.prepare(
      "INSERT OR IGNORE INTO exec_meeting_invitees (meeting_id, user_id) VALUES (?, ?)"
    );
    for (const uid of uniq) ins.run(meetingId, uid);
  });
  tx();
}

export function updateExecMeeting(id: number, d: {
  title?: string;
  meeting_date?: string;
  branch_id?: number | null;
  status?: ExecMeetingStatus;
}): boolean {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.title !== undefined) { sets.push("title = ?"); vals.push(d.title.trim()); }
  if (d.meeting_date !== undefined) { sets.push("meeting_date = ?"); vals.push(d.meeting_date); }
  if (d.branch_id !== undefined) { sets.push("branch_id = ?"); vals.push(d.branch_id); }
  if (d.status !== undefined) { sets.push("status = ?"); vals.push(d.status); }
  if (sets.length === 0) return false;
  vals.push(id);
  return db.prepare(`UPDATE exec_meetings SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

export function deleteExecMeeting(id: number): boolean {
  // Cascades to invitees / attendance / minutes via FK ON DELETE CASCADE.
  return getDb().prepare("DELETE FROM exec_meetings WHERE id = ?").run(id).changes > 0;
}
