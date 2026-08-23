import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { CreditNoteBody, toCreditNoteInput } from "@/lib/accounta-validate";
import { createExpense } from "@/lib/accounta-db";

// POST /api/accounta/expenses/credit-note — record a purchase credit note
// (ใบลดหนี้ฝั่งซื้อ). Stored as a negative accounta_expenses row so it reduces
// expense + input VAT (ภาษีซื้อ) across every ACCOUNTA aggregation. Shared
// across accounta.manage admins.
export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = CreditNoteBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createExpense(user.id, toCreditNoteInput(parsed.data));
  return NextResponse.json({ ok: true, id });
}
