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

export function overlaps(
  aStart: number, aDur: number,
  bStart: number, bDur: number
): boolean {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}
