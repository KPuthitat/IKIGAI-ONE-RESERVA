// Team-tagged daily event notes (owner 2026-09-27: "เพิ่มโน้ตเหตุการณ์รายวัน
// ให้ทีมแท็กเองด้วย"). Free-form context a branch's team pins to a specific day —
// local news, a nearby festival, a road closure, a public event — surfaced in the
// ANALYTICA forward plan and its exec LINE card next to holidays and weather.
//
// Storage: branch_event_notes (schema in db.ts). Several notes per day are
// allowed; each row is deletable on its own. All reads/writes are branch-scoped.

import { getDb } from "./db";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const EVENT_NOTE_MAX = 200;

/** True only for a real calendar date in YYYY-MM-DD form — the regex alone would
 *  admit junk like 2026-02-30, which would insert a row that can never match a
 *  forecast day. Round-trip through Date (UTC) and compare. */
function isRealIsoDate(iso: string): boolean {
  if (!ISO.test(iso)) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

export type EventNote = {
  id: number;
  branchId: number;
  eventDate: string;      // 'YYYY-MM-DD'
  note: string;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
};

type Row = {
  id: number; branch_id: number; event_date: string; note: string;
  created_by: number | null; created_by_name: string | null; created_at: string;
};
const toNote = (r: Row): EventNote => ({
  id: r.id, branchId: r.branch_id, eventDate: r.event_date, note: r.note,
  createdBy: r.created_by, createdByName: r.created_by_name, createdAt: r.created_at,
});

/** All notes for a branch within an inclusive ISO date range, oldest date first
 *  (and, within a day, oldest note first). */
export function listEventNotes(branchId: number, startIso: string, endIso: string): EventNote[] {
  if (!ISO.test(startIso) || !ISO.test(endIso)) return [];
  const rows = getDb().prepare(
    `SELECT n.id, n.branch_id, n.event_date, n.note, n.created_by, n.created_at, u.display_name AS created_by_name
       FROM branch_event_notes n
       LEFT JOIN users u ON u.id = n.created_by
      WHERE n.branch_id = ? AND n.event_date >= ? AND n.event_date <= ?
      ORDER BY n.event_date ASC, n.id ASC`
  ).all(branchId, startIso, endIso) as Row[];
  return rows.map(toNote);
}

/** Note strings grouped by date, for folding into a forecast (no ids needed). */
export function eventNotesByDate(branchId: number, startIso: string, endIso: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of listEventNotes(branchId, startIso, endIso)) {
    (out[n.eventDate] ??= []).push(n.note);
  }
  return out;
}

/** Add a note. Trims and length-caps the text; rejects a blank note or a bad
 *  date. Returns the created row, or null when the input is invalid. */
export function addEventNote(branchId: number, eventDate: string, note: string, userId: number | null): EventNote | null {
  if (!isRealIsoDate(eventDate)) return null;
  const text = note.trim().slice(0, EVENT_NOTE_MAX);
  if (!text) return null;
  const info = getDb().prepare(
    "INSERT INTO branch_event_notes (branch_id, event_date, note, created_by) VALUES (?, ?, ?, ?)"
  ).run(branchId, eventDate, text, userId ?? null);
  const rows = getDb().prepare(
    `SELECT n.id, n.branch_id, n.event_date, n.note, n.created_by, n.created_at, u.display_name AS created_by_name
       FROM branch_event_notes n
       LEFT JOIN users u ON u.id = n.created_by
      WHERE n.id = ?`
  ).get(Number(info.lastInsertRowid)) as Row | undefined;
  return rows ? toNote(rows) : null;
}

/** Delete one note, scoped to its branch so a foreign id can't be removed.
 *  Returns true when a row was actually deleted. */
export function deleteEventNote(branchId: number, id: number): boolean {
  const info = getDb().prepare("DELETE FROM branch_event_notes WHERE id = ? AND branch_id = ?").run(id, branchId);
  return info.changes > 0;
}
