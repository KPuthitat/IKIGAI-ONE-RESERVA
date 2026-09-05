// /staff/persona/payslip/[id] — พนักงานเปิดสลิปเงินเดือนของตัวเอง 1 รอบ.
// เห็นได้เฉพาะสลิปของตัวเอง และเฉพาะรอบที่ยืนยัน/ทำจ่ายแล้ว (owner 2026-09-05).
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { buildPayslipView } from "@/lib/payslip";
import PayslipDocument from "@/app/components/PayslipDocument";
import PayslipPrintButton from "@/app/admin/persona/payroll/[id]/payslip/[userId]/PayslipPrintButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "สลิปเงินเดือน · PERSONA" };

export default function StaffPayslipPage({ params }: { params: { id: string } }) {
  const user = requireUser();
  const lang = getLang();
  const db = getDb();

  const periodId = Number(params.id);
  if (!Number.isInteger(periodId)) notFound();

  // Only ever the signed-in staff's OWN line, and only finalized/paid rounds
  // (a draft's figures can still change, so it isn't a real payslip yet).
  const view = buildPayslipView(db, periodId, user.id);
  if (!view || (view.period.status !== "finalized" && view.period.status !== "paid")) notFound();

  return (
    <>
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/staff/persona/payslip" className="text-sm text-slate-500 hover:text-brand">
            ← สลิปทั้งหมด
          </Link>
          <PayslipPrintButton lang={lang} />
        </div>
      </div>

      <PayslipDocument lang={lang} view={view} audience="staff" />
    </>
  );
}
