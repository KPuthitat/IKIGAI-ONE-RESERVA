import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, previewSettlement, listRounds, markRoundSent } from "@/lib/revshare-db";
import { revshareSettlementFlex, revshareWeeklyFlex, revshareDailyFlex, revshareDrinkWelfareFlex, notifyRevsharePartner } from "@/lib/revshare-line";
import { postRevshareDailyIncome } from "@/lib/accounta-db";
import { TH_MONTHS_FULL, thaiDate, salesBaseIncludesVat, partnerShopName, salesVat, roundLabel } from "@/lib/revshare";
import { drinkWelfareSummary } from "@/lib/partner-drink-orders";

// Push a sales notification to the partner's LINE group. Three kinds (owner
// 2026-06-23): daily (a day's sales heads-up), weekly (the amount transferred
// back to the shop), settlement (monthly GP). Requires the partner's
// line_group_id + the IKIGAI OS platform OA to be in that group.

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  partner: z.number().int().positive(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  kind: z.enum(["settlement", "weekly", "daily", "drink_welfare"]),
  week_start: z.string().regex(ISO).optional(),
  date: z.string().regex(ISO).optional(),
  pin: z.string().optional()
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
  const { partner: partnerId, year, month, kind, week_start, date, pin } = parsed.data;

  // Daily + weekly sends are PIN-gated (owner 2026-06-24: ตรวจสอบยอดแล้วกด PIN
  // ก่อนส่งเข้ากลุ่ม) — proves the operator verified the figure before it goes
  // out to the partner.
  if (kind === "daily" || kind === "weekly" || kind === "drink_welfare") {
    const status = verifyAdminPin(user.id, pin ?? "");
    if (!status.ok) {
      return NextResponse.json({ error: status.reason }, { status: status.reason === "no_pin" ? 400 : 403 });
    }
  }

  const partner = getPartner(partnerId, branchId);
  if (!partner) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!partner.line_group_id) {
    return NextResponse.json({ error: "no_group", message: "ยังไม่ได้ตั้ง LINE group ของคู่ค้านี้ (ตั้งที่หน้าตั้งค่าคู่ค้า)" }, { status: 400 });
  }
  const preview = previewSettlement(partnerId, branchId, year, month);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const sellerRow = getDb().prepare(
    `SELECT b.name, c.name_th AS company_name FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?`
  ).get(branchId) as { name: string; company_name: string | null };
  const seller = sellerRow.name;
  const monthLabel = `${TH_MONTHS_FULL[month]} ${year + 543}`;
  // Single partner name on the card (owner 2026-07-25) — the POS categories can
  // be many, so they no longer print here (they still map POS rows → partner).
  const shop = partnerShopName(partner);
  const vatRate = partner.vat_enabled ? partner.vat_rate : 0;
  // Pre-VAT figures (gross/after_discount) get VAT added on top; only 'nett'
  // already carries it (owner 2026-07-25).
  const salesIncludesVat = salesBaseIncludesVat(partner.sales_base);

  let flex;
  let dailyRoundId: number | null = null;
  let dailyIncomeAmount: number | null = null;
  if (kind === "daily") {
    if (!date) return NextResponse.json({ error: "date_required" }, { status: 400 });
    const round = listRounds(partnerId, branchId, year, month).find((r) => r.period_start === date);
    if (!round) return NextResponse.json({ error: "day_not_found" }, { status: 404 });
    dailyRoundId = round.id;
    // รวม VAT figure (base × 1.07 for pre-VAT bases; the stored value for nett).
    dailyIncomeAmount = salesVat(round.sales_amount, vatRate, salesIncludesVat).total;
    flex = revshareDailyFlex({ shop, sellerName: seller, dateLabel: thaiDate(date), sales: round.sales_amount, vatRate, salesIncludesVat, billCount: round.bill_count });
  } else if (kind === "weekly") {
    const w = week_start ? preview.breakdown.find((b) => b.start === week_start) : preview.breakdown[preview.breakdown.length - 1];
    if (!w) return NextResponse.json({ error: "week_not_found" }, { status: 404 });
    flex = revshareWeeklyFlex({ shop, sellerName: seller, weekLabel: w.label, transferAmount: w.sales, dayCount: daySpan(w.start, w.end), vatRate, salesIncludesVat });
  } else if (kind === "drink_welfare") {
    // Staff drink welfare read from redemptions (owner 2026-07-30). Period = a
    // week (week_start → +6d) or the whole month (month-end round).
    const mm = String(month).padStart(2, "0");
    const start = week_start ?? `${year}-${mm}-01`;
    const end = week_start
      ? new Date(Date.parse(`${week_start}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10)
      : `${year}-${mm}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
    const sum = drinkWelfareSummary(getDb(), partnerId, start, end);
    if (sum.count === 0) return NextResponse.json({ error: "no_drinks", message: "ช่วงนี้ยังไม่มีการเบิกเครื่องดื่ม" }, { status: 400 });
    const periodLabel = week_start ? roundLabel(start, end) : monthLabel;
    flex = revshareDrinkWelfareFlex({ shop, sellerName: seller, periodLabel, count: sum.count, total: sum.total, vatRate, byTier: sum.byTier, cashCount: sum.cashCount, cashTotal: sum.cashTotal });
  } else {
    const r = preview.result;
    flex = revshareSettlementFlex({
      shop, sellerName: seller, sellerCompany: sellerRow.company_name, partnerName: partner.name, monthLabel,
      totalSales: r.totalSales, tierGP: r.tierGP, floorApplied: r.floorApplied, topup: r.topup,
      billedGP: r.billedGP, avgGpPct: r.avgGpPct,
      vatEnabled: partner.vat_enabled, vatAmount: r.vatAmount, whtAmount: r.whtAmount, netAmount: r.netAmount,
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

  // Mirror the day's sales into the PARTNER's own books — the branch configured
  // as income_branch_id (e.g. ศาลาชิลล์), NOT the selling branch (owner
  // 2026-07-26). NULL = don't auto-post. Best-effort; re-sending re-posts
  // idempotently (delete-then-insert keyed by branch+date+channel).
  let incomePosted = false;
  if (kind === "daily" && dailyRoundId != null) {
    if (partner.income_branch_id != null && dailyIncomeAmount != null && date) {
      try {
        postRevshareDailyIncome({
          branchId: partner.income_branch_id, date, channel: shop,
          amount: dailyIncomeAmount, isVat: partner.vat_enabled, userId: user.id
        });
        incomePosted = true;
      } catch (e) {
        console.error("revshare daily income post failed", e);
      }
    }
    try { markRoundSent(dailyRoundId, partnerId, branchId, user.id); }
    catch (e) { console.error("revshare markRoundSent failed", e); }
  }
  return NextResponse.json({ ok: true, incomePosted });
}
