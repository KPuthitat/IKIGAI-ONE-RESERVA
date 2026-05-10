import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import StaffPersonaChrome from "./StaffPersonaChrome";

export const dynamic = "force-dynamic";

// Sub-nav for /staff/persona/* (Time clock + Leave + Resignation).
// The chrome (back link, module title, 3-tab strip) is rendered by the
// client component StaffPersonaChrome, which hides itself on standalone
// sub-flow paths like /staff/persona/shift/*.
export default function StaffPersonaLayout({ children }: { children: React.ReactNode }) {
  requireUser();
  const lang = getLang();

  return (
    <div className="space-y-4">
      <StaffPersonaChrome
        labels={{
          back: t(lang, "staff.persona.backToModules"),
          moduleTitle: t(lang, "staff.persona.moduleTitle"),
          clock: t(lang, "staff.persona.tab.clock"),
          leave: t(lang, "staff.persona.tab.leave"),
          resignation: t(lang, "staff.persona.tab.resignation")
        }}
      />
      {children}
    </div>
  );
}
