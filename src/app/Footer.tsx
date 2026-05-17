import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "";

// Format ISO timestamp → "May 07, 2026 14.30" (Bangkok local, dot for time)
function formatBuildTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const bkkMs = d.getTime() + 7 * 60 * 60 * 1000;
  const bkk = new Date(bkkMs);
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  const month = monthNames[bkk.getUTCMonth()];
  const day = String(bkk.getUTCDate()).padStart(2, "0");
  const year = bkk.getUTCFullYear();
  const hour = String(bkk.getUTCHours()).padStart(2, "0");
  const minute = String(bkk.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${year} ${hour}.${minute}`;
}

export default function Footer() {
  const lang = getLang();
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCFullYear();
  const lastUpdate = formatBuildTime(BUILD_TIME);

  return (
    <footer className="bg-ink-gradient text-white/80 border-t border-white/10 mt-auto">
      {/* Mobile (base): a single tidy centred column with even spacing
          + safe-area bottom padding (booking pages are opened on phones
          and the OS home indicator was crowding the last line). The
          admin/staff shells hide this footer below md and show
          ProgramInfo in the sidebar instead, so this mobile styling now
          only affects the public booking + login pages. Desktop (sm+)
          keeps the original 3-column grid untouched. */}
      <div className="max-w-6xl mx-auto px-4 py-4
        pb-[max(1rem,env(safe-area-inset-bottom))]
        flex flex-col items-center gap-1.5 text-center text-[11px]
        sm:grid sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:gap-3
        sm:text-left sm:text-xs sm:py-3 sm:pb-3">

        {/* Brand + version + copyright */}
        <div className="flex items-center gap-2 justify-center sm:justify-start">
          <div className="w-7 h-7 rounded-lg bg-brand text-white flex items-center justify-center font-bold leading-none">
            I
          </div>
          <div className="leading-tight">
            <div className="font-bold text-white">
              IKIGAI OS{" "}
              <span className="font-normal text-white/60">
                {t(lang, "footer.version", { v: APP_VERSION })}
              </span>
            </div>
            <div className="text-[10px] text-white/50">
              © {year} IKIGAI MEDIHEALTH · {t(lang, "footer.allRightsReserved")}
            </div>
          </div>
        </div>

        {/* Last updated timestamp */}
        {lastUpdate && (
          <div className="flex items-center justify-center gap-1 text-white/60">
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
            </svg>
            <span>{t(lang, "footer.lastUpdate", { date: lastUpdate })}</span>
          </div>
        )}

        {/* Powered by */}
        <div className="flex items-center justify-center sm:justify-end gap-1 text-white/60">
          <span>{t(lang, "footer.poweredBy")}</span>
          <a
            href="https://ikigaimedihealth.com"
            target="_blank"
            rel="noopener"
            className="font-bold text-white hover:text-brand transition-colors"
          >
            IKIGAI MEDIHEALTH
          </a>
        </div>
      </div>
    </footer>
  );
}
