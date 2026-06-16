import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/inventa/counts/[id]/prefill
//
// Bulk-fill EVERY un-counted active item in the current weekly-count
// session with that item's current `inventa_items.current_qty`.
// Saves the staff from re-entering numbers that haven't changed since
// last week — they only need to edit lines where the on-hand actually
// drifted (breakage, miscount catch, expiry toss, etc.).
//
// Idempotent + non-destructive:
//   - Items that already have a count_line in this session are NOT
//     touched. The staff's earlier manual entries win — prefill never
//     overwrites work.
//   - prev_qty is snapshotted (same semantics as the per-line route).
//   - inventa_items.current_qty is intentionally NOT updated here
//     because prefilling with the value already equals current_qty —
//     no drift, no audit churn.

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const countId = Number(params.id);
  if (!Number.isInteger(countId) || countId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const count = db.prepare(
    "SELECT id, status, branch_id FROM inventa_counts WHERE id = ?"
  ).get(countId) as { id: number; status: string; branch_id: number | null } | undefined;
  if (!count) return NextResponse.json({ error: "count_not_found" }, { status: 404 });
  if (count.status !== "open") {
    return NextResponse.json({ error: "count_closed" }, { status: 409 });
  }

  // Find every active item that isn't already counted in this session.
  // Branch-scope when the count carries a branch_id (newer counts do);
  // legacy global counts (NULL branch_id) include every active item.
  const missingRows = db.prepare(`
    SELECT i.id, i.current_qty, i.count_mode, i.qty_frac
    FROM inventa_items i
    WHERE i.active = 1
      AND (? IS NULL OR i.branch_id = ? OR i.branch_id IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM inventa_count_lines cl
        WHERE cl.count_id = ? AND cl.item_id = i.id
      )
  `).all(count.branch_id, count.branch_id, countId) as Array<{
    id: number;
    current_qty: number;
    count_mode: string | null;
    qty_frac: number | null;
  }>;

  if (missingRows.length === 0) {
    return NextResponse.json({ ok: true, prefilled: 0 });
  }

  const insert = db.prepare(`
    INSERT INTO inventa_count_lines (count_id, item_id, prev_qty, counted_qty)
    VALUES (?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    let n = 0;
    for (const r of missingRows) {
      // Fractional items keep their on-hand in qty_frac (bottles), not the
      // integer current_qty — snapshot the right field so prefill doesn't
      // stamp a wrong "0 bottles" line.
      const v = r.count_mode === "fractional" ? (r.qty_frac ?? 0) : r.current_qty;
      insert.run(countId, r.id, v, v);
      n += 1;
    }
    return n;
  });
  const prefilled = tx();

  return NextResponse.json({ ok: true, prefilled });
}
