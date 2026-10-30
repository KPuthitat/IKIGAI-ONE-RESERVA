import { NextResponse } from "next/server";
import { z } from "zod";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { OrderError } from "@/lib/delivera/orders";
import { OPTION_ERROR_TH } from "@/lib/delivera/options";
import { allowGuestOrder, createGuestOrder } from "@/lib/delivera/guest";

// Public (no login): place a walk-in order from the table / counter QR. Prices are recomputed server-side.
export const dynamic = "force-dynamic";

const Body = z.object({
  branch_id: z.number().int().positive(),
  table: z.string().trim().max(20).nullable().optional(),
  name: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  items: z.array(z.object({ menu_item_id: z.number().int().positive(), qty: z.number().int().min(1).max(50), choice_ids: z.array(z.number().int().positive()).max(40).optional() })).min(1).max(40)
});

const ERR: Record<string, string> = {
  menu_item_unavailable: "มีเมนูที่หมดหรือปิดการขายอยู่ในตะกร้า กรุณาลบออกแล้วลองใหม่",
  menu_item_not_found: "ไม่พบเมนูบางรายการ กรุณารีเฟรชหน้า",
  ...OPTION_ERROR_TH
};

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "ข้อมูลการสั่งไม่ถูกต้อง" }, { status: 400 });
  const d = parsed.data;
  if (!isDeliveraBranch(d.branch_id)) return NextResponse.json({ error: "branch_unavailable", message: "สาขานี้ยังไม่เปิดรับออเดอร์" }, { status: 404 });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!allowGuestOrder(ip)) return NextResponse.json({ error: "rate_limited", message: "สั่งถี่เกินไป กรุณารอสักครู่แล้วลองใหม่" }, { status: 429 });
  try {
    const r = createGuestOrder({ branchId: d.branch_id, tableLabel: d.table ?? null, name: d.name ?? null, phone: d.phone ?? null, note: d.note ?? null, items: d.items });
    return NextResponse.json({ ok: true, token: r.token, order_no: r.orderNo, queue_no: r.queueNo, total: r.total });
  } catch (e) {
    if (e instanceof OrderError) return NextResponse.json({ error: e.code, message: ERR[e.code] ?? "สั่งไม่สำเร็จ กรุณาลองใหม่" }, { status: 400 });
    throw e;
  }
}
