import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, canModule } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { HubCard } from "@/components/HubCard";
import { Icon } from "@/components/Icon";
import { ADMIN_MODULES } from "@/lib/admin-modules";

export const metadata: Metadata = { title: "ADMIN" };

export default function AdminHomePage() {
  const user = requireAdmin();
  const lang = getLang();

  // Same branch-gate as the tab bar: with no active branch, route through the
  // picker first (it auto-skips for single-branch users) so a card and its tab
  // behave identically (review 2026-09-18).
  const needBranch = !user.activeBranchId;
  const gate = (href: string) => (needBranch ? `/admin/branch-picker?next=${encodeURIComponent(href)}` : href);

  // Cards derive from the shared ADMIN_MODULES registry, in the same order as
  // the top tab bar, so the two can never diverge (owner 2026-09-18). Compact
  // single-row layout — smaller, less text.
  const cards = ADMIN_MODULES.filter((m) => m.perm == null || canModule(user, m.perm));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "portal.adminSubtitle")}</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map((m) => (
          <HubCard key={m.key} compact href={gate(m.href)} icon={m.icon} tone={m.tone}
            title={m.label} sub={t(lang, m.subKey)} badge={m.badge} muted={m.comingSoon} />
        ))}
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        <Link
          href="/admin/notifications-catalog"
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50"
        >
          <Icon name="bell" className="h-3.5 w-3.5" />
          แคตตาล็อกการ์ดแจ้งเตือน
        </Link>
      </div>
    </div>
  );
}
