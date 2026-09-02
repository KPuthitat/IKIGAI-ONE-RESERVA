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

// One วาระ (agenda item) inside a person's minutes: a topic header plus the
// three answer fields. A meeting can also carry preset topic headers (locked)
// the admin sets in advance — every attendee must answer each of them.
export type MinuteItem = { topic: string; details: string; suggestions: string; action_plan: string };

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
  agenda_topics: string[];      // preset วาระ headers the admin set in advance
  invitees: Array<{
    user_id: number;
    display_name: string;
    title_prefix: string | null;
    fee_exempt: boolean;
    joined_at: string | null;
    ended_at: string | null;
    minutes: number | null;
    fee_amount: number | null;
    minutes_complete: boolean;  // every วาระ (locked + own) fully answered
    items: MinuteItem[];        // this person's submitted วาระ
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

export function parseAgendaTopics(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.map((x) => String(x ?? "").trim()).filter((s) => s.length > 0);
  } catch { return []; }
}

function parseItems(raw: string | null | undefined): MinuteItem[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    if (!Array.isArray(a)) return [];
    return a.map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        topic: String(o.topic ?? "").trim(),
        details: String(o.details ?? "").trim(),
        suggestions: String(o.suggestions ?? "").trim(),
        action_plan: String(o.action_plan ?? "").trim()
      };
    });
  } catch { return []; }
}

export type MinutesRow = { items?: string | null; agenda?: string | null; details?: string | null; suggestions?: string | null; action_plan?: string | null };

// A saved minutes row → list of items, falling back to the legacy single-agenda
// columns when the JSON `items` column is empty (rows saved before multi-วาระ).
export function itemsFromRow(row: MinutesRow | undefined): MinuteItem[] {
  if (!row) return [];
  const items = parseItems(row.items);
  if (items.length > 0) return items;
  const agenda = (row.agenda ?? "").trim();
  const details = (row.details ?? "").trim();
  const suggestions = (row.suggestions ?? "").trim();
  const action_plan = (row.action_plan ?? "").trim();
  if (agenda || details || suggestions || action_plan) return [{ topic: agenda, details, suggestions, action_plan }];
  return [];
}

// Split a person's saved items against the meeting's preset (locked) topics:
// each locked topic keeps its saved answers (matched by topic text), and the
// rest are the person's own added วาระ.
export function reconcileMinutes(topics: string[], saved: MinuteItem[]): { locked: MinuteItem[]; extra: MinuteItem[] } {
  const byTopic = new Map<string, MinuteItem>();
  for (const it of saved) if (it.topic && !byTopic.has(it.topic)) byTopic.set(it.topic, it);
  const locked = topics.map((t) => {
    const m = byTopic.get(t);
    return { topic: t, details: m?.details ?? "", suggestions: m?.suggestions ?? "", action_plan: m?.action_plan ?? "" };
  });
  const topicSet = new Set(topics);
  const extra = saved.filter((it) => !topicSet.has(it.topic));
  return { locked, extra };
}

function itemComplete(it: MinuteItem): boolean {
  return [it.topic, it.details, it.suggestions, it.action_plan].every((s) => (s ?? "").trim().length > 0);
}

// Complete = at least one วาระ, and every วาระ (locked + own) fully answered.
function minutesComplete(topics: string[], saved: MinuteItem[]): boolean {
  const { locked, extra } = reconcileMinutes(topics, saved);
  const all = [...locked, ...extra];
  return all.length > 0 && all.every(itemComplete);
}

