import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";
import { listLineDeductions, addLineDeduction } from "@/lib/payroll-deductions";

// Itemised other-deductions for one payroll line (owner 2026-07-04).
//   GET  → list
//   POST → add { label, amount, admin_pin } (PIN-gated; period must be draft)

const AddBody = z.object({
  label: z.string().trim().min(1).max(80),
  amount: z.number().min(0).max(1e7),
  admin_pin: z.string().optional()
});

function ids(params: { id: string; userId: string }) {
  const periodId = Number(params.id);
  const userId = Number(params.userId);
  return Number.isInteger(periodId) && Number.isInteger(userId) ? { periodId, userId } : null;
}

export async function GET(_req: Request, { params }: { params: { id: string; userId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = ids(params);
  if (!p) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  return NextResponse.json({ ok: true, deductions: listLineDeductions(p.periodId, p.userId) });
}

export async function POST(req: Request, { params }: { params: { id: string; userId: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const p = ids(params);
  if (!p) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = AddBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // PIN gate — deductions change net pay (money) — owner spec 2026-06-02.
  if (!d.admin_pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
  const pin = verifyAdminPin(user.id, d.admin_pin);
  if (!pin.ok) return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });

  const db = getDb();
  const period = db.prepare("SELECT status FROM payroll_periods WHERE id = ?").get(p.periodId) as { status: string } | undefined;
  if (!period) return NextResponse.json({ error: "period_not_found" }, { status: 404 });
  if (period.status !== "draft") return NextResponse.json({ error: "must_be_draft" }, { status: 400 });
  const line = db.prepare("SELECT 1 FROM payroll_lines WHERE period_id = ? AND user_id = ?").get(p.periodId, p.userId);
  if (!line) return NextResponse.json({ error: "line_not_found" }, { status: 404 });

  const id = addLineDeduction(p.periodId, p.userId, d.label, d.amount, user.id);
  logPersonaAction(user.id, "payroll.deduction.add", p.periodId);
  return NextResponse.json({ ok: true, id, deductions: listLineDeductions(p.periodId, p.userId) });
}
