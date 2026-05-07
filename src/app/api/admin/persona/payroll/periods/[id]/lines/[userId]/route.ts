import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/persona/payroll/periods/[id]/lines/[userId]
// Manual override of computed values for one employee in one period.
// Only allowed while period is in 'draft' status.

const Body = z.object({
  base_pay: z.number().min(0).optional(),
  ot_pay: z.number().min(0).optional(),
  service_charge: z.number().min(0).optional(),
  other_additions: z.number().min(0).optional(),
  other_deductions: z.number().min(0).optional(),
  notes: z.string().max(500).optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const period = db.prepare(`SELECT status FROM payroll_periods WHERE id = ?`).get(periodId) as
    { status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") {
    return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  }

  const line = db.prepare(`
    SELECT base_pay, ot_pay, service_charge, other_additions, other_deductions,
           sso_amount, tax_amount
    FROM payroll_lines WHERE period_id = ? AND user_id = ?
  `).get(periodId, userId) as {
    base_pay: number; ot_pay: number; service_charge: number;
    other_additions: number; other_deductions: number;
    sso_amount: number; tax_amount: number;
  } | undefined;
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  // Build new values (use override or fall back to existing)
  const basePay = d.base_pay ?? line.base_pay;
  const otPay = d.ot_pay ?? line.ot_pay;
  const svcCharge = d.service_charge ?? line.service_charge;
  const otherAdd = d.other_additions ?? line.other_additions;
  const otherDed = d.other_deductions ?? line.other_deductions;

  // Recompute gross + net (keep sso/tax as-is since admin overrides are for additions only)
  const gross = basePay + otPay + svcCharge + otherAdd;
  const net = gross - line.sso_amount - line.tax_amount - otherDed;

  db.prepare(`
    UPDATE payroll_lines
    SET base_pay = ?, ot_pay = ?, service_charge = ?,
        other_additions = ?, other_deductions = ?,
        gross_pay = ?, net_pay = ?,
        notes = COALESCE(?, notes),
        overridden = 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE period_id = ? AND user_id = ?
  `).run(
    basePay, otPay, svcCharge, otherAdd, otherDed,
    Math.round(gross * 100) / 100, Math.round(net * 100) / 100,
    d.notes ?? null,
    periodId, userId
  );

  return NextResponse.json({ ok: true });
}
