import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getIncome, updateIncome, deleteIncome } from "@/lib/accounta-db";

const Body = z.object({
  branch_id: z.number().int().positive().nullable().optional(),
  company_id: z.number().int().positive().nullable().optional(),
  income_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  channel: z.string().trim().max(60).nullable().optional(),
  amount: z.number().min(0).max(1e9),
  note: z.string().trim().max(300).nullable().optional(),
  is_vat: z.boolean().optional(),
  is_revenue: z.boolean().optional()
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
    amount: d.amount, note: d.note ?? null,
    is_vat: d.is_vat ?? (existing.is_vat !== 0),
    is_revenue: d.is_revenue ?? (existing.is_revenue !== 0)
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("accounta.manage");
  const id = parseId(params.id);
  if (id == null) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const existing = getIncome(id);
  if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Check-list (shift-close) rows mirror the close report and are normally
  // read-only. Deleting one IS allowed with a valid admin PIN (owner 2026-06-25
  // — e.g. to drop the lump-sum row after re-entering per-channel breakdowns).
  // Note: it reappears if that day is closed again.
  if (existing.source === "shift_close") {
    const pin = new URL(req.url).searchParams.get("pin") || "";
    const status = verifyAdminPin(user.id, pin);
    if (!status.ok) {
      return NextResponse.json(
        { error: "pin_required", message: "ยอดนี้มาจาก Check list หลังเลิกงาน — ใส่ PIN เพื่อยืนยันการลบ" },
        { status: 403 }
      );
    }
  }
  const ok = deleteIncome(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