export function getExecMeeting(id: number): ExecMeetingDetail | null {
  const db = getDb();
  const m = db.prepare(
    `${LIST_SQL} WHERE m.id = ?`
  ).get(id) as ExecMeetingRow | undefined;
  if (!m) return null;
  const extra = db.prepare(
    "SELECT ai_summary, ai_checklist, ai_carryover, agenda_topics FROM exec_meetings WHERE id = ?"
  ).get(id) as { ai_summary: string | null; ai_checklist: string | null; ai_carryover: string | null; agenda_topics: string | null };
  const topics = parseAgendaTopics(extra.agenda_topics);

  const invitees = db.prepare(`
    SELECT i.user_id, u.display_name, u.title_prefix,
           COALESCE(u.meeting_fee_exempt, 0) AS fee_exempt,
           a.joined_at, a.ended_at, a.minutes, a.fee_amount,
           mm.items, mm.agenda, mm.details, mm.suggestions, mm.action_plan
    FROM exec_meeting_invitees i
    JOIN users u ON u.id = i.user_id
    LEFT JOIN exec_meeting_attendance a ON a.meeting_id = i.meeting_id AND a.user_id = i.user_id
    LEFT JOIN exec_meeting_minutes mm ON mm.meeting_id = i.meeting_id AND mm.user_id = i.user_id
    WHERE i.meeting_id = ?
    ORDER BY u.display_name COLLATE NOCASE
  `).all(id) as Array<{
    user_id: number; display_name: string; title_prefix: string | null; fee_exempt: number;
    joined_at: string | null; ended_at: string | null; minutes: number | null; fee_amount: number | null;
    items: string | null; agenda: string | null; details: string | null; suggestions: string | null; action_plan: string | null;
  }>;

  return {
    ...m,
    ai_summary: extra.ai_summary,
    ai_checklist: extra.ai_checklist,
    ai_carryover: extra.ai_carryover,
    agenda_topics: topics,
    invitees: invitees.map((r) => {
      const saved = itemsFromRow(r);
      const { locked, extra: own } = reconcileMinutes(topics, saved);
      return {
        user_id: r.user_id,
        display_name: r.display_name,
        title_prefix: r.title_prefix,
        fee_exempt: r.fee_exempt === 1,
        joined_at: r.joined_at,
        ended_at: r.ended_at,
        minutes: r.minutes,
        fee_amount: r.fee_amount,
        minutes_complete: minutesComplete(topics, saved),
        items: [...locked, ...own]
      };
    })
  };
}

