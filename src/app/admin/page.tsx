import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin, canModule } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: "ADMIN" };

export default function AdminHomePage() {
  const user = requireAdmin();
  const lang = getLang();

  // RBAC (2026-06-04): module cards mirror the sidebar — each shows only
  // when the user's roles grant that module. INVENTA is a staff-level
  // tool, always shown. super_admin / roleless full admins see all.
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "portal.chooseModule")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "portal.adminSubtitle")}</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {canModule(user, "persona.manage") && (
          <Link href="/admin/persona" className="card hover:shadow-2xl transition group block">
            <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {t(lang, "portal.persona.title")}
            </h2>
            <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.persona.adminDesc")}</p>
            <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openBackend")}</p>
          </Link>
        )}

        {canModule(user, "reserva.manage") && (
          <Link href="/admin/reserva" className="card hover:shadow-2xl transition group block">
            <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {t(lang, "portal.reserva.title")}
            </h2>
            <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.reserva.adminDesc")}</p>
            <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openBackend")}</p>
          </Link>
        )}

        <Link href="/staff/inventa" className="card hover:shadow-2xl transition group block">
          <div className="text-[11px] tracking-[1px] text-slate-400 mb-1">{t(lang, "portal.label.module")}</div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
            INVENTA
          </h2>
          <p className="text-slate-500 text-sm mt-1">{t(lang, "inv.module.desc")}</p>
          <p className="mt-4 text-brand font-bold text-sm">{t(lang, "portal.openModule")}</p>
        </Link>

        {canModule(user, "ascenda.view") && (
          <Link href="/admin/ascenda" className="card hover:shadow-2xl transition group block opacity-80">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] tracking-[1px] text-slate-400">{t(lang, "portal.label.module")}</div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">
                {t(lang, "portal.label.comingSoon")}
              </span>
            </div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {t(lang, "portal.ascenda.title")}
            </h2>
            <p className="text-slate-500 text-sm mt-1">{t(lang, "portal.ascenda.adminDesc")}</p>
            <p className="mt-4 text-slate-400 font-bold text-sm">{t(lang, "portal.previewModule")}</p>
          </Link>
        )}

        {/* INSIGNA — privacy-first marketing intelligence. NEW pill so
            admins notice the addition; description in Thai mirrors the
            spec's purpose without claiming features that aren't built
            yet (Phase 2 AI swaps are still pending). */}
        {canModule(user, "insigna.view") && (
          <Link href="/admin/insigna" className="card hover:shadow-2xl transition group block">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] tracking-[1px] text-slate-400">
                {t(lang, "portal.label.module")}
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">
                NEW
              </span>
            </div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              INSIGNA
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              ระบบวิเคราะห์ลูกค้า · persona · churn · attribution · privacy-first
            </p>
            <p className="mt-4 text-brand font-bold text-sm">
              {t(lang, "portal.openBackend")}
            </p>
          </Link>
        )}

        {/* RECRUITA — recruitment intake + pipeline. NEW pill matches
            the INSIGNA treatment because RECRUITA is the next module
            admins should notice. Description stays short — the
            module itself owns the longer story on its landing. */}
        {canModule(user, "recruita.access") && (
          <Link href="/admin/recruita" className="card hover:shadow-2xl transition group block">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] tracking-[1px] text-slate-400">
                {t(lang, "portal.label.module")}
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">
                NEW
              </span>
            </div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              RECRUITA
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              ระบบรับสมัครงาน · ตำแหน่ง · ใบสมัคร · pipeline → bridge เข้า PERSONA
            </p>
            <p className="mt-4 text-brand font-bold text-sm">
              {t(lang, "portal.openBackend")}
            </p>
          </Link>
        )}

        {/* ACCOUNTA — accounting + feasibility (owner 2026-06-16). Mirrors
            the sidebar gate; the card was missing from this grid on first
            ship (fixed 2026-06-17). */}
        {canModule(user, "accounta.manage") && (
          <Link href="/admin/accounta" className="card hover:shadow-2xl transition group block">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-[11px] tracking-[1px] text-slate-400">
                {t(lang, "portal.label.module")}
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-700">
                NEW
              </span>
            </div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              ACCOUNTA
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              บัญชีรายรับ-รายจ่าย · ภาษีซื้อ-ขาย · สมุดรายวัน · ประเมินความเป็นไปได้ (FEASIBILITY)
            </p>
            <p className="mt-4 text-brand font-bold text-sm">
              {t(lang, "portal.openBackend")}
            </p>
          </Link>
        )}
      </div>
    </div>
  );
}
