// A4 monthly payslip for EXTERNAL use (bank loan / visa / credit-card applications),
// admin view. The staff self-service twin is /staff/persona/payslip/bank.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { bkkToday, buildBankPayslip } from "@/lib/payslip-bank";
import BankPayslipDocument from "@/app/components/BankPayslipDocument";
import PayslipPrintButton from "../../../[id]/payslip/[userId]/PayslipPrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลิปเงินเดือน A4 (สำหรับยื่นภายนอก) · PERSONA" };

export default function BankPayslipPage({
  params, searchParams
}: { params: { userId: string }; searchParams: { m?: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const userId = Number(params.userId);
  if (!Number.isInteger(userId)) notFound();
  const month = /^\d{4}-\d{2}$/.test(searchParams.m ?? "") ? searchParams.m! : bkkToday().slice(0, 7);

  const d = buildBankPayslip(getDb(), userId, month);
  if (!d) notFound();

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/summary?m=${month}`} className="text-sm text-slate-500 hover:text-brand">← สรุปเงินเดือน</Link>
          <Link href={`/admin/persona/payroll/monthly-payslip/${userId}?m=${month}`} className="text-sm text-brand hover:underline">สลิปภายใน (มีรายละเอียดรายวัน)</Link>
          <PayslipPrintButton lang={lang} />
        </div>
        {!d.allPaid && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            เดือนนี้ยังมีรอบที่ไม่ได้อยู่ในสถานะ “จ่ายแล้ว” — ตัวเลขอาจยังเปลี่ยนได้ ควรรอให้จ่ายครบก่อนนำไปยื่นภายนอก
          </div>
        )}
        <div className="text-xs text-slate-500">ตอนพิมพ์ให้เลือกกระดาษ A4 แนวตั้ง และปิด “หัวกระดาษ/ท้ายกระดาษ” ของเบราว์เซอร์ หรือเลือกบันทึกเป็น PDF</div>
      </div>
      <BankPayslipDocument d={d} />
    </>
  );
}
