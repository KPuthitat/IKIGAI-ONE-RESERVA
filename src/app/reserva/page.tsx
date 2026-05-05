import Link from "next/link";
import type { Metadata } from "next";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import LangToggle from "../LangToggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "จองโต๊ะ · RESERVA" };

export default function CustomerReservaPage() {
  const lang = getLang();
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  const nama = branches.find((b) => b.slug === "nama-sriracha");
  const others = branches.filter((b) => b.slug !== "nama-sriracha");

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

        {/* NAMA primary */}
        {nama && (
          <Link
            href={`/reserva/${nama.slug}`}
            className="card hover:shadow-2xl transition group block mb-3"
          >
            <div className="text-[11px] tracking-[2px] text-brand font-bold mb-1">
              {t(lang, "customer.reserva.featured")}
            </div>
            <h2 className="text-2xl font-bold text-slate-800 group-hover:text-brand transition-colors">
              {nama.name}
            </h2>
            <p className="text-slate-500 text-sm mt-1">
              {t(lang, "customer.reserva.openHours", { open: nama.open_time, close: nama.close_time })}
            </p>
            <p className="mt-4 text-brand font-bold">{t(lang, "customer.reserva.bookCta")}</p>
          </Link>
        )}

        {others.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-3">
            {others.map((b) => (
              <Link
                key={b.id}
                href={`/reserva/${b.slug}`}
                className="bg-white/[.06] hover:bg-white/[.1] border border-white/[.12] rounded-2xl p-5 transition block"
              >
                <h3 className="text-white font-bold">{b.name}</h3>
                <p className="text-white/60 text-xs mt-1">
                  {t(lang, "customer.reserva.openHours", { open: b.open_time, close: b.close_time })}
                </p>
              </Link>
            ))}
          </div>
        )}

        <div className="flex justify-center mt-8">
          <LangToggle variant="dark" />
        </div>
      </div>
    </main>
  );
}