// Normalise a preset-agenda list: trim, drop blanks, cap length/count.
function normalizeTopics(topics: string[] | undefined): string[] {
  if (!Array.isArray(topics)) return [];
  const out: string[] = [];
  for (const t of topics) {
    const s = String(t ?? "").trim().slice(0, 300);
    if (s) out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

export function createExecMeeting(d: {
  title: string;
  meeting_date: string;
  branch_id: number | null;
  scheduled_at?: string | null;
  agenda_topics?: string[];
  invitee_user_ids: number[];
  created_by: number;
}): number {
  const db = getDb();
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO exec_meetings (branch_id, title, meeting_date, scheduled_at, agenda_topics, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`
    ).run(d.branch_id, d.title.trim(), d.meeting_date, d.scheduled_at ?? null,
      JSON.stringify(normalizeTopics(d.agenda_topics)), d.created_by);
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
  agenda_topics?: string[];
  status?: ExecMeetingStatus;
}): boolean {
  const db = getDb();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (d.title !== undefined) { sets.push("title = ?"); vals.push(d.title.trim()); }
  if (d.meeting_date !== undefined) { sets.push("meeting_date = ?"); vals.push(d.meeting_date); }
  if (d.branch_id !== undefined) { sets.push("branch_id = ?"); vals.push(d.branch_id); }
  if (d.agenda_topics !== undefined) { sets.push("agenda_topics = ?"); vals.push(JSON.stringify(normalizeTopics(d.agenda_topics))); }
  if (d.status !== undefined) { sets.push("status = ?"); vals.push(d.status); }
  if (sets.length === 0) return false;
  vals.push(id);
  return db.prepare(`UPDATE exec_meetings SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

export function deleteExecMeeting(id: number): boolean {
  // Cascades to invitees / attendance / minutes via FK ON DELETE CASCADE.
  return getDb().prepare("DELETE FROM exec_meetings WHERE id = ?").run(id).changes > 0;
}

// ── Staff-facing: join / minutes / end (owner 2026-09-02) ────────────────────

// Is the user still on the WORK clock right now? A meeting is after-hours, so
// they must have clocked out of work first. Per-branch pairing (like the clock
// route): a branch with more 'in' than 'out' today = an open work shift.
export function isCurrentlyClockedIn(userId: number): boolean {
  const db = getDb();
  const rows = db.prepare(`
    SELECT branch_id,
           SUM(CASE WHEN type = 'in' THEN 1 ELSE 0 END) AS ins,
           SUM(CASE WHEN type = 'out' THEN 1 ELSE 0 END) AS outs
    FROM time_entries
    WHERE user_id = ? AND date(ts, '+7 hours') = date('now', '+7 hours')
    GROUP BY branch_id
  `).all(userId) as Array<{ branch_id: number | null; ins: number; outs: number }>;
  return rows.some((r) => (r.ins ?? 0) > (r.outs ?? 0));
}

export type StaffMeetingView = {
  id: number;
  title: string;
  meeting_date: string;
  status: ExecMeetingStatus;
  invited: boolean;
  joined_at: string | null;
  ended_at: string | null;
  minutes: number | null;
  fee_amount: number | null;
  // Preset วาระ set by the admin — the topic is locked, this person fills the
  // three answer fields. Their own added วาระ have an editable topic too.
  locked_items: MinuteItem[];
  extra_items: MinuteItem[];
  minutes_complete: boolean;
};

export function getStaffMeetingView(meetingId: number, userId: number): StaffMeetingView | null {
  const db = getDb();
  const m = db.prepare(
    "SELECT id, title, meeting_date, status, agenda_topics FROM exec_meetings WHERE id = ?"
  ).get(meetingId) as { id: number; title: string; meeting_date: string; status: ExecMeetingStatus; agenda_topics: string | null } | undefined;
  if (!m) return null;
  const att = db.prepare(
    "SELECT joined_at, ended_at, minutes, fee_amount FROM exec_meeting_attendance WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId) as { joined_at: string | null; ended_at: string | null; minutes: number | null; fee_amount: number | null } | undefined;
  const mm = db.prepare(
    "SELECT items, agenda, details, suggestions, action_plan FROM exec_meeting_minutes WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId) as MinutesRow | undefined;

  const topics = parseAgendaTopics(m.agenda_topics);
  const saved = itemsFromRow(mm);
  const { locked, extra } = reconcileMinutes(topics, saved);
  return {
    id: m.id, title: m.title, meeting_date: m.meeting_date, status: m.status,
    invited: isInvited(meetingId, userId),
    joined_at: att?.joined_at ?? null,
    ended_at: att?.ended_at ?? null,
    minutes: att?.minutes ?? null,
    fee_amount: att?.fee_amount ?? null,
    locked_items: locked,
    extra_items: extra,
    minutes_complete: minutesComplete(topics, saved)
  };
}

// Join a meeting = a meeting clock-in (NOT a work clock-in). Only an invitee may
// join, only while the meeting is active, only once, and only after clocking out
// of work. Returns an error code (or null on success).
export function joinMeeting(meetingId: number, userId: number): string | null {
  const db = getDb();
  const m = db.prepare("SELECT status FROM exec_meetings WHERE id = ?")
    .get(meetingId) as { status: ExecMeetingStatus } | undefined;
  if (!m) return "not_found";
  if (m.status !== "active") return "meeting_not_active";
  if (!isInvited(meetingId, userId)) return "not_invited";
  if (isCurrentlyClockedIn(userId)) return "still_clocked_in";
  const existing = db.prepare(
    "SELECT ended_at FROM exec_meeting_attendance WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId) as { ended_at: string | null } | undefined;
  if (existing) return existing.ended_at ? "already_ended" : "already_joined";
  db.prepare(
    "INSERT INTO exec_meeting_attendance (meeting_id, user_id, joined_at) VALUES (?, ?, CURRENT_TIMESTAMP)"
  ).run(meetingId, userId);
  return null;
}

// Save a person's minutes as a list of วาระ. The locked topics are owned by the
// meeting (client sends answers only, in order) — the server re-attaches the
// preset topic text so a locked header can't be tampered with. The person's own
// added วาระ carry an editable topic. Empty own-วาระ (blank topic) are dropped.
export function saveMinutes(meetingId: number, userId: number, d: {
  locked_answers: Array<{ details: string; suggestions: string; action_plan: string }>;
  extra_items: MinuteItem[];
}): string | null {
  const db = getDb();
  const att = db.prepare(
    "SELECT ended_at FROM exec_meeting_attendance WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId) as { ended_at: string | null } | undefined;
  if (!att) return "not_joined";
  if (att.ended_at) return "already_ended";

  const topics = parseAgendaTopics(
    (db.prepare("SELECT agenda_topics FROM exec_meetings WHERE id = ?").get(meetingId) as { agenda_topics: string | null } | undefined)?.agenda_topics
  );
  const lockedItems: MinuteItem[] = topics.map((topic, i) => {
    const a = d.locked_answers[i] ?? { details: "", suggestions: "", action_plan: "" };
    return { topic, details: (a.details ?? "").trim(), suggestions: (a.suggestions ?? "").trim(), action_plan: (a.action_plan ?? "").trim() };
  });
  const topicSet = new Set(topics);
  const extraItems: MinuteItem[] = (Array.isArray(d.extra_items) ? d.extra_items : [])
    .map((it) => ({
      topic: String(it.topic ?? "").trim(), details: String(it.details ?? "").trim(),
      suggestions: String(it.suggestions ?? "").trim(), action_plan: String(it.action_plan ?? "").trim()
    }))
    // drop empty own-วาระ, and any that collide with a locked topic (kept above)
    .filter((it) => (it.topic || it.details || it.suggestions || it.action_plan) && !topicSet.has(it.topic));

  const items = JSON.stringify([...lockedItems, ...extraItems]);
  db.prepare(`
    INSERT INTO exec_meeting_minutes (meeting_id, user_id, items, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (meeting_id, user_id) DO UPDATE SET
      items = excluded.items, updated_at = CURRENT_TIMESTAMP
  `).run(meetingId, userId, items);
  return null;
}

// End a meeting = a meeting clock-out. Blocked unless the minutes are complete
// (all four fields). Computes minutes attended + เบี้ยประชุม (0 if the person is
// exempt). Returns { minutes, fee } or an error code.
export function endMeeting(meetingId: number, userId: number): { error: string } | { minutes: number; fee: number } {
  const db = getDb();
  const att = db.prepare(
    "SELECT joined_at, ended_at FROM exec_meeting_attendance WHERE meeting_id = ? AND user_id = ?"
  ).get(meetingId, userId) as { joined_at: string; ended_at: string | null } | undefined;
  if (!att) return { error: "not_joined" };
  if (att.ended_at) return { error: "already_ended" };
  const view = getStaffMeetingView(meetingId, userId);
  if (!view?.minutes_complete) return { error: "minutes_incomplete" };

  const exempt = (db.prepare("SELECT COALESCE(meeting_fee_exempt, 0) AS x FROM users WHERE id = ?")
    .get(userId) as { x: number } | undefined)?.x === 1;
  const endMs = Date.now();
  const joinMs = new Date(att.joined_at.replace(" ", "T") + (att.joined_at.includes("Z") ? "" : "Z")).getTime();
  const minutes = Math.max(0, Math.round((endMs - joinMs) / 60000));
  const fee = exempt ? 0 : meetingFeeForMinutes(minutes);
  db.prepare(`
    UPDATE exec_meeting_attendance
    SET ended_at = CURRENT_TIMESTAMP, minutes = ?, fee_amount = ?, fee_exempt = ?
    WHERE meeting_id = ? AND user_id = ?
  `).run(minutes, fee, exempt ? 1 : 0, meetingId, userId);
  return { minutes, fee };
}
