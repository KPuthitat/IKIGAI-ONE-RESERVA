import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { listKitchenOrders } from "@/lib/delivera/kitchen";

// Admin (session): live kitchen board for the caller's active branch.
export const dynamic = "force-dynamic";

export async function GET() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDeliveraBranch(user.activeBranchId)) return NextResponse.json({ error: "delivera_disabled" }, { status: 404 });
  return NextResponse.json({ ok: true, orders: listKitchenOrders(user.activeBranchId) });
}
