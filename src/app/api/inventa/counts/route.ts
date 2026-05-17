import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/inventa/counts — the current OPEN count session for the
//   branch (or null) + the item_id→counted_qty map so the page can
//   resume a half-done weekly count.
// POST /api/inventa/counts — open a session (reuses an existing open
//   one for the branch so two people counting don't fork it).

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  const count = db.prepare(`
    SELECT * FROM inventa_counts
    WHERE status = 'open' AND (branch_id IS ? OR branch_id = ?)
    ORDER BY id DESC LIMIT 1
  `).get(branchId, branchId) as { id: number; count_date: string } | undefined;

  if (!count) return NextResponse.json({ ok: true, count: null, lines: [] });

  const lines = db.prepare(`
    SELECT item_id, counted_qty FROM inventa_count_lines WHERE count_id = ?
  `).all(count.id);
  return NextResponse.json({ ok: true, count, lines });
}

export async function POST() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const db = getDb();

  const open = db.prepare(`
    SELECT * FROM inventa_counts
    WHERE status = 'open' AND (branch_id IS ? OR branch_id = ?)
    ORDER BY id DESC LIMIT 1
  `).get(branchId, branchId) as { id: number; count_date: string } | undefined;
  if (open) return NextResponse.json({ ok: true, count: open, reused: true });

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const info = db.prepare(`
    INSERT INTO inventa_counts (branch_id, count_date, status, counted_by)
    VALUES (?, ?, 'open', ?)
  `).run(branchId, today, user.id);
  return NextResponse.json({
    ok: true,
    count: { id: Number(info.lastInsertRowid), count_date: today },
    reused: false
  });
}
