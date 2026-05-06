import Link from "next/link";
import type { Metadata } from "next";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import LangToggle from "../LangToggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "จองโต๊ะ · RESERVA" };

const DAY_NAMES_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_NAMES_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseClosedWeekdays(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  } catch {}
  return [];
}

function formatClosedDays(closed: number[], lang: Lang): string {
  const names = lang === "en" ? DAY_NAMES_EN : DAY_NAMES_TH;
  return closed.map((d) => names[d]).join(lang === "en" ? ", " : " · ");
}

export default function CustomerReservaPage() {
  const lang = getLang();
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];

  return (
    <main className="min-h-screen bg-ink-gradient flex flex-col items-center justify-center p-6">
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
            const card = (
              <div className="card hover:shadow-2xl transition group block relative">
                {isComingSoon && (
                  <div className="absolute top-3 right-3 text-[10px] tracking-[1px] font-bold px-2 py-1 rounded-full bg-amber-100 text-amber-700">
                    {t(lang, "customer.reserva.comingSoonBadge")}
                  </div>
                )}
                <h2 className="text-xl font-bold text-slate-800 group-hover:text-brand transition-colors pr-24">
                  {b.name}
                </h2>
                {isComingSoon ? (
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
                    <p className="mt-3 text-brand font-bold text-sm">{t(lang, "customer.reserva.bookCta")}</p>
                  </>
                )}
              </div>
            );

            return isComingSoon ? (
              <div key={b.id} className="opacity-75 cursor-not-allowed">{card}</div>
            ) : (
              <Link key={b.id} href={`/reserva/${b.slug}`} className="block">
                {card}
              </Link>
            );
          })}
        </div>

        <div className="flex justify-center mt-8">
          <LangToggle variant="dark" />
        </div>
      </div>
    </main>
  );
}
