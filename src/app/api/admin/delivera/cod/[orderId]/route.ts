import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { settleCod } from "@/lib/delivera/cod";
import { OrderError } from "@/lib/delivera/orders";

// Admin (session): mark one COD order as handed over by the rider.
export const dynamic = "force-dynamic";

export async function POST(_req: Request, { params }: { params: { orderId: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDeliveraBranch(user.activeBranchId)) return NextResponse.json({ error: "delivera_disabled" }, { status: 404 });
  const orderId = Number(params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return NextResponse.json({ error: "bad_order_id" }, { status: 400 });
  try {
    settleCod(orderId, user.activeBranchId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof OrderError) return NextResponse.json({ error: e.code }, { status: 400 });
    return NextResponse.json({ error: "settle_failed", message: (e as Error).message }, { status: 400 });
  }
}
