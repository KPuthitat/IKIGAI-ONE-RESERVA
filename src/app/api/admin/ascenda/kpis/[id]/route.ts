import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH  /api/admin/ascenda/kpis/[id] — update fields on a KPI
// DELETE /api/admin/ascenda/kpis/[id] — remove a KPI + cascade its
//                                        ascenda_results rows.
//
// Special PATCH actions (mutually exclusive — caller picks one):
//   • { reorder: "up" | "down" } — swap display_order with adjacent
//     neighbour. Cheaper than a full reorder API for occasional
//     manual tweaks; for bulk reorder the admin re-saves the rows.
//   • Any field subset from the Body schema — partial update.

const Body = z.object({
  // Reorder (mutually exclusive with field edits — caller passes EITHER
  // this OR the field updates, not both).
  reorder: z.enum(["up", "down"]).optional(),

  // Field updates.
  scope: z.enum(["branch", "company"]).optional(),
  kind: z.enum([
    "attendance_pct", "incident_count", "wrong_order_count",
    "complaint_count", "cog_pct", "col_pct_auto",
    "sales_growth_pct", "manual_number", "manual_pct"
  ]).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  target_value: z.number().finite().nullable().optional(),
  target_op: z.enum(["lte", "gte", "eq"]).nullable().optional(),
  weight: z.number().int().min(1).max(10).optional(),
  active: z.number().int().min(0).max(1).optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
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

  const existing = db.prepare(
    "SELECT id, display_order FROM ascenda_kpis WHERE id = ?"
  ).get(id) as { id: number; display_order: number } | undefined;
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Reorder branch — swap display_order with the adjacent row. Both
  // updates inside a transaction so we never end up with two rows on
  // the same order or a gap.
  if (d.reorder) {
    const dir = d.reorder; // "up" = swap with smaller display_order
    const neighbour = db.prepare(`
      SELECT id, display_order FROM ascenda_kpis
      WHERE display_order ${dir === "up" ? "<" : ">"} ?
      ORDER BY display_order ${dir === "up" ? "DESC" : "ASC"}
      LIMIT 1
    `).get(existing.display_order) as { id: number; display_order: number } | undefined;
    if (!neighbour) {
      // Already at the top/bottom — no-op (return success so the UI
      // doesn't show an error for a harmless edge case).
      return NextResponse.json({ ok: true, swapped: false });
    }
    const tx = db.transaction(() => {
      const upd = db.prepare(
        "UPDATE ascenda_kpis SET display_order = ?, updated_at = ?, updated_by = ? WHERE id = ?"
      );
      const now = new Date().toISOString();
      // Two-step swap via temp negative value to avoid the UNIQUE
      // constraint hitting mid-swap (there isn't one today, but
      // future-proofs against adding one).
      upd.run(-existing.id, now, user.id, existing.id);
      upd.run(existing.display_order, now, user.id, neighbour.id);
      upd.run(neighbour.display_order, now, user.id, existing.id);
    });
    tx();
    logPersonaAction(user.id, "ascenda_kpi.reorder", id);
    return NextResponse.json({ ok: true, swapped: true });
  }

  // Field-edit branch — build dynamic UPDATE so caller can patch a
  // subset without nuking the others.
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  const addField = <K extends keyof typeof d>(key: K, column: string) => {
    if (Object.prototype.hasOwnProperty.call(d, key)) {
      sets.push(`${column} = ?`);
      const v = d[key];
      if (typeof v === "string") {
        vals.push(v.trim() || null);
      } else {
        vals.push(v === undefined ? null : v as number | null);
      }
    }
  };
  addField("scope", "scope");
  addField("kind", "kind");
  addField("title", "title");
  addField("description", "description");
  addField("unit", "unit");
  addField("target_value", "target_value");
  addField("target_op", "target_op");
  addField("weight", "weight");
  addField("active", "active");

  if (sets.length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }
  sets.push("updated_at = ?", "updated_by = ?");
  vals.push(new Date().toISOString(), user.id);
  db.prepare(
    `UPDATE ascenda_kpis SET ${sets.join(", ")} WHERE id = ?`
  ).run(...vals, id);

  logPersonaAction(user.id, "ascenda_kpi.update", id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const existing = db.prepare("SELECT id FROM ascenda_kpis WHERE id = ?").get(id);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // ON DELETE CASCADE on ascenda_results handles the historical
  // rows — caller should warn the user before calling this since
  // those historical scorecards permanently lose this KPI's data.
  db.prepare("DELETE FROM ascenda_kpis WHERE id = ?").run(id);
  logPersonaAction(user.id, "ascenda_kpi.delete", id);

  return NextResponse.json({ ok: true });
}
