import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { ExpenseBody, toExpenseInput } from "@/lib/accounta-validate";
import { listExpenses, createExpense, summarise } from "@/lib/accounta-db";

// GET  /api/accounta/expenses?branch=&month=&status=  — list + month summary
// POST /api/accounta/expenses                          — create one bill
// Shared across accounta.manage admins.

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function GET(req: Request) {
  requirePermission("accounta.manage");
  const url = new URL(req.url);
  const branchRaw = url.searchParams.get("branch");
  const branchId = branchRaw && /^\d+$/.test(branchRaw) ? Number(branchRaw) : null;
  const month = url.searchParams.get("month") || thisMonth();
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw === "paid" || statusRaw === "unpaid" ? statusRaw : null;

  const expenses = listExpenses({ branchId, month, status });
  const summary = summarise(month, branchId);
  return NextResponse.json({ ok: true, expenses, summary });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = ExpenseBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createExpense(user.id, toExpenseInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
