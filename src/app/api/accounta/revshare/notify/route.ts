import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, previewSettlement } from "@/lib/revshare-db";
import { revshareSettlementFlex, revshareWeeklyFlex, notifyRevsharePartner } from "@/lib/revshare-line";
import { TH_MONTHS_FULL } from "@/lib/revshare";

// Push a GP card to the partner's LINE group. kind = settlement (monthly) or
// weekly (one week's transfer). Requires the partner's line_group_id + the
// IKIGAI OS platform OA to be in that group.

const Body = z.object({
  partner: z.number().int().positive(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  kind: z.enum(["settlement", "weekly"]),
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

function daySpan(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isRevshareBranch(branchId)) {
    return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { partner: partnerId, year, month, kind, week_start } = parsed.data;

  const partner = getPartner(partnerId, branchId);
  if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!partner.line_group_id) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้ง LINE group ของคู่ค้านี้ (ตั้งที่หน้าตั้งค่าคู่ค้า)" }, { status: 400 });
  }
  const preview = previewSettlement(partnerId, branchId, year, month);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const seller = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string }).name;
  const monthLabel = `${TH_MONTHS_FULL[month]} ${year + 543}`;

  let flex;
  if (kind === "weekly") {
    const w = week_start ? preview.breakdown.find((b) => b.start === week_start) : preview.breakdown[preview.breakdown.length - 1];
    if (!w) return NextResponse.json({ error: "week_not_found" }, { status: 404 });
    flex = revshareWeeklyFlex({ sellerName: seller, partnerName: partner.name, weekLabel: w.label, transferAmount: w.sales, dayCount: daySpan(w.start, w.end) });
  } else {
    const r = preview.result;
    flex = revshareSettlementFlex({
      sellerName: seller, partnerName: partner.name, venue: partner.venue, monthLabel,
      totalSales: r.totalSales, tierGP: r.tierGP, floorApplied: r.floorApplied, topup: r.topup,
      billedGP: r.billedGP, avgGpPct: r.avgGpPct,
      vatEnabled: partner.vat_enabled, vatAmount: r.vatAmount, whtAmount: r.whtAmount, netAmount: r.netAmount,
      weeks: preview.breakdown.map((b) => ({ label: b.label, sales: b.sales })),
      invoiceNo: preview.stored?.invoice_no ?? null
    });
  }

  const res = await notifyRevsharePartner(partner.line_group_id, flex);
  if (!res.ok) {
    const msg = res.error === "platform_oa_not_configured" ? "ยังไม่ได้ตั้งค่า IKIGAI OS platform OA"
      : res.error === "monthly_quota_exceeded" ? "LINE เกินโควตาข้อความรายเดือนแล้ว"
      : "ส่ง LINE ไม่สำเร็จ";
    return NextResponse.json({ error: res.error ?? "send_failed", message: msg }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
