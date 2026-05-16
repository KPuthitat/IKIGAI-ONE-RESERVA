import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0";
const BUILD_TIME = process.env.NEXT_PUBLIC_BUILD_TIME || "";

// Format ISO timestamp → "May 07, 2026 14.30" (Bangkok local, dot for
// time). Mirrors Footer.tsx so the displayed value stays consistent
// between the desktop footer and the mobile sidebar variant.
function formatBuildTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
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

// Compact program metadata (version / copyright / last update /
// powered-by) for the BOTTOM of the mobile slide-in sidebar.
//
// On mobile the full-width <Footer> is hidden (it crowded the already
// cramped main content area), so this keeps the same info available
// one tap away inside the sidebar without taking screen real estate
// from the page itself. Styled for the dark bg-ink-gradient sidebar.
export default function ProgramInfo() {
  const lang = getLang();
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).getUTCFullYear();
  const lastUpdate = formatBuildTime(BUILD_TIME);

  return (
    <div className="space-y-0.5 text-[10px] text-white/40 leading-snug">
      <div className="font-bold text-white/60">
        IKIGAI OS{" "}
        <span className="font-normal">
          {t(lang, "footer.version", { v: APP_VERSION })}
        </span>
      </div>
      <div>
        © {year} IKIGAI MEDIHEALTH · {t(lang, "footer.allRightsReserved")}
      </div>
      {lastUpdate && (
        <div>{t(lang, "footer.lastUpdate", { date: lastUpdate })}</div>
      )}
      <div>
        {t(lang, "footer.poweredBy")}{" "}
        <a
          href="https://ikigaimedihealth.com"
          target="_blank"
          rel="noopener"
          className="text-white/60 hover:text-brand transition-colors"
        >
          IKIGAI MEDIHEALTH
        </a>
      </div>
    </div>
  );
}
