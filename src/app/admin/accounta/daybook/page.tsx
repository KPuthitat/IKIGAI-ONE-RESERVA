import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ledgerDashboard, listExpensesInRange, monthlyTrend, accountaPayables, listCashAccounts, cashAccountsTotal, type LedgerPeriod } from "@/lib/accounta-db";
import LedgerDashboardClient, { type LedgerExpenseRow } from "./LedgerDashboardClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · บัญชีรายรับรายจ่าย" };

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
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

  const db = getDb();
  const branch = db.prepare("SELECT name FROM branches WHERE id = ?").get(branchId) as { name: string } | undefined;
  const dash = ledgerDashboard(branchId, period, anchor);
  const trendYear = Number(anchor.slice(0, 4));
  const monthly = monthlyTrend(branchId, trendYear);
  const payables = accountaPayables(branchId);
  const cashAccounts = listCashAccounts(branchId).map((a) => ({
    id: a.id, name: a.name, type: a.type, bank_label: a.bank_label,
    balance: a.balance, balance_as_of: a.balance_as_of, company_wide: a.branch_id == null
  }));
  const cashTotal = cashAccountsTotal(branchId);
  const expenses: LedgerExpenseRow[] = listExpensesInRange(branchId, dash.start, dash.end).map((e) => ({
    id: e.id, bill_date: e.bill_date, vendor_name: e.vendor_name, doc_type: e.doc_type,
    category: e.category, amount_total: e.amount_total, vat_amount: e.vat_amount,
    payment_status: e.payment_status, has_doc: e.has_doc
  }));

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
      <LedgerDashboardClient dash={dash} expenses={expenses} period={period} anchor={anchor}
        monthly={monthly} trendYear={trendYear} payables={payables}
        cashAccounts={cashAccounts} cashTotal={cashTotal} />
    </div>
  );
}
