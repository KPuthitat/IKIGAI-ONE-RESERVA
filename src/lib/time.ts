// Helpers for working with booking times in Asia/Bangkok
// Bookings are stored as date "YYYY-MM-DD" + time "HH:MM" — naive local times.
// We treat them as Bangkok local time (UTC+7) without DST.

export const BKK_OFFSET_MINUTES = 7 * 60;

export function todayBkk(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + BKK_OFFSET_MINUTES * 60_000);
  return bkk.toISOString().slice(0, 10);
}

export function nowBkkMinutes(): { date: string; minutes: number } {
  const now = new Date();
  const bkk = new Date(now.getTime() + BKK_OFFSET_MINUTES * 60_000);
  const date = bkk.toISOString().slice(0, 10);
  const minutes = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
  return { date, minutes };
}

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function bookingStartMs(date: string, time: string): number {
  // Returns the UTC ms for a booking date+time interpreted as Bangkok local
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - BKK_OFFSET_MINUTES * 60_000;
}

export function generateSlots(open: string, close: string, slotMin: number): string[] {
  const start = timeToMinutes(open);
  const end = timeToMinutes(close);
  const slots: string[] = [];
  for (let m = start; m + slotMin <= end; m += slotMin) slots.push(minutesToTime(m));
  return slots;
}

// Inclusive (boundary-touching) overlap: two intervals are considered to
// conflict if they share even a single boundary minute. So [13:30, 15:00]
// and [15:00, 16:30] count as overlapping. Restaurants need turnover time
// between seatings, so back-to-back booking should be blocked by default
// — treat the boundary as conflict, not as breathing room.
export function overlaps(
  aStart: number, aDur: number,
  bStart: number, bDur: number
): boolean {
  return aStart <= bStart + bDur && bStart <= aStart + aDur;
}

// ── Date display helpers ──────────────────────────────────────────────
// Full Thai month names (no abbreviations).
const TH_MONTHS_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];
const EN_MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

/**
 * Format a YYYY-MM-DD string in Thai or English with FULL month name.
 *  - TH: "5 พฤษภาคม 2569" (Buddhist year)
 *  - EN: "5 May 2026"
 */
export function formatLongDate(d: string, lang: "th" | "en"): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || "";
  const [y, m, dd] = d.split("-").map(Number);
  if (lang === "th") {
    return `${dd} ${TH_MONTHS_FULL[m - 1]} ${y + 543}`;
  }
  return `${dd} ${EN_MONTHS_FULL[m - 1]} ${y}`;
}

/** "5 พฤษภาคม" / "5 May" — month + day only */
export function formatMonthDay(d: string, lang: "th" | "en"): string {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return d || "";
  const [, m, dd] = d.split("-").map(Number);
  if (lang === "th") {
    return `${dd} ${TH_MONTHS_FULL[m - 1]}`;
  }
  return `${dd} ${EN_MONTHS_FULL[m - 1]}`;
}

// ── UTC (SQLite) → Bangkok display helpers ───────────────────────────
// SQLite CURRENT_TIMESTAMP / datetime('now') store UTC as
// "YYYY-MM-DD HH:MM:SS" (no timezone suffix). These helpers parse that
// as UTC and render the Bangkok (UTC+7, no DST) wall-clock — so a
// timestamp reads correctly whether it's rendered on the UTC prod
// server OR on a client device in another timezone.

function bkkShift(ts: string | null | undefined): Date | null {
  if (!ts) return null;
  let s = String(ts).trim().replace(" ", "T");
  // Assume UTC when there's no timezone suffix (SQLite's default).
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += "Z";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Shift so the UTC getters now read Bangkok wall-clock.
  return new Date(d.getTime() + BKK_OFFSET_MINUTES * 60_000);
}

/** "YYYY-MM-DD HH:MM" in Bangkok from a UTC SQLite timestamp. */
export function formatBkkDateTime(ts: string | null | undefined): string {
  const d = bkkShift(ts);
  if (!d) return ts ? String(ts) : "";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** "YYYY-MM-DD" in Bangkok — feed into formatLongDate for Thai display. */
export function bkkDateIso(ts: string | null | undefined): string {
  const d = bkkShift(ts);
  return d ? d.toISOString().slice(0, 10) : "";
}

/** "HH:MM" in Bangkok. */
export function bkkHHMM(ts: string | null | undefined): string {
  const d = bkkShift(ts);
  return d ? d.toISOString().slice(11, 16) : "";
}

/** "YYYYMMDD" in Bangkok — the date prefix for an application number. */
export function bkkYmd(ts: string | null | undefined): string {
  const d = bkkShift(ts);
  return d ? d.toISOString().slice(0, 10).replace(/-/g, "") : "";
}

/** Application display number: #YYYYMMDD + a 3-digit same-Thai-day
 *  sequence. e.g. formatApplicationNo("2026-06-01 17:38:00", 1)
 *  → "#20260602001" (that UTC time is 00:38 on 2 Jun in Bangkok). The
 *  daySeq is computed in SQL (count of same-day apps with id ≤ this). */
export function formatApplicationNo(
  submittedAtUtc: string | null | undefined,
  daySeq: number
): string {
  const ymd = bkkYmd(submittedAtUtc);
  const seq = String(Math.max(1, daySeq || 1)).padStart(3, "0");
  return ymd ? `#${ymd}${seq}` : `#${seq}`;
}
