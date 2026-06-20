import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { requirePermission } from "@/lib/auth";
import { ExpenseBody, toExpenseInput } from "@/lib/accounta-validate";
import { getExpense, updateExpense, deleteExpense } from "@/lib/accounta-db";

// PATCH  /api/accounta/expenses/[id] — edit a bill
// DELETE /api/accounta/expenses/[id] — remove a bill (+ its receipt file)

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!getExpense(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = ExpenseBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const ok = updateExpense(id, toExpenseInput(parsed.data));
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const { ok, paths } = deleteExpense(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  for (const p of paths) { try { await fs.unlink(p); } catch { /* already gone */ } }
  return NextResponse.json({ ok: true });
}
