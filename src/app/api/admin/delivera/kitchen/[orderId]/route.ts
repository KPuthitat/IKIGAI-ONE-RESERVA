import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { advanceKitchenOrder, cancelKitchenOrder, confirmOrderSlip } from "@/lib/delivera/kitchen";
import { OrderError } from "@/lib/delivera/orders";

// Admin (session): kitchen action on one order — advance status, confirm a
// queued slip, or cancel. Branch-scoped: the lib rejects an order the caller's
// active branch doesn't own.
export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["advance", "cancel", "confirm_slip"]),
  to: z.enum(["paid", "confirmed", "preparing", "ready"]).optional()
});

export async function POST(req: Request, { params }: { params: { orderId: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDeliveraBranch(user.activeBranchId)) return NextResponse.json({ error: "delivera_disabled" }, { status: 404 });

  const orderId = Number(params.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return NextResponse.json({ error: "bad_order_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  try {
    if (parsed.data.action === "advance") {
      if (!parsed.data.to) return NextResponse.json({ error: "to_required" }, { status: 400 });
      const status = advanceKitchenOrder(orderId, user.activeBranchId, parsed.data.to);
      return NextResponse.json({ ok: true, status });
    }
    if (parsed.data.action === "cancel") {
      return NextResponse.json({ ok: true, status: cancelKitchenOrder(orderId, user.activeBranchId) });
    }
    confirmOrderSlip(orderId, user.activeBranchId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof OrderError) return NextResponse.json({ error: e.code, detail: e.detail }, { status: 400 });
    return NextResponse.json({ error: "action_failed", message: (e as Error).message }, { status: 400 });
  }
}
