import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, canModule } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { HubCard, type HubCardProps } from "@/components/HubCard";
import { Icon } from "@/components/Icon";

export const metadata: Metadata = { title: "ADMIN" };

export default function AdminHomePage() {
  const user = requireAdmin();
  const lang = getLang();
  const moduleEyebrow = t(lang, "portal.label.module");
  const openBackend = t(lang, "portal.openBackend");

  // RBAC (2026-06-04): module cards mirror the sidebar — each shows only when
  // the user's roles grant that module. INVENTA is a staff-level tool, always
  // shown. Icon-card look shared with every hub landing (owner 2026-08-02).
  const cards: (HubCardProps | null)[] = [
    canModule(user, "persona.manage") ? {
      href: "/admin/persona", icon: "persona", tone: "brand", eyebrow: moduleEyebrow,
      title: t(lang, "portal.persona.title"), sub: t(lang, "portal.persona.adminDesc"), cta: openBackend,
    } : null,
    canModule(user, "reserva.manage") ? {
      href: "/admin/reserva", icon: "reserva", tone: "sky", eyebrow: moduleEyebrow,
      title: t(lang, "portal.reserva.title"), sub: t(lang, "portal.reserva.adminDesc"), cta: openBackend,
    } : null,
    {
      href: "/staff/inventa", icon: "inventa", tone: "emerald", eyebrow: moduleEyebrow,
      title: "INVENTA", sub: t(lang, "inv.module.desc"), cta: t(lang, "portal.openModule"),
    },
    canModule(user, "insigna.view") ? {
      href: "/admin/insigna", icon: "insigna", tone: "violet", eyebrow: moduleEyebrow,
      title: "INSIGNA",
      sub: "ระบบวิเคราะห์ลูกค้า · persona · churn · attribution · privacy-first",
      cta: openBackend, badge: { label: "NEW", tone: "emerald" },
    } : null,
    canModule(user, "recruita.access") ? {
      href: "/admin/recruita", icon: "recruita", tone: "amber", eyebrow: moduleEyebrow,
      title: "RECRUITA",
      sub: "ระบบรับสมัครงาน · ตำแหน่ง · ใบสมัคร · pipeline → bridge เข้า PERSONA",
      cta: openBackend, badge: { label: "NEW", tone: "emerald" },
    } : null,
    canModule(user, "accounta.manage") ? {
      href: "/admin/accounta", icon: "accounta", tone: "rose", eyebrow: moduleEyebrow,
      title: "ACCOUNTA",
      sub: "บัญชีรายรับ-รายจ่าย · ภาษีซื้อ-ขาย · บัญชีรายวัน · ประเมินความเป็นไปได้ (FEASIBILITY)",
      cta: openBackend, badge: { label: "NEW", tone: "emerald" },
    } : null,
    canModule(user, "ascenda.view") ? {
      href: "/admin/ascenda", icon: "ascenda", tone: "slate", eyebrow: moduleEyebrow,
      title: t(lang, "portal.ascenda.title"), sub: t(lang, "portal.ascenda.adminDesc"),
      cta: t(lang, "portal.previewModule"), muted: true,
      badge: { label: t(lang, "portal.label.comingSoon"), tone: "amber" },
    } : null,
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "portal.adminSubtitle")}</p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.filter((c): c is HubCardProps => c !== null).map((c) => (
          <HubCard key={c.href} {...c} />
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
