"use client";

import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

export default function PayslipPrintButton({ lang }: { lang: Lang }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="btn-secondary text-sm ml-auto"
    >
      {t(lang, "admin.persona.payroll.payslip.printBtn")}
    </button>
  );
}
