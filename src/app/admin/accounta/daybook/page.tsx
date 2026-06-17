import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { fmtMoney } from "@/lib/format";
import { formatLongDate } from "@/lib/time";
import { listBranches, listCompanies, daybook } from "@/lib/accounta-db";
import DaybookFilters from "./DaybookFilters";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · สมุดรายวัน" };

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

// Excel-style two-sided daily ledger (owner 2026-06-17): each date a row,
// รายรับ (from shift-close branch revenue) on the left, รายจ่าย on the
// right, with a running balance — mirrors the owner's spreadsheet.
export default function DaybookPage({
  searchParams
}: { searchParams: { month?: string; branch?: string; company?: string } }) {
  requirePermission("accounta.manage");
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : thisMonth();
  const branchId = /^\d+$/.test(searchParams.branch ?? "") ? Number(searchParams.branch) : null;
  const companyId = /^\d+$/.test(searchParams.company ?? "") ? Number(searchParams.company) : null;

  const book = daybook(month, branchId, companyId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ACCOUNTA
        </Link>
        <Link href="/admin/accounta/expenses" className="text-sm text-brand hover:underline">
          ลงรายจ่าย →
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">สมุดรายวัน</h1>
        <p className="text-sm text-slate-500 mt-1">
          แยกตามวัน — ซ้ายรายรับ ขวารายจ่าย พร้อมยอดคงเหลือสะสม (รูปแบบเดียวกับเอกเซล)
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          รายรับดึงจากยอดขายรายวันของสาขา (รายงานปิดกะ) · ตัวกรองบริษัทมีผลเฉพาะฝั่งรายจ่าย ·
          การลงบันทึกนี้ไม่ได้อ้างอิงหลักการบัญชี
        </p>
      </div>

      <DaybookFilters
        month={month}
        branchId={branchId != null ? String(branchId) : ""}
        companyId={companyId != null ? String(companyId) : ""}
        branches={listBranches()}
        companies={listCompanies()}
      />

      {/* Summary band */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">รวมรายรับ</div>
          <div className="text-xl font-bold text-emerald-700">฿{fmtMoney(book.totalIncome)}</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">รวมรายจ่าย</div>
          <div className="text-xl font-bold text-rose-600">฿{fmtMoney(book.totalExpense)}</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">สุทธิ</div>
          <div className={`text-xl font-bold ${book.net >= 0 ? "text-slate-800" : "text-rose-600"}`}>
            ฿{fmtMoney(book.net)}
          </div>
        </div>
      </div>

      {book.days.length === 0 ? (
        <div className="card text-center py-10 text-slate-500">
          ยังไม่มีรายรับหรือรายจ่ายในเดือนนี้
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-[11px] text-slate-400 border-b border-slate-200 bg-slate-50">
                <th className="px-3 py-2 text-left align-bottom w-28">วันที่</th>
                <th className="px-3 py-2 text-right align-bottom w-32 border-l border-slate-200 text-emerald-700">รายรับ</th>
                <th className="px-3 py-2 text-left align-bottom border-l border-slate-200 text-rose-600">รายจ่าย</th>
                <th className="px-3 py-2 text-right align-bottom w-32 border-l border-slate-200">คงเหลือสะสม</th>
              </tr>
            </thead>
            <tbody>
              {book.days.map((d) => (
                <tr key={d.date} className="border-b border-slate-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatLongDate(d.date, "th")}</td>
                  <td className="px-3 py-2 text-right border-l border-slate-100 whitespace-nowrap">
                    {d.income > 0
                      ? <span className="font-semibold text-emerald-700">฿{fmtMoney(d.income)}</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-3 py-2 border-l border-slate-100">
                    {d.expenses.length === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <div className="space-y-0.5">
                        {d.expenses.map((e) => (
                          <div key={e.id} className="flex items-baseline justify-between gap-2">
                            <span className="text-slate-700 truncate">
                              {e.vendor || "—"}
                              {e.category && <span className="text-slate-400 text-[11px]"> · {e.category}</span>}
                              {e.status === "unpaid" && <span className="text-amber-600 text-[10px]"> (ค้าง)</span>}
                            </span>
                            <span className="text-rose-600 whitespace-nowrap">฿{fmtMoney(e.amount)}</span>
                          </div>
                        ))}
                        {d.expenses.length > 1 && (
                          <div className="flex justify-between border-t border-slate-100 pt-0.5 text-[11px] text-slate-500">
                            <span>รวมวันนี้</span><span>฿{fmtMoney(d.expenseTotal)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-right border-l border-slate-100 whitespace-nowrap font-semibold ${
                    d.balance >= 0 ? "text-slate-800" : "text-rose-600"}`}>
                    ฿{fmtMoney(d.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-bold text-slate-800">
                <td className="px-3 py-2">รวม</td>
                <td className="px-3 py-2 text-right border-l border-slate-200 text-emerald-700">฿{fmtMoney(book.totalIncome)}</td>
                <td className="px-3 py-2 text-right border-l border-slate-200 text-rose-600">฿{fmtMoney(book.totalExpense)}</td>
                <td className="px-3 py-2 text-right border-l border-slate-200">฿{fmtMoney(book.net)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
