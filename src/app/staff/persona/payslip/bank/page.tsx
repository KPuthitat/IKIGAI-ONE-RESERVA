// /staff/persona/payslip/bank?m=YYYY-MM — พนักงานพิมพ์สลิป A4 รายเดือนของตัวเอง
// เพื่อยื่นภายนอก (ธนาคาร ฯลฯ). เฉพาะของตัวเอง และเฉพาะเดือนที่ทุกรอบ "ทำจ่ายแล้ว".
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { buildBankPayslip, paidBankPayslipMonths } from "@/lib/payslip-bank";
import BankPayslipDocument from "@/app/components/BankPayslipDocument";
import PayslipPrintButton from "@/app/admin/persona/payroll/[id]/payslip/[userId]/PayslipPrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลิป A4 สำหรับยื่นภายนอก · PERSONA" };

export default function StaffBankPayslipPage({ searchParams }: { searchParams: { m?: string } }) {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();

  const month = searchParams.m ?? "";
  if (!/^\d{4}-\d{2}$/.test(month)) notFound();
  // Own slip only, and only months fully paid — draft/finalized figures can still change.
  if (!paidBankPayslipMonths(db, user.id).includes(month)) notFound();
  const d = buildBankPayslip(db, user.id, month);
  if (!d) notFound();

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/staff/persona/payslip" className="text-sm text-slate-500 hover:text-brand">← สลิปทั้งหมด</Link>
          <PayslipPrintButton lang={lang} />
        </div>
        <div className="text-xs text-slate-500">ตอนพิมพ์ให้เลือกกระดาษ A4 แนวตั้ง และปิด “หัวกระดาษ/ท้ายกระดาษ” ของเบราว์เซอร์ หรือเลือกบันทึกเป็น PDF</div>
      </div>
      <BankPayslipDocument d={d} />
    </>
  );
}
