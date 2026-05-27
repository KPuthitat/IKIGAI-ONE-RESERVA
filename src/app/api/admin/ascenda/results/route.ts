import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import {
  evaluateStatus,
  getKpi,
  isAutoKind
} from "@/lib/ascenda";

// PUT /api/admin/ascenda/results — manual upsert of a KPI result.
//
// Refuses to overwrite auto-kind rows (those belong to the engine).
// For manual kinds, evaluates pass/fail from the value + the KPI's
// target rule and stores both. Branch-scope rows require a branch_id
// that the caller has access to; company-scope rows leave branch_id
// NULL and require admin role only.

const Body = z.object({
  kpi_id: z.number().int().positive(),
  branch_id: z.number().int().positive().nullable(),
  period_key: z.string().regex(/^\d{4}-\d{2}$/),
  // Owner can clear a row by sending null (sets actual_value = NULL
  // → status = "pending" so the dashboard cell goes back to "—").
  actual_value: z.number().finite().nullable(),
  notes: z.string().max(500).nullable().optional()
});

export async function PUT(req: Request) {
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
  const { kpi_id, branch_id, period_key, actual_value, notes } = parsed.data;

  const kpi = getKpi(kpi_id);
  if (!kpi) return NextResponse.json({ error: "kpi_not_found" }, { status: 404 });
  if (kpi.active !== 1) {
    return NextResponse.json({ error: "kpi_inactive" }, { status: 409 });
  }

  // Auto-kind KPIs belong to the engine. Owner refresh trigger should
  // come from running the calculators, not from a manual write here,
  // otherwise the next page-load engine sweep would overwrite the
  // admin's entry anyway.
  if (isAutoKind(kpi.kind)) {
    return NextResponse.json(
      { error: "kpi_is_auto", message: "เกณฑ์นี้คำนวณอัตโนมัติ — แก้ที่ข้อมูลต้นทาง" },
      { status: 409 }
    );
  }

  // Scope check.
  if (kpi.scope === "branch") {
    if (branch_id == null) {
      return NextResponse.json(
        { error: "branch_required", message: "เกณฑ์ระดับสาขาต้องระบุ branch_id" },
        { status: 400 }
      );
    }
    if (!userHasBranch(user, branch_id)) {
      return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
    }
  } else {
    // company scope — branch_id must be null.
    if (branch_id != null) {
      return NextResponse.json(
        { error: "branch_not_allowed", message: "เกณฑ์ระดับบริษัทต้องไม่ระบุ branch_id" },
        { status: 400 }
      );
    }
  }

  const status = evaluateStatus(actual_value, kpi.target_value, kpi.target_op);
  const now = new Date().toISOString();
  const db = getDb();

  // Look up existing — NULL-aware (NULL ≠ NULL in SQLite UNIQUE).
  const existing = db.prepare(`
    SELECT id FROM ascenda_results
    WHERE kpi_id = ? AND period_key = ?
      ${branch_id == null ? "AND branch_id IS NULL" : "AND branch_id = ?"}
  `).get(...(branch_id == null ? [kpi_id, period_key] : [kpi_id, period_key, branch_id])) as
    | { id: number } | undefined;

  let id: number;
  let created = false;
  if (existing) {
    db.prepare(`
      UPDATE ascenda_results
      SET actual_value = ?, status = ?, notes = ?,
          computed_by_system = 0,
          recorded_by = ?, recorded_at = ?
      WHERE id = ?
    `).run(actual_value, status, notes ?? null, user.id, now, existing.id);
    id = existing.id;
  } else {
    const r = db.prepare(`
      INSERT INTO ascenda_results
        (kpi_id, branch_id, period_key, actual_value, status, notes,
         computed_by_system, recorded_by, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(kpi_id, branch_id, period_key, actual_value, status,
      notes ?? null, user.id, now);
    id = Number(r.lastInsertRowid);
    created = true;
  }

  logPersonaAction(
    user.id,
    created ? "ascenda.result.create" : "ascenda.result.update",
    id
  );

  return NextResponse.json({ ok: true, id, created, status });
}
