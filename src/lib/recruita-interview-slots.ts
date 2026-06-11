// Server-side helpers for RECRUITA self-service interview scheduling.
//
// Flow (owner 2026-06-09):
//   1. Admin defines a pool of bookable 1-hour slots — selected
//      weekdays (e.g. Sat+Sun) × a date range × a daily window
//      (e.g. 12:00–15:00) → generateInterviewSlots() creates one
//      'open' row per hour, skipping any that already exist.
//   2. An applicant whose application reached the 'interview' stage
//      opens the public status page and picks an OPEN slot. Booking is
//      first-come-first-served — a slot another applicant already took
//      shows "ไม่ว่าง".
//
// Concurrency: bookInterviewSlot() commits with a CONDITIONAL update
// (WHERE id=? AND status='open') and checks changes()===1, so two
// applicants racing for the same slot can't both win. better-sqlite3 is
// synchronous + single-threaded, so the read-modify-write is atomic.

import { getDb } from "./db";
import {
  generateSlots, timeToMinutes, minutesToTime, todayBkk, nowBkkMinutes
} from "./time";

export type SlotStatus = "open" | "booked";

export type InterviewSlot = {
  id: number;
  slot_date: string;     // 'YYYY-MM-DD'
  start_time: string;    // 'HH:MM'
  end_time: string;      // 'HH:MM'
  location: string | null;
  status: SlotStatus;
  booked_application_id: number | null;
  booked_at: string | null;
};

/** Admin-list row — joins the booked candidate so the slot board can
 *  show who took each slot. */
export type AdminInterviewSlot = InterviewSlot & {
  applicant_name: string | null;
  position_title: string | null;
};

/** Public booking row — no candidate identity, just whether it's free. */
export type BookableSlot = {
  id: number;
  slot_date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  status: SlotStatus;
};

const ONE_DAY_MS = 86_400_000;
// Safety cap so a fat-fingered date range can't generate a runaway
// number of rows. 200 days × a handful of slots is plenty for a
// hiring round.
const MAX_DAYS = 200;
const SLOT_MINUTES = 60; // owner: "ช่วงเวลาละ 1 ชั่วโมง"

/** Reclaim slots whose linked application was purged (PDPA) — the FK is
 *  ON DELETE SET NULL, so such rows linger as status='booked' with a
 *  NULL application id. Flip them back to 'open' so the slot is usable
 *  again. Cheap; called before every list/availability read. */
function sweepOrphanSlots(): void {
  getDb().prepare(`
    UPDATE recruita_interview_slots
       SET status = 'open', booked_at = NULL
     WHERE status = 'booked' AND booked_application_id IS NULL
  `).run();
}

/** Iterate calendar dates [from, to] inclusive, yielding the ISO date
 *  and its weekday (0=Sun … 6=Sat). UTC math — no DST surprises. */
function* eachDate(from: string, to: string): Generator<{ iso: string; weekday: number }> {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let cur = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  let guard = 0;
  while (cur <= end && guard <= MAX_DAYS) {
    const dt = new Date(cur);
    yield { iso: dt.toISOString().slice(0, 10), weekday: dt.getUTCDay() };
    cur += ONE_DAY_MS;
    guard++;
  }
}

/** Generate open 1-hour slots. Idempotent — INSERT OR IGNORE on the
 *  UNIQUE(slot_date,start_time) means re-running with an overlapping
 *  range never duplicates or clobbers an already-booked slot. */
