import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePayrollAccess } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { buildPayslipView } from "@/lib/payslip";
import PayslipDocument from "@/app/components/PayslipDocument";
import PayslipPrintButton from "./PayslipPrintButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สลิปค่าตอบแทน · PERSONA" };

export default function PayslipPage({
  params, searchParams
}: { params: { id: string; userId: string }; searchParams: { as?: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) notFound();

  const view = buildPayslipView(db, periodId, userId);
  if (!view) notFound();

  // "ดูตัวอย่างแบบพนักงาน" — render the exact staff-facing view (hides the
  // branch SVC pool / แก้ไข badge / bank account) so the admin sees what the
  // employee will see before sharing (owner 2026-09-05).
  const asStaff = searchParams.as === "staff";
  const base = `/admin/persona/payroll/${periodId}/payslip/${userId}`;

  return (
    <>
      {/* On-screen toolbar — hidden when printing */}
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/${periodId}`} className="text-sm text-slate-500 hover:text-brand">
            ← {t(lang, "admin.persona.payroll.backToPeriod")}
          </Link>
          <Link
            href={asStaff ? base : `${base}?as=staff`}
            className="text-sm font-medium text-brand hover:underline inline-flex items-center gap-1 rounded-md border border-brand/40 px-3 py-1 hover:bg-amber-50"
          >
            {asStaff ? "กลับมุมมองแอดมิน" : "ดูตัวอย่างแบบพนักงาน"}
          </Link>
          <PayslipPrintButton lang={lang} />
        </div>
        {asStaff && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            กำลังดูแบบที่พนักงานเห็น — ซ่อนยอดกองกลางเซอร์วิสรวมสาขา ป้าย “แก้ไข” และเลขบัญชีธนาคาร
          </div>
        )}
      </div>

      <PayslipDocument lang={lang} view={view} audience={asStaff ? "staff" : "admin"} />
    </>
  );
}
