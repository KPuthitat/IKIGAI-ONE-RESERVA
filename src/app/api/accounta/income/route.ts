import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listIncome, createIncome, incomeSummary } from "@/lib/accounta-db";

// GET  /api/accounta/income?branch=&company=&month=  — list + channel summary
// POST /api/accounta/income                          — add an income row

const Body = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  income_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  channel: z.string().trim().max(60).nullable().optional(),
  amount: z.number().min(0).max(1e9),
  note: z.string().trim().max(300).nullable().optional()
});

function thisMonth(): string { return new Date().toISOString().slice(0, 7); }

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const url = new URL(req.url);
  const b = url.searchParams.get("branch");
  const branchId = b && /^\d+$/.test(b) ? Number(b) : null;
  const c = url.searchParams.get("company");
  const companyId = c && /^\d+$/.test(c) ? Number(c) : null;
  const month = url.searchParams.get("month") || thisMonth();
  return NextResponse.json({
    ok: true,
    income: listIncome({ branchId, companyId, month }),
    summary: incomeSummary(month, branchId, companyId)
  });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  const id = createIncome(user.id, {
    branch_id: d.branch_id ?? null, company_id: d.company_id ?? null,
    income_date: d.income_date, channel: d.channel ?? null,
    amount: d.amount, note: d.note ?? null
  });
  return NextResponse.json({ ok: true, id });
}
