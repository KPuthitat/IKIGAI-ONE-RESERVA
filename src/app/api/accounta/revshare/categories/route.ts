import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isRevshareBranch, getPartner, partnerCategorySales } from "@/lib/revshare-db";

// Read-only sales-by-category for a partner over a date range, so the send
// preview can show the exact "ยอดขายแยกตามหมวด" block the LINE card carries
// (owner 2026-09-27: พรีวิวยังไม่โชว์หมวด). Same source as the notify route.

export const dynamic = "force-dynamic";
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  const sp = new URL(req.url).searchParams;
  const partnerId = Number(sp.get("partner"));
  const start = sp.get("start") ?? "";
  const end = sp.get("end") || start;
  if (!Number.isInteger(partnerId) || partnerId <= 0 || !ISO.test(start) || !ISO.test(end)) {
    return NextResponse.json({ error: "invalid_params" }, { status: 400 });
  }
  const partner = getPartner(partnerId, branchId);
  if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, categories: partnerCategorySales(branchId, partner.pos_categories, start, end) });
}
