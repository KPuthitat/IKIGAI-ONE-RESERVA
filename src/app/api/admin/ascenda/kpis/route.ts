import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/ascenda/kpis — create a new KPI definition.
//
// Auth: admin / super_admin only. The KPI catalog is company-wide
// (not branch-scoped at this level — each KPI itself decides via
// `scope` whether it's evaluated per-branch or company-wide), so we
// don't need to filter by user.activeBranchId here.

const Body = z.object({
  scope: z.enum(["branch", "company"]),
  // Kind set (mirrors the union in src/lib/ascenda.ts). Keep this in
  // sync if a new calculator gets added there — the Zod parser would
  // otherwise reject valid kinds silently.
  kind: z.enum([
    "attendance_pct", "incident_count", "wrong_order_count",
    "complaint_count", "cog_pct", "col_pct_auto",
    "sales_growth_pct", "manual_number", "manual_pct"
  ]),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  target_value: z.number().finite().nullable().optional(),
  target_op: z.enum(["lte", "gte", "eq"]).nullable().optional(),
  // Weight 1–10 — a higher cap would let one KPI dominate the
  // weighted score, which defeats the point of having multiple.
  weight: z.number().int().min(1).max(10).default(1),
  active: z.number().int().min(0).max(1).default(1)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const db = getDb();
  // Append at the end of the current order — admin can reorder later.
  const maxOrder = (db.prepare(
    "SELECT COALESCE(MAX(display_order), 0) AS n FROM ascenda_kpis"
  ).get() as { n: number }).n;
  const nextOrder = maxOrder + 1;

  const result = db.prepare(`
    INSERT INTO ascenda_kpis
      (scope, kind, title, description, unit, target_value, target_op,
       weight, display_order, active, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.scope, d.kind, d.title.trim(),
    d.description?.trim() || null,
    d.unit?.trim() || null,
    d.target_value ?? null,
    d.target_op ?? null,
    d.weight,
    nextOrder,
    d.active,
    new Date().toISOString(),
    user.id
  );

  logPersonaAction(user.id, "ascenda_kpi.create", Number(result.lastInsertRowid));

  return NextResponse.json({ ok: true, id: Number(result.lastInsertRowid) });
}
