import Link from "next/link";
import type { Metadata } from "next";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import LangToggle from "../LangToggle";
import Footer from "../Footer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ระบบจองสำหรับลูกค้า · RESERVA" };

const DAY_NAMES_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseJsonArr<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr as T[] : [];
  } catch { return []; }
}

function parseClosedWeekdays(json: string | null): number[] {
  return parseJsonArr<number>(json).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

function formatClosedDays(closed: number[], lang: Lang): string {
  const names = lang === "en" ? DAY_NAMES_EN : DAY_NAMES_TH;
  return closed.map((d) => names[d]).join(lang === "en" ? ", " : " · ");
}

type TodayStatus =
  | { kind: "closed" }
  | { kind: "specialOpenAllDay"; lunchStart: string; lunchEnd: string }
  | { kind: "lunchBreak"; lunchStart: string; lunchEnd: string }
  | { kind: "openAllDay" };

function computeTodayStatus(b: Branch, todayBkk: string): TodayStatus {
  // Check closed_weekdays
  const closedDays = parseClosedWeekdays(b.closed_weekdays);
  const dow = new Date(`${todayBkk}T00:00:00Z`).getUTCDay();
  if (closedDays.includes(dow)) return { kind: "closed" };

  // Check lunch break
  if (!b.lunch_break_start || !b.lunch_break_end) return { kind: "openAllDay" };
  const lunchWeekdays = parseJsonArr<number>(b.lunch_break_weekdays);
  const noLunchDates = parseJsonArr<string>(b.no_lunch_break_dates);
  if (!lunchWeekdays.includes(dow)) return { kind: "openAllDay" };
  if (noLunchDates.includes(todayBkk)) {
    return {
      kind: "specialOpenAllDay",
      lunchStart: b.lunch_break_start,
      lunchEnd: b.lunch_break_end
    };
  }
  return {
    kind: "lunchBreak",
    lunchStart: b.lunch_break_start,
    lunchEnd: b.lunch_break_end
  };
}

// Cross-promotion entry shape mirrors the admin matrix in
// ReservaMessagingClient. Parser is local — we don't share with the
// admin client because that one runs in the browser and we don't
// want to drag the picker into the same bundle.
type CrossPromotion = {
  target_slug: string;
  url: string | null;
  enabled: boolean;
};

function parseCrossPromos(raw: string | null): CrossPromotion[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is CrossPromotion =>
        p && typeof p === "object" && typeof p.target_slug === "string"
      )
      .map((p) => ({
        target_slug: p.target_slug,
        url: typeof p.url === "string" ? p.url : null,
        enabled: !!p.enabled
      }));
  } catch {
    return [];
  }
}

