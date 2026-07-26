import { getDb } from "./db";

// A booking can occupy several merged tables (owner 2026-07-26). bookings.table_id
// is the PRIMARY/anchor table; booking_tables holds the full set (anchor mirrored
// in). These helpers keep the two in sync.

/** Replace a booking's table set. First id becomes the anchor (bookings.table_id);
 *  all ids are written to booking_tables. Empty → unassigned (table_id NULL). */
export function setBookingTables(bookingId: number, tableIds: number[]): void {
  const db = getDb();
  const ids = [...new Set(tableIds.filter((n) => Number.isInteger(n) && n > 0))];
  const anchor = ids[0] ?? null;
  const tx = db.transaction(() => {
    db.prepare("UPDATE bookings SET table_id = ? WHERE id = ?").run(anchor, bookingId);
    db.prepare("DELETE FROM booking_tables WHERE booking_id = ?").run(bookingId);
    const ins = db.prepare("INSERT OR IGNORE INTO booking_tables (booking_id, table_id) VALUES (?, ?)");
    for (const t of ids) ins.run(bookingId, t);
  });
  tx();
}

/** All table ids a booking occupies, anchor first then the rest by table sort_order. */
export function bookingTableIds(bookingId: number): number[] {
  const db = getDb();
  const anchor = (db.prepare("SELECT table_id FROM bookings WHERE id = ?").get(bookingId) as { table_id: number | null } | undefined)?.table_id ?? null;
  const rows = db.prepare(
    `SELECT bt.table_id FROM booking_tables bt
       LEFT JOIN tables t ON t.id = bt.table_id
      WHERE bt.booking_id = ? ORDER BY t.sort_order, bt.table_id`
  ).all(bookingId) as Array<{ table_id: number }>;
  const ordered = rows.map((r) => r.table_id);
  if (anchor != null) return [anchor, ...ordered.filter((id) => id !== anchor)];
  return ordered;
}

/** Merged label for a booking's tables, e.g. "C1+C2" (sorted by sort_order). */
export function bookingTablesLabel(bookingId: number): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT t.label FROM booking_tables bt JOIN tables t ON t.id = bt.table_id
      WHERE bt.booking_id = ? ORDER BY t.sort_order, t.label`
  ).all(bookingId) as Array<{ label: string }>;
  if (rows.length) return rows.map((r) => r.label).join("+");
  // Fall back to the anchor when booking_tables hasn't been populated (legacy).
  const anchor = db.prepare(
    "SELECT t.label FROM bookings b JOIN tables t ON t.id = b.table_id WHERE b.id = ?"
  ).get(bookingId) as { label: string } | undefined;
  return anchor?.label ?? "";
}

/** table_id → [booking table ids] for a set of bookings (for timetable fan-out). */
export function tableIdsByBooking(bookingIds: number[]): Map<number, number[]> {
  const map = new Map<number, number[]>();
  if (bookingIds.length === 0) return map;
  const ph = bookingIds.map(() => "?").join(",");
  const rows = getDb().prepare(
    `SELECT bt.booking_id, bt.table_id FROM booking_tables bt
       LEFT JOIN tables t ON t.id = bt.table_id
      WHERE bt.booking_id IN (${ph}) ORDER BY t.sort_order, bt.table_id`
  ).all(...bookingIds) as Array<{ booking_id: number; table_id: number }>;
  for (const r of rows) {
    const list = map.get(r.booking_id) ?? map.set(r.booking_id, []).get(r.booking_id)!;
    list.push(r.table_id);
  }
  return map;
}
