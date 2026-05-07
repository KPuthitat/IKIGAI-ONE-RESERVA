import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { computePayrollPeriod } from "@/lib/payroll-compute";

// PATCH /api/admin/persona/payroll/periods/[id] — recompute, finalize, or update notes
// DELETE /api/admin/persona/payroll/periods/[id] — delete (only if draft)

const PatchBody = z.object({
  action: z.enum(["recompute", "finalize", "unfinalize", "update_notes"]),
  notes: z.string().max(500).optional(),
  pay_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const period = db.prepare(`SELECT id, status FROM payroll_periods WHERE id = ?`).get(id) as
    { id: number; status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });

  if (d.action === "recompute") {
    if (period.status !== "draft") {
      return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
    }
    try {
      const r = computePayrollPeriod(db, id);
      db.prepare(`UPDATE payroll_periods SET computed_by = ? WHERE id = ?`).run(user.id, id);
      return NextResponse.json({ ok: true, computed: r.computed });
    } catch (e) {
      return NextResponse.json({ error: "compute_failed", detail: (e as Error).message }, { status: 500 });
    }
  }

  if (d.action === "finalize") {
    if (period.status !== "draft") {
      return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
    }
    db.prepare(`
      UPDATE payroll_periods
      SET status = 'finalized', finalized_by = ?, finalized_at = ?
      WHERE id = ?
    `).run(user.id, new Date().toISOString(), id);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "unfinalize") {
    if (period.status !== "finalized") {
      return NextResponse.json({ error: "must_be_finalized" }, { status: 400 });
    }
    db.prepare(`
      UPDATE payroll_periods
      SET status = 'draft', finalized_by = NULL, finalized_at = NULL
      WHERE id = ?
    `).run(id);
    return NextResponse.json({ ok: true });
  }

  if (d.action === "update_notes") {
    const fields: string[] = [];
    const vals: Array<string | number> = [];
    if ("notes" in d) { fields.push("notes = ?"); vals.push(d.notes ?? ""); }
    if ("pay_date" in d) { fields.push("pay_date = ?"); vals.push(d.pay_date!); }
    if (fields.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
    vals.push(id);
    db.prepare(`UPDATE payroll_periods SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "unknown_action" }, { status: 400 });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const db = getDb();
  const period = db.prepare(`SELECT id, status FROM payroll_periods WHERE id = ?`).get(id) as
    { id: number; status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft_to_delete" }, { status: 400 });
  }

  // Cascade deletes lines automatically due to ON DELETE CASCADE
  db.prepare(`DELETE FROM payroll_periods WHERE id = ?`).run(id);
  return NextResponse.json({ ok: true });
}