export default function CustomerReservaPage({
  searchParams
}: {
  searchParams: { from?: string };
}) {
  const lang = getLang();
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const db = getDb();
  // Open-for-booking branches float to the top; coming-soon then
  // closed sink below. display_order/name keeps a stable order within
  // each tier (flagship NAMA = display_order 1).
  let branches = db.prepare(`
    SELECT * FROM branches
    ORDER BY
      CASE status WHEN 'open' THEN 0 WHEN 'coming_soon' THEN 1 ELSE 2 END,
      display_order, name
  `).all() as Branch[];

  // ?from=<slug> cross-promotion filter — when a customer arrives
  // from a specific branch's LINE rich menu, the source branch's
  // cross_promotions matrix dictates which OTHER branches are
  // visible + which LINE OA URL each one uses. Source branch itself
  // is always included so the customer can also book it.
  const fromSlug = typeof searchParams.from === "string" ? searchParams.from : null;
  const sourceBranch = fromSlug
    ? (db.prepare("SELECT * FROM branches WHERE slug = ?")
        .get(fromSlug) as Branch | undefined)
    : undefined;
  // Map of target_slug → URL the source admin configured. Empty
  // when ?from is absent or invalid — picker shows everything.
  const promoUrls = new Map<string, string | null>();
  if (sourceBranch) {
    const promos = parseCrossPromos(sourceBranch.cross_promotions);
    const enabledTargets = new Set(
      promos.filter((p) => p.enabled).map((p) => p.target_slug)
    );
    branches = branches.filter((b) =>
      b.slug === sourceBranch.slug || enabledTargets.has(b.slug)
    );
    for (const p of promos) {
      if (p.enabled) promoUrls.set(p.target_slug, p.url);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-ink-gradient">
      <main className="flex-1 flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-8">
          <div className="brand-wordmark text-white text-[42px]">IKIGAI OS</div>
          <div className="text-white/50 text-[13px] tracking-[1px] mt-1">
            {t(lang, "customer.reserva.title")}
          </div>
          <p className="text-white/70 mt-4">{t(lang, "customer.reserva.subtitle")}</p>
        </div>

        <div className="space-y-3">
          {branches.map((b) => {
            const closed = parseClosedWeekdays(b.closed_weekdays);
            const isComingSoon = b.status === "coming_soon";
            const isClosed = b.status === "closed";
            const bookable = b.status === "open";
            const card = (
              <div className="card hover:shadow-2xl transition group block relative">
                {isComingSoon && (
                  <div className="absolute top-3 right-3 text-[10px] tracking-[1px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                    {t(lang, "customer.reserva.comingSoonBadge")}
                  </div>
                )}
                {isClosed && (
                  <div className="absolute top-3 right-3 text-[10px] tracking-[1px] font-bold px-2 py-1 rounded-full bg-rose-100 text-rose-700">
                    {t(lang, "customer.reserva.closedBadge")}
                  </div>
                )}
                <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors pr-24">
                  {b.name}
                </h2>
                {isClosed ? (
                  <p className="text-rose-600 text-sm mt-2 font-medium">
                    {t(lang, "customer.reserva.closedMsg")}
                  </p>
                ) : isComingSoon ? (
                  <p className="text-slate-500 text-sm mt-2">
                    {b.opens_on
                      ? t(lang, "customer.reserva.opensOn", { date: b.opens_on })
                      : t(lang, "customer.reserva.opensSoon")}
                  </p>
                ) : (
                  <>
                    <p className="text-slate-500 text-sm mt-1">
                      {t(lang, "customer.reserva.openHours", { open: b.open_time, close: b.close_time })}
                    </p>
                    {closed.length > 0 ? (
                      <p className="text-rose-600 text-xs mt-1">
                        {t(lang, "customer.reserva.closedOn", { days: formatClosedDays(closed, lang) })}
                      </p>
                    ) : (
                      <p className="text-emerald-700 text-xs mt-1">
                        {t(lang, "customer.reserva.openDaily")}
                      </p>
                    )}
                    {/* Today's status — lunch break / special / closed today */}
                    {(() => {
                      const status = computeTodayStatus(b, todayBkk);
                      if (status.kind === "closed") {
                        return (
                          <p className="text-rose-600 text-xs mt-1 font-medium">
                            ✗ {t(lang, "customer.reserva.todayClosed")}
                          </p>
                        );
                      }
                      if (status.kind === "specialOpenAllDay") {
                        return (
                          <p className="text-emerald-700 text-xs mt-1 font-medium">
                            ★ {t(lang, "customer.reserva.todaySpecialOpenAllDay")}
                          </p>
                        );
                      }
                      if (status.kind === "lunchBreak") {
                        return (
                          <p className="text-amber-700 text-xs mt-1">
                            {t(lang, "customer.reserva.todayLunchBreak", {
                              start: status.lunchStart, end: status.lunchEnd
                            })}
                          </p>
                        );
                      }
                      return null; // openAllDay → already covered by openDaily / hours
                    })()}
                    <p className="mt-3 text-brand font-bold text-sm">{t(lang, "customer.reserva.bookCta")}</p>
                  </>
                )}
              </div>
            );

            // Branch card click target priority:
            //   1. Cross-promotion URL the source branch (?from=) set
            //      for this target — applies only when admin enabled
            //      this target in the source's matrix.
            //   2. The target branch's own customer_line_oa_url
            //      (default landing for organic /reserva visits).
            //   3. Direct booking link /reserva/<slug>.
            //
            // CRITICAL: in ?from= context (customer just came from
            // another branch's booking flow), step #3 is REMOVED for
            // OTHER branches. The owner's complaint: customers who
            // tap "เลือกสาขาอื่น" after booking at HYPO land on
            // NAMA's booking form without ever reaching NAMA's LINE
            // OA — they then have no way to contact NAMA when they
            // have questions. So in ?from context, other branches
            // must have a LINE OA URL (cross-promo or own) to be
            // tappable; cards with no URL are silently filtered out
            // earlier via enabledTargets / cross_promotions logic.
            const crossUrl = promoUrls.has(b.slug)
              ? promoUrls.get(b.slug)
              : null;
            const isSourceBranch = sourceBranch && b.slug === sourceBranch.slug;
            let targetHref: string | null = null;
            if (bookable) {
              if (sourceBranch && isSourceBranch) {
                // ?from context + clicking the source branch itself:
                // the customer just came FROM this branch's LINE OA,
                // so they're already a friend — sending them back to
                // the LINE OA is a useless detour. Skip every LINE
                // OA URL and go straight to the booking form.
                // (Earlier bug: HYPO admin accidentally typed NAMA's
                // URL into HYPO's customer_line_oa_url field, so
                // clicking HYPO on /reserva?from=hypo bounced to NAMA.)
                targetHref = `/reserva/${b.slug}`;
              } else if (sourceBranch && !isSourceBranch) {
                // ?from context + OTHER branch — LINE OA URL is
                // mandatory; no booking-form fallback.
                targetHref = crossUrl || b.customer_line_oa_url || null;
              } else {
                // Organic visit (no ?from): full priority chain.
                targetHref = crossUrl || b.customer_line_oa_url || `/reserva/${b.slug}`;
              }
            }
            // Hide the card entirely when we're in ?from context for
            // a non-source branch and there's no URL to send to.
            if (sourceBranch && !isSourceBranch && !targetHref) {
              return null;
            }
            const isExternal = !!targetHref && /^https?:\/\//i.test(targetHref);
            return bookable && targetHref ? (
              isExternal ? (
                // External LINE OA — open in same tab so LINE on
                // mobile launches the app smoothly. target="_blank"
                // on mobile LINE WebView often loses the session.
                <a
                  key={b.id}
                  href={targetHref}
                  className="block"
                  rel="noopener noreferrer"
                >
                  {card}
                </a>
              ) : (
                <Link key={b.id} href={targetHref} className="block">
                  {card}
                </Link>
              )
            ) : (
              <div key={b.id} className="opacity-75 cursor-not-allowed">{card}</div>
            );
          })}
        </div>

        <div className="flex justify-center mt-8">
          <LangToggle variant="dark" />
        </div>
      </div>
    </main>
      <Footer />
    </div>
  );
}
