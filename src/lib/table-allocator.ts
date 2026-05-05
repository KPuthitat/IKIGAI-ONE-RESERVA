import { getDb, type TableRow, type Booking } from "./db";
import { timeToMinutes, overlaps } from "./time";

export type TableSuggestion = {
  table: TableRow;
  fitScore: number;            // ยิ่งน้อยยิ่งดี (capacity - party_size)
};

/**
 * เลือกโต๊ะที่ "เหมาะสม" สำหรับการจองหนึ่งครั้ง
 * - ต้องเป็นโต๊ะที่ active
 * - capacity >= party_size
 * - ไม่ทับเวลากับ booking อื่นที่ confirmed/seated ในช่วงเวลานั้น
 * - จัดอันดับโดย best-fit (capacity ใกล้ party_size ที่สุดมาก่อน)
 * คืนค่าสูงสุด `limit` รายการ
 */
export function suggestTables(opts: {
  branchId: number;
  date: string;             // YYYY-MM-DD
  time: string;             // HH:MM
  durationMinutes: number;
  partySize: number;
  excludeBookingId?: number;
  limit?: number;
}): TableSuggestion[] {
  const db = getDb();
  const tables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? AND active = 1 AND capacity >= ? ORDER BY capacity ASC"
  ).all(opts.branchId, opts.partySize) as TableRow[];

  if (tables.length === 0) return [];

  const dayBookings = db.prepare(`
    SELECT * FROM bookings
    WHERE branch_id = ?
      AND booking_date = ?
      AND status IN ('confirmed','seated')
      AND table_id IS NOT NULL
      AND (? IS NULL OR id != ?)
  `).all(
    opts.branchId,
    opts.date,
    opts.excludeBookingId ?? null,
    opts.excludeBookingId ?? null
  ) as Booking[];

  const newStart = timeToMinutes(opts.time);
  const newDur = opts.durationMinutes;

  const free = tables.filter((t) => {
    const conflicts = dayBookings.filter((b) => b.table_id === t.id);
    return !conflicts.some((b) =>
      overlaps(newStart, newDur, timeToMinutes(b.booking_time), b.duration_minutes)
    );
  });

  const ranked = free.map((t) => ({
    table: t,
    fitScore: t.capacity - opts.partySize
  }));

  return ranked.slice(0, opts.limit ?? 5);
}

/**
 * ตรวจว่าโต๊ะใดโต๊ะหนึ่งว่างในช่วงเวลานั้นหรือเปล่า (ใช้ตอน admin assign manual)
 */
export function isTableFree(opts: {
  branchId: number;
  tableId: number;
  date: string;
  time: string;
  durationMinutes: number;
  excludeBookingId?: number;
}): boolean {
  const db = getDb();
  const conflicts = db.prepare(`
    SELECT * FROM bookings
    WHERE branch_id = ? AND table_id = ? AND booking_date = ?
      AND status IN ('confirmed','seated')
      AND (? IS NULL OR id != ?)
  `).all(
    opts.branchId, opts.tableId, opts.date,
    opts.excludeBookingId ?? null, opts.excludeBookingId ?? null
  ) as Booking[];

  const newStart = timeToMinutes(opts.time);
  return !conflicts.some((b) =>
    overlaps(newStart, opts.durationMinutes, timeToMinutes(b.booking_time), b.duration_minutes)
  );
}
