import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isDeliveraBranch } from "@/lib/delivera/db";
import { listUnsettledCod, codSummary } from "@/lib/delivera/cod";

// Admin (session): unsettled COD (rider cash to hand over) for the active branch.
export const dynamic = "force-dynamic";

export async function GET() {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDeliveraBranch(user.activeBranchId)) return NextResponse.json({ error: "delivera_disabled" }, { status: 404 });
  return NextResponse.json({ ok: true, summary: codSummary(user.activeBranchId), items: listUnsettledCod(user.activeBranchId) });
}
