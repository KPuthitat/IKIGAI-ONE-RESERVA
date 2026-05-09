import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import StaffPersonaTabs from "./StaffPersonaTabs";

export const dynamic = "force-dynamic";

// Sub-nav for /staff/persona/* (Time clock + Leave)
export default function StaffPersonaLayout({ children }: { children: React.ReactNode }) {
  requireUser();
  const lang = getLang();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff" className="text-sm text-slate-500 hover:text-brand">
          {t(lang, "staff.persona.backToModules")}
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-2">
          {t(lang, "staff.persona.moduleTitle")}
        </h1>
      </div>
      <StaffPersonaTabs
        labels={{
          clock: t(lang, "staff.persona.tab.clock"),
          leave: t(lang, "staff.persona.tab.leave"),
          resignation: t(lang, "staff.persona.tab.resignation")
        }}
      />
      {children}
    </div>
  );
}
