import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getIncome, updateIncome, deleteIncome } from "@/lib/accounta-db";

const Body = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  income_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  channel: z.string().trim().max(60).nullable().optional(),
  amount: z.number().min(0).max(1e9),
  note: z.string().trim().max(300).nullable().optional()
});

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const existing = getIncome(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Shift-close rows mirror branch_daily_revenue — edit the source, not the
  // mirror, or the next close/backfill overwrites it.
  if (existing.source === "shift_close") {
    return NextResponse.json({ error: "auto_row_readonly", message: "ยอดนี้ดึงจากรายงานปิดกะอัตโนมัติ แก้ไขได้ที่ยอดขายรายวัน" }, { status: 409 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  updateIncome(id, {
    branch_id: d.branch_id ?? null, company_id: d.company_id ?? null,
    income_date: d.income_date, channel: d.channel ?? null,
    amount: d.amount, note: d.note ?? null
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const existing = getIncome(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (existing.source === "shift_close") {
    return NextResponse.json({ error: "auto_row_readonly", message: "ยอดนี้ดึงจากรายงานปิดกะอัตโนมัติ ลบไม่ได้" }, { status: 409 });
  }
  const ok = deleteIncome(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
