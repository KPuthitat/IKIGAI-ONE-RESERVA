import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import { HubCard, type HubCardProps } from "@/components/HubCard";
import { getMyEnrollment, type MjActor } from "@/lib/mounjaro-db";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Staff" };

export default function StaffHomePage({
  searchParams
}: { searchParams: { error?: string } }) {
  const user = requireUser();
  const lang = getLang();
  const showForbidden = searchParams.error === "forbidden";
  const moduleEyebrow = t(lang, "portal.label.module");
  const openModule = t(lang, "portal.openModule");

  // Wellness (Mounjaro) appears ONLY for enrolled staff — same rule as the
  // nav (privacy: non-enrolled employees never see it). Surfacing it here
  // fixes the landing being incomplete for enrolled staff (owner 2026-09-18).
  let mjEnrolled = false;
  try { mjEnrolled = !!getMyEnrollment(user as MjActor); } catch { mjEnrolled = false; }

  // Cards mirror the staff nav + the modern icon-card look shared with the
  // admin landing (HubCard, owner 2026-08-02). Only modules this employee can
  // actually open are shown; ASCENDA is a preview.
  const cards: (HubCardProps | null)[] = [
    {
      href: "/staff/persona", icon: "persona", tone: "brand", eyebrow: moduleEyebrow,
      title: t(lang, "portal.persona.title"), sub: t(lang, "portal.persona.staffDesc"), cta: openModule,
    },
    {
      href: "/staff/reserva", icon: "reserva", tone: "sky", eyebrow: moduleEyebrow,
      title: t(lang, "portal.reserva.title"), sub: t(lang, "portal.reserva.staffDesc"), cta: openModule,
    },
    {
      href: "/staff/inventa", icon: "inventa", tone: "emerald", eyebrow: moduleEyebrow,
      title: "INVENTA", sub: t(lang, "inv.module.desc"), cta: openModule,
    },
    mjEnrolled ? {
      href: "/staff/health/exams", icon: "shield", tone: "rose", eyebrow: moduleEyebrow,
      title: t(lang, "portal.wellness.title"), sub: t(lang, "portal.wellness.staffDesc"), cta: openModule,
    } : null,
    {
      href: "/staff/ascenda", icon: "ascenda", tone: "slate", eyebrow: moduleEyebrow,
      title: t(lang, "portal.ascenda.title"), sub: t(lang, "portal.ascenda.staffDesc"),
      cta: t(lang, "portal.previewModule"), muted: true,
      badge: { label: t(lang, "portal.label.comingSoon"), tone: "amber" },
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "portal.staffSubtitle", { name: nameWithPrefix(user.title_prefix, user.display_name) })}
        </p>
        {showForbidden && (
          <div className="mt-3 text-sm bg-amber-50 border border-amber-200 text-amber-800 rounded-lg p-3">
            {t(lang, "portal.notForbidden")}
          </div>
        )}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.filter((c): c is HubCardProps => c !== null).map((c) => (
          <HubCard key={c.href} compact {...c} />
        ))}
      </div>
    </div>
  );
}