export function generateInterviewSlots(args: {
  fromDate: string;
  toDate: string;
  weekdays: number[];       // 0=Sun … 6=Sat
  startTime: string;        // 'HH:MM'
  endTime: string;          // 'HH:MM'
  location?: string | null;
  /** Minutes per slot (owner 2026-06-11 — was hard-coded 60). Once any
   *  slot is booked the length is locked to the existing one (see below). */
  slotMinutes?: number;
}): { ok: true; created: number; skipped: number } | { ok: false; error: string } {
  const { fromDate, toDate, weekdays, startTime, endTime } = args;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { ok: false, error: "bad_date" };
  }
  if (fromDate > toDate) return { ok: false, error: "range_reversed" };
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    return { ok: false, error: "no_weekdays" };
  }
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return { ok: false, error: "bad_time" };
  }
  const slotMinutes = Math.round(Number(args.slotMinutes ?? SLOT_MINUTES));
  if (!isFinite(slotMinutes) || slotMinutes < 5 || slotMinutes > 480) {
    return { ok: false, error: "bad_duration" };
  }
  if (timeToMinutes(startTime) + slotMinutes > timeToMinutes(endTime)) {
    return { ok: false, error: "window_too_short" };
  }
  const wkSet = new Set(weekdays.filter((d) => d >= 0 && d <= 6));
  if (wkSet.size === 0) return { ok: false, error: "no_weekdays" };

  const db = getDb();
  // Lock the slot length once anyone has booked (owner 2026-06-11:
  // "ห้ามแก้ไขหลังจากมีผู้ลงนัดมาแล้ว"). Generating MORE slots of the SAME
  // length is still fine (extending the date range); only changing the
  // length is refused so a booked schedule can't become inconsistent.
  const lockedMinutes = bookedSlotMinutes();
  if (lockedMinutes != null && lockedMinutes !== slotMinutes) {
    return { ok: false, error: "duration_locked" };
  }

  const starts = generateSlots(startTime, endTime, slotMinutes);
  const location = (args.location ?? "").trim() || null;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO recruita_interview_slots
      (slot_date, start_time, end_time, location, status)
    VALUES (?, ?, ?, ?, 'open')
  `);
  let created = 0;
  let attempted = 0;
  const tx = db.transaction(() => {
    for (const { iso, weekday } of eachDate(fromDate, toDate)) {
      if (!wkSet.has(weekday)) continue;
      for (const start of starts) {
        const end = minutesToTime(timeToMinutes(start) + slotMinutes);
        attempted++;
        const info = insert.run(iso, start, end, location);
        if (info.changes > 0) created++;
      }
    }
  });
  tx();
  return { ok: true, created, skipped: attempted - created };
}

/** Applicants currently at the 'interview' stage — the ones an admin can
 *  book a slot FOR (owner 2026-06-11: "ลงเวลานัดสัมภาษณ์แทนผู้สมัครได้").
 *  interview_at is their existing booking (null = none yet), so the admin
 *  UI can flag who's already scheduled. */
export type InterviewApplicant = {
  id: number;
  name: string;
  position_title: string | null;
  interview_at: string | null;
};
export function listInterviewStageApplicants(): InterviewApplicant[] {
  return getDb().prepare(`
    SELECT a.id, a.interview_at,
           TRIM(COALESCE(c.title_prefix,'') || ' ' ||
                COALESCE(c.first_name_th,'') || ' ' ||
                COALESCE(c.last_name_th,'')) AS name,
           p.title AS position_title
    FROM recruita_applications a
    JOIN recruita_candidates c ON c.id = a.candidate_id
    JOIN recruita_positions  p ON p.id = a.position_id
    WHERE a.stage = 'interview'
    ORDER BY name COLLATE NOCASE
  `).all() as InterviewApplicant[];
}

/** The slot length (minutes) the schedule is locked to once a booking
 *  exists — derived from any booked slot's start/end. Returns null when no
 *  slot is booked yet (length still freely changeable). Used to gate the
 *  generator + to disable the duration picker in the admin UI. */
export function bookedSlotMinutes(): number | null {
  const row = getDb().prepare(
    "SELECT start_time, end_time FROM recruita_interview_slots WHERE status = 'booked' LIMIT 1"
  ).get() as { start_time: string; end_time: string } | undefined;
  if (!row) return null;
  const mins = timeToMinutes(row.end_time) - timeToMinutes(row.start_time);
  return mins > 0 ? mins : null;
}

/** Slots from today onward, with booked-candidate info — for the admin
 *  board. Past slots are hidden to keep the list focused. */
export function listSlotsForAdmin(): AdminInterviewSlot[] {
  sweepOrphanSlots();
  const today = todayBkk();
  return getDb().prepare(`
    SELECT s.id, s.slot_date, s.start_time, s.end_time, s.location, s.status,
           s.booked_application_id, s.booked_at,
           CASE WHEN a.id IS NULL THEN NULL ELSE
             TRIM(COALESCE(c.title_prefix,'') || ' ' ||
                  COALESCE(c.first_name_th,'') || ' ' ||
                  COALESCE(c.last_name_th,'')) END AS applicant_name,
           p.title AS position_title
    FROM recruita_interview_slots s
    LEFT JOIN recruita_applications a ON a.id = s.booked_application_id
    LEFT JOIN recruita_candidates c   ON c.id = a.candidate_id
    LEFT JOIN recruita_positions  p   ON p.id = a.position_id
    WHERE s.slot_date >= ?
    ORDER BY s.slot_date ASC, s.start_time ASC
  `).all(today) as AdminInterviewSlot[];
}

/** Future bookable slots (open + booked) for the public status page.
 *  Booked ones are returned too so the UI can show them as "ไม่ว่าง"
 *  instead of hiding them (owner: "มีคนเลือกแล้วให้ขึ้นว่าไม่ว่าง"). */
export function listBookableSlots(): BookableSlot[] {
  sweepOrphanSlots();
  const { date: today, minutes } = nowBkkMinutes();
  const nowHHMM = minutesToTime(minutes);
  return getDb().prepare(`
    SELECT id, slot_date, start_time, end_time, location, status
    FROM recruita_interview_slots
    WHERE slot_date > ?
       OR (slot_date = ? AND start_time > ?)
    ORDER BY slot_date ASC, start_time ASC
  `).all(today, today, nowHHMM) as BookableSlot[];
}

export function deleteOpenSlot(slotId: number): { ok: boolean } {
  const info = getDb().prepare(
    "DELETE FROM recruita_interview_slots WHERE id = ? AND status = 'open'"
  ).run(slotId);
  return { ok: info.changes > 0 };
}

export function clearOpenSlots(): { removed: number } {
  const info = getDb().prepare(
    "DELETE FROM recruita_interview_slots WHERE status = 'open'"
  ).run();
  return { removed: info.changes };
}

/** Book a slot for an application. Caller has already verified the
 *  applicant owns the application + that the stage allows booking.
 *  Supports re-booking: any slot the application already holds is freed
 *  first, then the new slot is taken atomically. Returns the naive
 *  Bangkok-local interview datetime on success. */
export function bookInterviewSlot(args: {
  slotId: number;
  applicationId: number;
}): { ok: true; interviewAt: string; location: string | null }
 | { ok: false; error: "not_found" | "slot_taken" } {
  const db = getDb();
  const slot = db.prepare(
    "SELECT id, slot_date, start_time, location, status FROM recruita_interview_slots WHERE id = ?"
  ).get(args.slotId) as
    | { id: number; slot_date: string; start_time: string; location: string | null; status: SlotStatus }
    | undefined;
  if (!slot) return { ok: false, error: "not_found" };
  if (slot.status !== "open") return { ok: false, error: "slot_taken" };

  const interviewAt = `${slot.slot_date}T${slot.start_time}`;
  let won = false;
  const tx = db.transaction(() => {
    // Free any slot this application already booked (re-book path).
    db.prepare(`
      UPDATE recruita_interview_slots
         SET status = 'open', booked_application_id = NULL, booked_at = NULL
       WHERE booked_application_id = ? AND status = 'booked'
    `).run(args.applicationId);
    // Conditional claim — only succeeds if still open (race guard).
    const info = db.prepare(`
      UPDATE recruita_interview_slots
         SET status = 'booked', booked_application_id = ?, booked_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'open'
    `).run(args.applicationId, args.slotId);
    won = info.changes === 1;
    if (!won) return; // rolled back by throwing below
    db.prepare(`
      UPDATE recruita_applications
         SET interview_at = ?, interview_location = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(interviewAt, slot.location, args.applicationId);
  });
  tx();
  if (!won) return { ok: false, error: "slot_taken" };
  return { ok: true, interviewAt, location: slot.location };
}

/** Cancel an application's interview booking (owner 2026-06-11): free any
 *  slot it holds back to 'open' so another applicant can take it, and clear
 *  the booking off the application. Caller has verified the applicant owns
 *  the application. Idempotent — a no-booking application just clears to
 *  the same (null) state. Returns how many slots were released. */
export function cancelInterviewBooking(applicationId: number): { ok: true; freed: number } {
  const db = getDb();
  let freed = 0;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      UPDATE recruita_interview_slots
         SET status = 'open', booked_application_id = NULL, booked_at = NULL
       WHERE booked_application_id = ? AND status = 'booked'
    `).run(applicationId);
    freed = info.changes;
    db.prepare(`
      UPDATE recruita_applications
         SET interview_at = NULL, interview_location = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(applicationId);
  });
  tx();
  return { ok: true, freed };
}
