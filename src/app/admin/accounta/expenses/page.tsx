import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import {
  listBranches, listCompanies, listVendors, listExpenses, summarise, ocrUsageStats,
  listCategories, listPaymentMethods, categoryBudget, listPaymentChannels
} from "@/lib/accounta-db";
import ExpensesClient from "./ExpensesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รายจ่าย" };

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function AccountaExpensesPage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requirePermission("accounta.manage");
  // Honour ?month so deep-links from บัญชีรายวัน land on the month that has the
  // data (owner 2026-06-29) — was always the current month, so old links showed
  // an empty list when the bill was in another month.
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "") ? searchParams.month! : thisMonth();
  const settings = getSystemSettings();
  const ocrAvailable = !!settings.accounta_ocr_enabled && !!process.env.ANTHROPIC_API_KEY;
  const expenseChannels = user.activeBranchId != null
    ? listPaymentChannels(user.activeBranchId, "expense").map((c) => c.label)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ACCOUNTA
        </Link>
        <div className="flex items-center gap-3">
          {user.role === "super_admin" && (
            <Link href="/admin/accounta/drive" className="text-sm text-brand hover:underline">
              Google Drive ↗
            </Link>
          )}
          <Link href="/admin/accounta/daybook" className="text-sm text-brand hover:underline">
            ดูบัญชีรายวัน (แบบเอกเซล) →
          </Link>
        </div>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รายจ่าย · ตรวจ/แก้ไข</h1>
        <p className="text-sm text-slate-500 mt-1">
          ดู/แก้ไขเอกสารผู้จำหน่ายที่ลงไว้ แยกตามเดือน → วัน · ภาษีซื้อเรียลไทม์ · เพิ่มรายการใหม่สะดวกกว่าที่{" "}
          <Link href="/admin/accounta/daybook" className="text-brand hover:underline">บัญชีรายวัน</Link>
        </p>
        <p className="text-[11px] text-slate-400 mt-1 bg-slate-50 border border-slate-200 rounded-md px-2.5 py-1.5 inline-block">
          หมายเหตุ: การลงบันทึกนี้ใช้เพื่อช่วยติดตามรายรับ-รายจ่ายภายในเท่านั้น ไม่ได้อ้างอิงหลักการบัญชี
          และไม่ใช้แทนงบการเงิน/เอกสารทางบัญชีอย่างเป็นทางการ
        </p>
      </div>
      <ExpensesClient
        month={month}
        branches={listBranches()}
        companies={listCompanies()}
        vendors={listVendors(user.activeBranchId ?? null)}
        categories={listCategories()}
        paymentMethods={listPaymentMethods()}
        expenseChannels={expenseChannels}
        initialExpenses={listExpenses({ month })}
        initialSummary={summarise(month)}
        initialDrafts={listExpenses({ reviewStatus: "draft" })}
        initialBudget={categoryBudget(month)}
        ocrAvailable={ocrAvailable}
        ocrUsage={ocrUsageStats(month)}
      />
    </div>
  );
}
