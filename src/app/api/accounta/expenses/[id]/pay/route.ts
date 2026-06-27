import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { markExpensePaid } from "@/lib/accounta-db";

// POST /api/accounta/expenses/[id]/pay — mark a credit (ค้างชำระ) bill as
// ชำระแล้ว with the cash-out date (owner 2026-06-27). The AP-side mirror of the
// receivables settle action; scoped to the active branch.

function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const Body = z.object({
  paid_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  payment_method: z.string().trim().max(60).nullable().optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  const date = parsed.data.paid_date ?? bkkToday();
  if (date > bkkToday()) {
    return NextResponse.json({ error: "future_date", message: "วันที่จ่ายเป็นอนาคตไม่ได้" }, { status: 400 });
  }

  const ok = markExpensePaid(id, branchId, date, parsed.data.payment_method ?? null);
  if (!ok) return NextResponse.json({ error: "not_found_or_paid" }, { status: 409 });
  return NextResponse.json({ ok: true });
}
