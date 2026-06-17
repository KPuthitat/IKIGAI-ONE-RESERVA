import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import {
  listBranches, listCompanies, listVendors, listExpenses, summarise, ocrUsageStats,
  listCategories, listPaymentMethods
} from "@/lib/accounta-db";
import ExpensesClient from "./ExpensesClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "ACCOUNTA · รายจ่าย" };

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export default function AccountaExpensesPage() {
  requirePermission("accounta.manage");
  const month = thisMonth();
  const settings = getSystemSettings();
  const ocrAvailable = !!settings.accounta_ocr_enabled && !!process.env.ANTHROPIC_API_KEY;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/accounta" className="text-sm text-slate-500 hover:text-brand">
          ← กลับ ACCOUNTA
        </Link>
        <Link href="/admin/accounta/daybook" className="text-sm text-brand hover:underline">
          ดูสมุดรายวัน (แบบเอกเซล) →
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">รายจ่าย</h1>
        <p className="text-sm text-slate-500 mt-1">
          ลงบิลผู้ค้า (ชำระแล้ว / ค้างชำระ) · แยกมุมมองตามบิล vs กระแสเงินสด · ภาษีซื้อเรียลไทม์
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
        vendors={listVendors()}
        categories={listCategories()}
        paymentMethods={listPaymentMethods()}
        initialExpenses={listExpenses({ month })}
        initialSummary={summarise(month)}
        ocrAvailable={ocrAvailable}
        ocrUsage={ocrUsageStats(month)}
      />
    </div>
  );
}
