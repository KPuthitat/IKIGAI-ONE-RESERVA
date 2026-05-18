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
  kind: z.enum(["row", "storage", "unit", "category"]),
  value: z.string().trim().min(1).max(200),
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
  const info = getDb().prepare(`
    INSERT INTO inventa_lookups (branch_id, kind, value, sort_order)
    VALUES (?, ?, ?, ?)
  `).run(branchId, d.kind, d.value.trim(), d.sort_order ?? 100);
  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
