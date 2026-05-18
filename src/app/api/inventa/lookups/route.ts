import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// GET  /api/inventa/lookups          — all active option lists
// GET  /api/inventa/lookups?kind=row — one list
// POST /api/inventa/lookups          — add an option
//
// Global (branch_id NULL) defaults + this branch's own additions.

const Body = z.object({
  kind: z.enum(["row", "storage", "unit", "category"]),
  value: z.string().trim().min(1).max(200),
  sort_order: z.number().int().optional(),
  // null = global (ทุกสาขา); a branch id = that branch only.
  // Omitted → defaults to the caller's active branch (legacy behaviour).
  branch_id: z.number().int().positive().nullable().optional()
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
        WHERE active = 1 AND kind = ? AND (branch_id IS NULL OR branch_id = ?)
        ORDER BY sort_order, value
      `).all(kind, branchId)
    : db.prepare(`
        SELECT * FROM inventa_lookups
        WHERE active = 1 AND (branch_id IS NULL OR branch_id = ?)
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
  // Route is super_admin-only, so an explicit branch_id (incl. null
  // for global) is trusted. When the key is omitted, fall back to the
  // caller's active branch to preserve the previous behaviour.
  const branchId =
    d.branch_id === undefined ? (user.activeBranchId ?? null) : d.branch_id;
  const info = getDb().prepare(`
    INSERT INTO inventa_lookups (branch_id, kind, value, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(branchId, d.kind, d.value.trim(), d.sort_order ?? 100);
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
