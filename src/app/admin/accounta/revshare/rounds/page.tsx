import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { isRevshareBranch, getPartner, getTiers, listRounds, listRoundsRange } from "@/lib/revshare-db";
import { projectMonthSales, shopShareStats } from "@/lib/revshare-forecast";
import { listMonth as listShopMonth, listRange as listShopRange } from "@/lib/salesa-db";
import { salesBaseIncludesVat, salesVat } from "@/lib/revshare";
import { drinkWelfareByWeek } from "@/lib/partner-drink-orders";
import RoundsClient from "./RoundsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รอบยอดขาย GP" };

function nowBkk(): { y: number; m: number } {
  const d = new Date(Date.now() + 7 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

export default function RevshareRoundsPage({ searchParams }: { searchParams: { partner?: string; year?: string; month?: string } }) {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  const partnerId = Number(searchParams.partner);
  if (branchId == null || !isRevshareBranch(branchId)) {
    return <div className="card text-sm text-slate-500">ฟีเจอร์นี้ใช้เฉพาะสาขาที่เปิดส่วนแบ่งยอดขาย</div>;
  }
  const partner = partnerId > 0 ? getPartner(partnerId, branchId) : null;
  if (!partner) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับ</Link>
        <div className="card text-sm text-slate-500">ไม่พบคู่ค้า</div>
      </div>
    );
  }
  const now = nowBkk();
  const year = Number(searchParams.year) || now.y;
  const month = Number(searchParams.month) || now.m;
  const sellerName = (getDb().prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string }).name;

  // Whole-month estimate — only for the CURRENT month (a past month is complete,
  // a future one has no run-rate). Display-only: never sent in a card or report.
  let monthForecast: ReturnType<typeof projectMonthSales> = null;
  if (year === now.y && month === now.m) {
    const mm = String(month).padStart(2, "0");
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lookbackStart = new Date(Date.UTC(year, month - 1, 1) - 56 * 86400000).toISOString().slice(0, 10);
    let closed: number[] = [];
    try {
      const raw = (getDb().prepare("SELECT closed_weekdays FROM branches WHERE id = ?").get(branchId) as { closed_weekdays: string | null }).closed_weekdays;
      const a = JSON.parse(raw ?? "[]");
      if (Array.isArray(a)) closed = a.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    } catch { closed = []; }
    monthForecast = projectMonthSales({
      year, month, closedWeekdays: closed,
      history: listRoundsRange(partner.id, branchId, lookbackStart, `${year}-${mm}-${String(dim).padStart(2, "0")}`)
        .map((r) => ({ date: r.period_start, sales: r.sales_amount }))
    });
  }

  // Partner sales as a share of the whole restaurant's sales (owner 2026-10-10): daily,
  // month to date and the month forecast. Both sides VAT-inclusive; display-only.
  const vatRate = partner.vat_enabled ? partner.vat_rate : 0;
  const incl = salesBaseIncludesVat(partner.sales_base);
  const toGross = (amount: number) => salesVat(amount, vatRate, incl).total;
  const shopMonth = listShopMonth(branchId, year, month).map((r) => ({ date: r.sale_date, sales: r.nett }));
  let shopForecastTotal: number | null = null;
  if (monthForecast) {
    const mm2 = String(month).padStart(2, "0");
    const dim2 = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const lb = new Date(Date.UTC(year, month - 1, 1) - 56 * 86400000).toISOString().slice(0, 10);
    let closed2: number[] = [];
    try {
      const a = JSON.parse((getDb().prepare("SELECT closed_weekdays FROM branches WHERE id = ?").get(branchId) as { closed_weekdays: string | null }).closed_weekdays ?? "[]");
      if (Array.isArray(a)) closed2 = a.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6);
    } catch { closed2 = []; }
    shopForecastTotal = projectMonthSales({
      year, month, closedWeekdays: closed2,
      history: listShopRange(branchId, lb, `${year}-${mm2}-${String(dim2).padStart(2, "0")}`).map((r) => ({ date: r.sale_date, sales: r.nett }))
    })?.total ?? null;
  }
  const shopShare = shopShareStats({
    partnerDaily: listRounds(partner.id, branchId, year, month).map((r) => ({ date: r.period_start, sales: toGross(r.sales_amount) })),
    shopDaily: shopMonth,
    partnerForecastTotal: monthForecast ? toGross(monthForecast.total) : null,
    shopForecastTotal
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta/revshare" className="text-sm text-slate-500 hover:text-brand">← กลับรายชื่อคู่ค้า</Link>
        <Link href={`/admin/accounta/revshare/settlement?partner=${partner.id}&year=${year}&month=${month}`} className="text-sm text-brand hover:underline">สรุปยอด / สร้างใบวางบิล →</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รอบยอดขาย · {partner.name}</h1>
        <p className="text-sm text-slate-500 mt-1">นำเข้าไฟล์ยอดขายประจำวัน · ระบบรวมยอดโอนรายสัปดาห์ (จันทร์–อาทิตย์) ให้อัตโนมัติ · ส่วนแบ่งคำนวณรายเดือนที่หน้าสรุปยอด</p>
      </div>
      <RoundsClient
        key={`${partner.id}-${year}-${month}`}
        partner={partner}
        tiers={getTiers(partner.id)}
        rounds={listRounds(partner.id, branchId, year, month)}
        year={year} month={month}
        operatorName={user.display_name}
        sellerName={sellerName}
        drinkWelfare={partner.drink_welfare ? drinkWelfareByWeek(getDb(), partner.id, year, month) : null}
        monthForecast={monthForecast}
        shopShare={shopShare}
      />
    </div>
  );
}
