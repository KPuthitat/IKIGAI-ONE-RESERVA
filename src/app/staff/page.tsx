import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import { HubCard, type HubCardProps } from "@/components/HubCard";
import { getMyEnrollment, type MjActor } from "@/lib/mounjaro-db";
import { moduleHits } from "@/lib/module-usage";
import { getMonthlyTarget, isSalesaBranch } from "@/lib/salesa-db";
import { monthComparison, targetProgress } from "@/lib/salesa-analytics";
import TeamGoalHero from "@/app/components/TeamGoalHero";

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

  // Team goal hero (owner 2026-09-20): the active branch's monthly sales target,
  // progress this month, and rotating encouragement — a shared banner so the whole
  // branch pulls toward the number together. Best-effort: only for a POS branch
  // with a target set, and never breaks the landing if salesa data isn't there.
  let goal: {
    branchName: string; target: number; mtd: number; pct: number;
    projected: number; projectedPct: number; onTrack: boolean; throughDay: number;
  } | null = null;
  try {
    const bid = user.activeBranchId;
    if (bid != null && isSalesaBranch(bid)) {
      const target = getMonthlyTarget(bid);
      if (target != null && target > 0) {
        const todayIso = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
        const y = Number(todayIso.slice(0, 4)), m = Number(todayIso.slice(5, 7));
        const mc = monthComparison(bid, y, m, todayIso);
        const tp = mc.throughDay > 0 ? targetProgress(target, mc.mtdNett, mc.throughDay, y, m) : null;
        if (tp) {
          goal = {
            branchName: user.branches.find((b) => b.id === bid)?.name ?? "",
            target: tp.target, mtd: tp.mtdNett, pct: tp.pctOfTarget,
            projected: tp.projectedNett, projectedPct: tp.projectedPct, onTrack: tp.onTrack, throughDay: tp.throughDay
          };
        }
      }
    }
  } catch { goal = null; }

  // Wellness (Mounjaro) appears ONLY for enrolled staff — same rule as the
  // nav (privacy: non-enrolled employees never see it). Surfacing it here
  // fixes the landing being incomplete for enrolled staff (owner 2026-09-18).
  let mjEnrolled = false;
  try { mjEnrolled = !!getMyEnrollment(user as MjActor); } catch { mjEnrolled = false; }

  // Cards mirror the staff nav + the modern icon-card look shared with the
  // admin landing (HubCard, owner 2026-08-02). Only modules this employee can
  // actually open are shown; ASCENDA is a preview. `key` is the /staff path
  // segment — it matches what ModuleVisitTracker records, so the landing can
  // order cards by how often this person opens each module (owner 2026-09-20).
  type Entry = { key: string; card: HubCardProps; pinLast?: boolean };
  const entries: (Entry | null)[] = [
    { key: "persona", card: {
      href: "/staff/persona", icon: "persona", tone: "brand", eyebrow: moduleEyebrow,
      title: t(lang, "portal.persona.title"), sub: t(lang, "portal.persona.staffDesc"), cta: openModule,
    } },
    { key: "reserva", card: {
      href: "/staff/reserva", icon: "reserva", tone: "sky", eyebrow: moduleEyebrow,
      title: t(lang, "portal.reserva.title"), sub: t(lang, "portal.reserva.staffDesc"), cta: openModule,
    } },
    { key: "inventa", card: {
      href: "/staff/inventa", icon: "inventa", tone: "emerald", eyebrow: moduleEyebrow,
      title: "INVENTA", sub: t(lang, "inv.module.desc"), cta: openModule,
    } },
    mjEnrolled ? { key: "health", card: {
      href: "/staff/health/exams", icon: "shield", tone: "rose", eyebrow: moduleEyebrow,
      title: t(lang, "portal.wellness.title"), sub: t(lang, "portal.wellness.staffDesc"), cta: openModule,
    } } : null,
    // ASCENDA is a preview (no real page yet) — always pinned last.
    { key: "ascenda", pinLast: true, card: {
      href: "/staff/ascenda", icon: "ascenda", tone: "slate", eyebrow: moduleEyebrow,
      title: t(lang, "portal.ascenda.title"), sub: t(lang, "portal.ascenda.staffDesc"),
      cta: t(lang, "portal.previewModule"), muted: true,
      badge: { label: t(lang, "portal.label.comingSoon"), tone: "amber" },
    } },
  ];

  // Order by this user's own usage: most-opened first, preview pinned last, and
  // a stable original order for ties (and for a brand-new user with no history).
  const hits = moduleHits(user.id);
  const ordered = entries
    .filter((e): e is Entry => e !== null)
    .map((e, i) => ({ e, i, n: hits.get(e.key) ?? 0 }))
    .sort((a, b) => {
      const pa = a.e.pinLast ? 1 : 0, pb = b.e.pinLast ? 1 : 0;
      if (pa !== pb) return pa - pb;
      if (b.n !== a.n) return b.n - a.n;
      return a.i - b.i;
    })
    .map((x) => x.e.card);

  return (
    <div className="space-y-6">
      {goal && <TeamGoalHero {...goal} />}
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
        {ordered.map((c) => (
          <HubCard key={c.href} compact {...c} />
        ))}
      </div>
    </div>
  );
}
