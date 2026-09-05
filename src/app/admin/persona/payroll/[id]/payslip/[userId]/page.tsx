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
  params
}: { params: { id: string; userId: string } }) {
  requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) notFound();

  const view = buildPayslipView(db, periodId, userId);
  if (!view) notFound();

  return (
    <>
      {/* On-screen toolbar — hidden when printing */}
      <div className="space-y-3 print:hidden">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href={`/admin/persona/payroll/${periodId}`} className="text-sm text-slate-500 hover:text-brand">
            ← {t(lang, "admin.persona.payroll.backToPeriod")}
          </Link>
          <PayslipPrintButton lang={lang} />
        </div>
      </div>

      <PayslipDocument lang={lang} view={view} />
    </>
  );
}
