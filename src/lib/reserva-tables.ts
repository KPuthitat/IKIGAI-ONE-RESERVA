import type Database from "better-sqlite3";

// Default starter layout for a branch's floor plan: 8 tables in a 4×2 grid,
// T1–T4 seat 2, T5–T6 seat 4, T7–T8 seat 6 — same as scripts/init-db.ts.
//
// Runtime branch creation never seeded tables (only the manual init-db script
// did), so a newly-created branch opened with an empty table picker and its
// bookings couldn't be assigned a table (owner 2026-07-28). Seeding a default
// layout on creation fixes that; the owner edits it in จัดการโต๊ะ afterwards.
//
// Idempotent: seeds only when the branch has NO table rows at all — an
// intentionally-emptied branch (soft-deleted rows) or one with real tables is
// left untouched. Returns the number of tables inserted.
export function seedDefaultTablesIfEmpty(db: Database.Database, branchId: number): number {
  const existing = (db.prepare("SELECT COUNT(*) AS n FROM tables WHERE branch_id = ?")
    .get(branchId) as { n: number }).n;
  if (existing > 0) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tables (branch_id, label, capacity, shape, x, y, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let i = 1;
  let seeded = 0;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const cap = i <= 4 ? 2 : i <= 6 ? 4 : 6;
      const r = insert.run(
        branchId, `T${i}`, cap, cap === 2 ? "round" : "rect",
        60 + col * 130, 60 + row * 130,
        cap === 2 ? 70 : cap === 4 ? 90 : 120,
        cap === 2 ? 70 : cap === 4 ? 90 : 90
      );
      seeded += r.changes;
      i++;
    }
  }
  return seeded;
}
