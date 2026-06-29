import type { Metadata } from "next";
import { verifyBillToken } from "@/lib/accounta-bill-token";
import { getExpense, listCategories } from "@/lib/accounta-db";
import BillForm from "./BillForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "กรอกรายละเอียดบิล · ACCOUNTA" };

// Public, token-authorised form opened from the LINE bill card — the sender
// picks the doc type + fills total/tax and submits the draft for admin review
// (owner 2026-06-29). No login: the signed token scopes access to one draft.
export default function BillDetailPage({ params }: { params: { token: string } }) {
  const id = verifyBillToken(params.token);
  const expense = id != null ? getExpense(id) : null;

  if (!expense || expense.review_status !== "draft") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 max-w-sm w-full p-6 text-center space-y-2">
          <div className="text-lg font-bold text-slate-800">ลิงก์นี้ใช้ไม่ได้แล้ว</div>
          <p className="text-sm text-slate-500">
            {id == null ? "ลิงก์หมดอายุหรือไม่ถูกต้อง" : "บิลนี้ถูกตรวจ/บันทึกเข้าระบบแล้ว"} — ปิดหน้านี้ได้เลยครับ
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 sm:p-6">
      <div className="max-w-md mx-auto">
        <BillForm
          token={params.token}
          branchName={expense.branch_name}
          categories={listCategories().map((c) => ({ code: c.code, name: c.name }))}
          initial={{
            doc_type: expense.doc_type,
            vendor_name: expense.vendor_name,
            ocr_tax_id: expense.ocr_tax_id,
            category: expense.category,
            amount_total: expense.amount_total,
            has_tax_invoice: !!expense.has_tax_invoice,
            vat_amount: expense.vat_amount,
            bill_date: expense.bill_date,
            note: expense.note
          }}
        />
      </div>
    </div>
  );
}
