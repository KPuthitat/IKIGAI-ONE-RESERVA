import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/inventa/lookups          — this branch's option lists
// GET  /api/inventa/lookups?kind=... — one list
// POST /api/inventa/lookups          — add an option (super_admin)
//
// Per-branch only. There is no global/shared scope — every branch
// keeps its own categories / units / storage locations.

const Body = z.object({
  kind: z.enum(["row", "storage", "unit", "category", "item_type"]),
  value: z.string().trim().min(1).max(200),
  /** Short abbreviation shown as the bold first line on the
   *  catalogue + filter chips. Optional — falls back to value. */
  code: z.string().trim().max(12).nullable().optional(),
  sort_order: z.number().int().optional()
});

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const branchId = user.activeBranchId ?? null;
  const db = getDb();
  const kind = new URL(req.url).searchParams.get("kind");

  const rows = kind
    ? db.prepare(`
        SELECT * FROM inventa_lookups
        WHERE active = 1 AND kind = ? AND branch_id = ?
        ORDER BY sort_order, value
      `).all(kind, branchId)
    : db.prepare(`
        SELECT * FROM inventa_lookups
        WHERE active = 1 AND branch_id = ?
        ORDER BY kind, sort_order, value
      `).all(branchId);
  return NextResponse.json({ ok: true, lookups: rows });
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin_only" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  const db = getDb();
  // Auto-assign sort_order if not provided so new rows land below
  // any existing ones of the same kind. Step of 10 leaves headroom
  // for manual ↑↓ moves without needing a global recompact.
  const nextOrder = d.sort_order ?? (() => {
    const row = db.prepare(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM inventa_lookups WHERE branch_id = ? AND kind = ?"
    ).get(branchId, d.kind) as { m: number };
    return (row.m ?? 0) + 10;
  })();
  const info = db.prepare(`
    INSERT INTO inventa_lookups (branch_id, kind, value, code, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `).run(branchId, d.kind, d.value.trim(), d.code?.trim() || null, nextOrder);
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
