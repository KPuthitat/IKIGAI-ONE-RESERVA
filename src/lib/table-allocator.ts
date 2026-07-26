import { getDb, type TableRow, type Booking } from "./db";
import { timeToMinutes, overlaps } from "./time";

export type TableSuggestion = {
  table: TableRow;
  fitScore: number;            // ยิ่งน้อยยิ่งดี (capacity - party_size)
};

/** All table ids occupied during [time, time+duration) on a date — counting a
 *  booking's ANCHOR table (bookings.table_id) AND every merged table it holds
 *  (booking_tables). Without the join, a combined booking's extra tables would
 *  look free and could be double-booked (owner 2026-07-26). */
function occupiedTableIds(db: ReturnType<typeof getDb>, opts: {
  branchId: number; date: string; time: string; durationMinutes: number; excludeBookingId?: number;
}): Set<number> {
  const dayBookings = db.prepare(`
    SELECT id, table_id, booking_time, duration_minutes FROM bookings
     WHERE branch_id = ? AND booking_date = ? AND status IN ('confirmed','seated')
       AND (? IS NULL OR id != ?)
  `).all(opts.branchId, opts.date, opts.excludeBookingId ?? null, opts.excludeBookingId ?? null) as Array<{ id: number; table_id: number | null; booking_time: string; duration_minutes: number }>;

  const newStart = timeToMinutes(opts.time);
  const hits = dayBookings.filter((b) => overlaps(newStart, opts.durationMinutes, timeToMinutes(b.booking_time), b.duration_minutes));
  const busy = new Set<number>();
  for (const b of hits) if (b.table_id != null) busy.add(b.table_id);
  if (hits.length > 0) {
    const ph = hits.map(() => "?").join(",");
    const extra = db.prepare(`SELECT table_id FROM booking_tables WHERE booking_id IN (${ph})`).all(...hits.map((b) => b.id)) as Array<{ table_id: number }>;
    for (const r of extra) busy.add(r.table_id);
  }
  return busy;
}

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

  const busy = occupiedTableIds(db, opts);
  const free = tables.filter((t) => !busy.has(t.id));

  const ranked = free.map((t) => ({
    table: t,
    fitScore: t.capacity - opts.partySize
  }));

  return ranked.slice(0, opts.limit ?? 5);
}

// ── Table combining (owner 2026-07-26) ──────────────────────────────────
// When no single table seats the party, merge ADJACENT tables — consecutive
// sort_order within the same zone (C1+C2 ok, C1+C3 skipping C2 is not). Ranked:
// a single table that fits wins; else the same-zone combo with the least wasted
// seats (fewest tables to break ties); cross-zone is a last resort.

export type TableCombo = {
  tables: TableRow[];
  totalCapacity: number;
  waste: number;          // totalCapacity - partySize
  crossZone: boolean;
};

function cmpCombo(a: TableCombo, b: TableCombo): number {
  if (a.crossZone !== b.crossZone) return a.crossZone ? 1 : -1;   // same-zone first
  const am = a.tables.length > 1 ? 1 : 0, bm = b.tables.length > 1 ? 1 : 0;
  if (am !== bm) return am - bm;                                   // single that fits first
  if (a.waste !== b.waste) return a.waste - b.waste;              // least wasted seats
  return a.tables.length - b.tables.length;                        // fewest tables
}

/** Pure combo builder — `ordered` must already be sorted by (zone, sort_order)
 *  with a `free` flag per table. A booked table breaks a zone's run, so tables
 *  on opposite sides of it never merge (they're not adjacent). */
export function buildCombos(ordered: Array<TableRow & { free: boolean }>, partySize: number): TableCombo[] {
  const byZone = new Map<number | null, Array<TableRow & { free: boolean }>>();
  for (const t of ordered) {
    const list = byZone.get(t.zone_id) ?? byZone.set(t.zone_id, []).get(t.zone_id)!;
    list.push(t);
  }
  const combos: TableCombo[] = [];
  for (const list of byZone.values()) {
    for (let i = 0; i < list.length; i++) {
      if (!list[i].free) continue;
      let cap = 0; const run: TableRow[] = [];
      for (let j = i; j < list.length && list[j].free; j++) {
        cap += list[j].capacity; run.push(list[j]);
        if (cap >= partySize) { combos.push({ tables: [...run], totalCapacity: cap, waste: cap - partySize, crossZone: false }); break; }
      }
    }
  }
  if (combos.length === 0) {
    // Last resort — combine across zones. Never bridge a booked table within a
    // zone (that would seat C1+C3 across an occupied C2), so take at most ONE
    // adjacent free run per zone (its largest), then merge runs across zones.
    const blocks: TableRow[][] = [];
    for (const list of byZone.values()) {
      let best: TableRow[] = [], bestCap = 0;
      for (let i = 0; i < list.length; ) {
        if (!list[i].free) { i++; continue; }
        let cap = 0; const run: TableRow[] = [];
        while (i < list.length && list[i].free) { cap += list[i].capacity; run.push(list[i]); i++; }
        if (cap > bestCap) { bestCap = cap; best = run; }
      }
      if (best.length) blocks.push(best);
    }
    const blockCap = (b: TableRow[]) => b.reduce((s, x) => s + x.capacity, 0);
    blocks.sort((a, b) => blockCap(b) - blockCap(a));
    let cap = 0; const picked: TableRow[] = [];
    for (const b of blocks) { picked.push(...b); cap += blockCap(b); if (cap >= partySize) break; }
    if (cap >= partySize) {
      combos.push({ tables: picked, totalCapacity: cap, waste: cap - partySize, crossZone: new Set(picked.map((t) => t.zone_id)).size > 1 });
    }
  }
  return combos.sort(cmpCombo);
}

/** Suggest seating for a party — single tables and adjacent-table merges. */
export function suggestCombos(opts: {
  branchId: number; date: string; time: string; durationMinutes: number;
  partySize: number; excludeBookingId?: number; limit?: number;
}): TableCombo[] {
  const db = getDb();
  const tables = db.prepare(
    `SELECT t.* FROM tables t LEFT JOIN zones z ON z.id = t.zone_id
      WHERE t.branch_id = ? AND t.active = 1
      ORDER BY COALESCE(z.display_order, 9999), t.zone_id, t.sort_order, t.label, t.id`
  ).all(opts.branchId) as TableRow[];
  if (tables.length === 0) return [];

  const busy = occupiedTableIds(db, opts);
  const ordered = tables.map((t) => ({ ...t, free: !busy.has(t.id) }));
  return buildCombos(ordered, opts.partySize).slice(0, opts.limit ?? 5);
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
  // Free if this table isn't among the tables occupied in the window — anchor
  // OR any merged table (owner 2026-07-26).
  return !occupiedTableIds(db, opts).has(opts.tableId);
}
