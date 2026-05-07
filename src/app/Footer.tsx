import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

const APP_VERSION = "1.0";

export default function Footer() {
  const lang = getLang();
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCFullYear();

  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 py-3
        flex flex-col gap-2 text-xs text-slate-500
        sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3">
        {/* Left — brand + version */}
        <div className="flex items-center gap-2 justify-center sm:justify-start">
          <div className="w-7 h-7 rounded-lg bg-brand text-white flex items-center justify-center font-bold leading-none">
            I
          </div>
          <div className="leading-tight">
            <div className="font-bold text-slate-700">IKIGAI OS</div>
            <div className="text-[10px] text-slate-400">
              {t(lang, "footer.version", { v: APP_VERSION })}
            </div>
          </div>
        </div>

        {/* Center — powered by */}
        <div className="flex items-center justify-center gap-1">
          <span className="text-emerald-500">⚡</span>
          <span>{t(lang, "footer.poweredBy")}</span>
          <a
            href="https://ikigaimedihealth.com"
            target="_blank"
            rel="noopener"
            className="font-bold text-slate-700 hover:text-brand transition-colors"
          >
            IKIGAI MEDIHEALTH
          </a>
        </div>

        {/* Right — copyright */}
        <div className="flex items-center justify-center sm:justify-end gap-2">
          <span>© {year}</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[10px] font-medium">
            <svg viewBox="0 0 24 24" className="w-3 h-3 fill-current">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6z" />
            </svg>
            {t(lang, "footer.allRightsReserved")}
          </span>
        </div>
      </div>
    </footer>
  );
}
