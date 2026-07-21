import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ledgerDashboard, listExpensesInRange, monthlyTrend, accountaPayables, listCashAccounts, cashAccountsTotal, listIncomeChannels, listCategories, listExpenses, listVendors, listPaymentMethods, materialPurchaseQuota, postDueRecurringExpenses, vendorLastDescriptions, breakEvenAnalysis, type LedgerPeriod, type BreakEvenAnalysis } from "@/lib/accounta-db";
import { salesTargetProgress, type SalesTargetProgress } from "@/lib/sales-target";
import { financialAnalysisEnabled } from "@/lib/financial-analysis";
import { fmtMoney } from "@/lib/format";
import LedgerDashboardClient, { type LedgerExpenseRow } from "./LedgerDashboardClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · บัญชีรายรับรายจ่าย" };

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

const TH_MON_FULL = [
  "", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"
];

// ยอดขายเทียบเป้าเดือนนี้ — a rich progress card mirroring the โควตาสั่งซื้อ
// card's look (gradient, corner artwork, badge, hero number, bar, footer).
// สีเหลืองทองแบรนด์ระหว่างทาง → เขียวเมื่อถึงเป้า. เลข % โชว์ค่าจริง (เกิน 100 ได้).
function SalesTargetCard({ st }: { st: SalesTargetProgress }) {
  const reached = st.monthPct >= 100;
  const fill = Math.min(100, Math.max(0, st.monthPct));
  const remaining = Math.max(0, st.monthlyTarget - st.monthToDateSales);
  const over = Math.max(0, st.monthToDateSales - st.monthlyTarget);
  const [yy, mm] = st.date.split("-").map(Number);

  // Full class-name literals so Tailwind's scanner picks them up.
  const c = reached
    ? {
        border: "border-emerald-200", grad: "from-emerald-50 to-white",
        badge: "bg-emerald-600/10 text-emerald-700", title: "text-emerald-900",
        hero: "text-emerald-700", strong: "text-emerald-700",
        track: "bg-emerald-100", fill: "bg-emerald-500", foot: "text-emerald-800",
        artwork: "text-emerald-100"
      }
    : {
        border: "border-amber-200", grad: "from-amber-50 to-white",
        badge: "bg-amber-600/10 text-amber-700", title: "text-amber-900",
        hero: "text-amber-700", strong: "text-amber-700",
        track: "bg-amber-100", fill: "bg-amber-500", foot: "text-amber-800",
        artwork: "text-amber-100"
      };

  return (
    <div className={`relative overflow-hidden rounded-2xl border ${c.border} bg-gradient-to-br ${c.grad} p-4 sm:p-5 shadow-sm`}>
      {/* decorative artwork — a soft oversized target in the corner */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        className={`pointer-events-none absolute -right-5 -top-5 h-28 w-28 ${c.artwork}`}>
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>

      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${c.badge}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" />
              </svg>
            </span>
            <h2 className={`font-bold ${c.title}`}>ยอดขายเทียบเป้าเดือนนี้</h2>
          </div>
          <span className={`shrink-0 rounded-full border ${c.border} bg-white/70 px-2.5 py-0.5 text-[11px] font-medium ${c.foot}`}>
            {reached ? "ถึงเป้าแล้ว" : `${TH_MON_FULL[mm]} ${yy + 543}`}
          </span>
        </div>

        {/* Hero — the headline % */}
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <span className={`text-4xl font-extrabold tracking-tight tabular-nums ${c.hero}`}>
            {st.monthPct.toLocaleString("th-TH", { maximumFractionDigits: 1 })}%
          </span>
          <span className="text-xs text-slate-500">ของเป้าเดือนนี้</span>
        </div>

        {/* Progress — month-to-date sales vs monthly target */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-slate-500">ทำได้ <span className={`font-semibold ${c.strong}`}>฿{fmtMoney(st.monthToDateSales)}</span></span>
            <span className="text-slate-500">เป้าเดือนนี้ ฿{fmtMoney(st.monthlyTarget)}</span>
          </div>
          <div className={`h-2.5 overflow-hidden rounded-full ${c.track}`}>
            <div className={`h-full rounded-full ${c.fill}`} style={{ width: `${fill}%` }} />
          </div>
          <div className={`mt-1 text-right text-[11px] font-medium ${c.foot}`}>
            {reached ? `เกินเป้า ฿${fmtMoney(over)}` : `เหลืออีก ฿${fmtMoney(remaining)} ถึงเป้า`}
          </div>
        </div>
      </div>
    </div>
  );
}

// จุดคุ้มทุน (break-even) เดือนนี้ (owner 2026-07-19) — "ขายเท่าไหร่จึงเริ่มกำไร".
// เป้า = ต้นทุนคงที่เฉลี่ย/เดือน ÷ (1 − อัตราต้นทุนผันแปร) จากค่าเฉลี่ยตั้งแต่ต้นปี.
// แดง/อำพัน = ยังไม่คุ้มทุน → เขียว = คุ้มทุนแล้ว เริ่มกำไร. Full class-name literals
// ให้ Tailwind scan เจอ (เหมือน SalesTargetCard).
function BreakEvenCard({ be }: { be: BreakEvenAnalysis }) {
  const reached = be.reached;
  const target = be.requiredBreakEven ?? 0;
  const fill = Math.min(100, Math.max(0, be.pct));
  const [yy, mm] = be.date.split("-").map(Number);
  const varPct = (be.ytdVarRatio ?? 0) * 100;

  const c = reached
    ? {
        border: "border-emerald-200", grad: "from-emerald-50 to-white",
        badge: "bg-emerald-600/10 text-emerald-700", title: "text-emerald-900",
        hero: "text-emerald-700", strong: "text-emerald-700",
        track: "bg-emerald-100", fill: "bg-emerald-500", foot: "text-emerald-800",
        artwork: "text-emerald-100"
      }
    : {
        border: "border-rose-200", grad: "from-rose-50 to-white",
        badge: "bg-rose-600/10 text-rose-700", title: "text-rose-900",
        hero: "text-rose-700", strong: "text-rose-700",
        track: "bg-rose-100", fill: "bg-rose-500", foot: "text-rose-800",
        artwork: "text-rose-100"
      };

  return (
    <div className={`relative overflow-hidden rounded-2xl border ${c.border} bg-gradient-to-br ${c.grad} p-4 sm:p-5 shadow-sm`}>
      {/* decorative artwork — a soft balance/scale in the corner */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        className={`pointer-events-none absolute -right-5 -top-5 h-28 w-28 ${c.artwork}`}>
        <path d="M12 3v18M3 21h18M6 7l-3 6h6l-3-6zM18 7l-3 6h6l-3-6zM12 5l6 2M12 5L6 7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      <div className="relative">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={`inline-flex h-7 w-7 items-center justify-center rounded-lg ${c.badge}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v18M4 21h16M6 8l-2.5 5h5L6 8zM18 8l-2.5 5h5L18 8zM12 6l6 2M12 6L6 8" />
              </svg>
            </span>
            <h2 className={`font-bold ${c.title}`}>จุดคุ้มทุนเดือนนี้</h2>
          </div>
          <span className={`shrink-0 rounded-full border ${c.border} bg-white/70 px-2.5 py-0.5 text-[11px] font-medium ${c.foot}`}>
            {reached ? "คุ้มทุนแล้ว" : `${TH_MON_FULL[mm]} ${yy + 543}`}
          </span>
        </div>

        {/* Hero — ยอดขายที่ต้องทำให้ถึงเพื่อเริ่มกำไร */}
        <div className="mt-3 flex items-baseline gap-2 flex-wrap">
          <span className={`text-4xl font-extrabold tracking-tight tabular-nums ${c.hero}`}>
            ฿{fmtMoney(target)}
          </span>
          <span className="text-xs text-slate-500">ต้องขายให้ถึงเดือนนี้จึงเริ่มกำไร</span>
        </div>

        {/* Progress — ยอดขายเดือนนี้เทียบจุดคุ้มทุน */}
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-slate-500">ขายแล้ว <span className={`font-semibold ${c.strong}`}>฿{fmtMoney(be.monthSales)}</span></span>
            <span className="text-slate-500">คิดเป็น {be.pct.toLocaleString("th-TH", { maximumFractionDigits: 1 })}% ของจุดคุ้มทุน</span>
          </div>
          <div className={`h-2.5 overflow-hidden rounded-full ${c.track}`}>
            <div className={`h-full rounded-full ${c.fill}`} style={{ width: `${fill}%` }} />
          </div>
          <div className={`mt-1 text-right text-[11px] font-medium ${c.foot}`}>
            {reached
              ? `กำไรแล้ว ฿${fmtMoney(be.over)}`
              : `เหลืออีก ฿${fmtMoney(be.remaining)} · เฉลี่ยวันละ ฿${fmtMoney(be.perDayNeeded)} (อีก ${be.remainingDays} วัน)`}
          </div>
        </div>

        {/* ฐานการคำนวณ + ประมาณการทั้งเดือน */}
        <div className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-500 space-y-0.5">
          <div>
            ฐาน: ต้นทุนคงที่เฉลี่ย <span className="font-medium text-slate-600">฿{fmtMoney(be.avgMonthlyFixed)}/เดือน</span>
            {" · "}ต้นทุนผันแปร <span className="font-medium text-slate-600">{varPct.toLocaleString("th-TH", { maximumFractionDigits: 1 })}%</span> ของยอดขาย
            {" "}(เฉลี่ยตั้งแต่ต้นปี {be.monthsWithData} เดือน)
          </div>
          {be.forecast != null && !reached && (
            <div className={be.forecastReachesBreakEven ? "text-emerald-600" : "text-rose-600"}>
              ประมาณการทั้งเดือน ฿{fmtMoney(be.forecast)} — {be.forecastReachesBreakEven ? "คาดว่าจะคุ้มทุน" : "ตามจังหวะนี้ยังไม่ถึงจุดคุ้มทุน"}
            </div>
          )}
          {/* รายละเอียดหมวดคงที่/ผันแปรถูกย่อออก (owner 2026-07-21) — คงที่/ผันแปรตั้งได้ราย
              รายการที่หน้ารายจ่ายแล้ว. เหลือเตือนกรณีเงินเดือนยังไม่เข้าบัญชี. */}
          {!be.hasLaborCost && (
            <div className="text-rose-600 font-medium">
              ยังไม่มีเงินเดือนในบัญชี (ต้องปิดรอบ payroll ก่อน) — จุดคุ้มทุนจะต่ำกว่าจริง
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// บัญชีรายรับรายจ่าย — single-branch financial dashboard (owner 2026-06-20):
// revenue/expense/net, ภาษีซื้อ-ขาย-ภพ.30, per-category %, daily averages,
// month forecast. Branch = the session's active branch. Period week/month/year.
export default function DaybookPage({
  searchParams
}: { searchParams: { period?: string; anchor?: string } }) {
  const user = requirePermission("accounta.manage");
  const period: LedgerPeriod = ["week", "month", "year"].includes(searchParams.period ?? "")
    ? (searchParams.period as LedgerPeriod) : "month";
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.anchor ?? "") ? searchParams.anchor! : todayBkk();
  const branchId = user.activeBranchId ?? null;

  if (branchId == null) {
    return (
      <div className="space-y-4">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
        <div className="card text-sm text-slate-500">กรุณาเลือกสาขาที่มุมบนซ้ายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>
      </div>
    );
  }

  // Catch-up: post any due recurring expenses so they appear here even if the
  // cron hasn't fired yet (owner 2026-07-04 — "ตั้งแล้วไม่ขึ้น"). Idempotent, so
  // it's safe to run on every view; the cron still handles this too.
  try { postDueRecurringExpenses(todayBkk()); } catch { /* never block the page */ }

  const db = getDb();
  const branch = db.prepare("SELECT name, company_id FROM branches WHERE id = ?").get(branchId) as { name: string; company_id: number | null } | undefined;
  // Company weekly รอบจ่าย day (0=Sun..6=Sat, default จันทร์) — drives the
  // "ตามรอบบริษัท" due-date default for credit bills (owner 2026-06-27).
  const payCycleWeekday = branch?.company_id != null
    ? ((db.prepare("SELECT pay_cycle_weekday AS w FROM companies WHERE id = ?").get(branch.company_id) as { w: number } | undefined)?.w ?? 1)
    : 1;
  const dash = ledgerDashboard(branchId, period, anchor);
  const trendYear = Number(anchor.slice(0, 4));
  const monthly = monthlyTrend(branchId, trendYear);
  const payables = accountaPayables(branchId);
  const cashAccounts = listCashAccounts(branchId).map((a) => ({
    id: a.id, name: a.name, type: a.type, bank_label: a.bank_label,
    balance: a.balance, balance_as_of: a.balance_as_of, company_wide: a.branch_id == null
  }));
  const cashTotal = cashAccountsTotal(branchId);
  const incomeChannels = listIncomeChannels(branchId);
  const expenseCategories = listCategories().map((c) => ({ code: c.code, name: c.name }));
  // Vendor picker options carry the tax id so the field can be searched by
  // 13-digit เลขผู้เสียภาษี too, while still showing/saving the name (owner 2026-06-27).
  const vendorDesc = vendorLastDescriptions(branchId);
  const expenseVendors = listVendors(branchId).map((v) => ({
    name: v.name, tax_id: v.tax_id, last_description: vendorDesc[v.name] ?? null
  }));
  // Pending scanned-bill drafts the day's รายจ่าย panel can pull in (owner
  // 2026-06-25). This branch's drafts + any not-yet-assigned ones.
  const draftExpenses = listExpenses({ reviewStatus: "draft" })
    .filter((d) => d.branch_id === branchId || d.branch_id == null)
    .map((d) => ({
      id: d.id, vendor_name: d.vendor_name, category: d.category,
      amount_total: d.amount_total, has_tax_invoice: !!d.has_tax_invoice,
      payment_status: d.payment_status, has_doc: d.has_doc, doc_mime: d.doc_mime, bill_date: d.bill_date
    }));
  const expenses: LedgerExpenseRow[] = listExpensesInRange(branchId, dash.start, dash.end).map((e) => ({
    id: e.id, bill_date: e.bill_date, vendor_name: e.vendor_name, invoice_no: e.invoice_no, doc_type: e.doc_type,
    category: e.category, amount_total: e.amount_total, vat_amount: e.vat_amount,
    payment_status: e.payment_status, has_doc: e.has_doc, due_date: e.due_date,
    capex_bucket: e.capex_bucket, description: e.description, has_tax_invoice: !!e.has_tax_invoice,
    wht_rate: e.wht_rate, awaiting_doc: !!e.awaiting_doc, is_fixed: !!e.is_fixed,
    payment_method: e.payment_method, paid_date: e.paid_date, branch_id: e.branch_id, company_id: e.company_id
  }));
  const paymentMethods = listPaymentMethods();
  // Material-purchase quota for TODAY (owner 2026-07-03) — the same number that
  // shows in the shift-close report, surfaced here so admins see the day's
  // ordering budget without opening a shift. null when the branch has the
  // quota feature off.
  // Quota's X on day 2+ = the run-rate ประมาณการยอดขายทั้งเดือน for the CURRENT
  // month. Reuse `dash` when the page is already showing this month; otherwise
  // compute the month forecast once (independent of the viewed week/year range).
  const quotaToday_ = todayBkk();
  const monthDash = (period === "month" && anchor.slice(0, 7) === quotaToday_.slice(0, 7))
    ? dash
    : ledgerDashboard(branchId, "month", quotaToday_);
  const materialQuota = materialPurchaseQuota(branchId, quotaToday_, monthDash.forecast, monthDash.salesRevenue);

  // ยอดขายเทียบเป้าเดือนนี้ (owner 2026-07-11) — ยอดขายสะสมทั้งเดือนเทียบเป้า
  // ยอดขายรายเดือนของสาขา. ใช้ยอดขายจาก ledger (monthDash.salesRevenue) ตัวเดียว
  // กับการ์ด "รายรับ (ยอดขาย)" + โควตา ในหน้านี้ เพื่อให้เลขตรงกันทั้งหน้า.
  // แสดงเฉพาะเมื่อสาขาตั้งเป้ารายเดือนไว้แล้ว.
  const salesTarget = salesTargetProgress(branchId, todayBkk(), monthDash.salesRevenue);

  // จุดคุ้มทุนเดือนนี้ (owner 2026-07-19) — ใช้ยอดขายเดือนนี้ตัวเดียวกับหน้า
  // (monthDash.salesRevenue) + ประมาณการทั้งเดือน (monthDash.forecast). แสดง
  // เฉพาะเมื่อมีข้อมูลพอคำนวณเป้าได้ (be.hasData).
  const breakEven = breakEvenAnalysis(branchId, todayBkk(), monthDash.salesRevenue, monthDash.forecast);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">← กลับ ACCOUNTA</Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">บัญชีรายรับรายจ่าย</h1>
        <p className="text-sm text-slate-500 mt-1">
          สาขา <b>{branch?.name ?? `#${branchId}`}</b> · รายรับ-รายจ่าย · ภาษีซื้อ-ขาย · ภพ.30 · สัดส่วนต้นทุน · คาดการณ์ยอดขาย
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          การลงบันทึกนี้ใช้ติดตามภายในเท่านั้น ไม่ได้อ้างอิงหลักการบัญชี/ไม่ใช้แทนเอกสารทางภาษีอย่างเป็นทางการ
        </p>
      </div>
      {salesTarget.hasTarget && <SalesTargetCard st={salesTarget} />}
      {breakEven.hasData && <BreakEvenCard be={breakEven} />}
      <LedgerDashboardClient dash={dash} expenses={expenses} period={period} anchor={anchor}
        monthly={monthly} trendYear={trendYear} payables={payables}
        cashAccounts={cashAccounts} cashTotal={cashTotal}
        branchId={branchId} companyId={branch?.company_id ?? null} branchName={branch?.name ?? `#${branchId}`}
        incomeChannels={incomeChannels} expenseCategories={expenseCategories}
        draftExpenses={draftExpenses} expenseVendors={expenseVendors}
        paymentMethods={paymentMethods}
        materialQuota={materialQuota}
        projectedMonthlySales={salesTarget.monthlyTarget}
        aiEnabled={financialAnalysisEnabled()}
        payCycleWeekday={payCycleWeekday} />
    </div>
  );
}
