import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import HolidaysClient, { type HolidayRow } from "./HolidaysClient";

export const dynamic = "force-dynamic";

export default function AdminHolidaysPage({
  searchParams
}: {
  searchParams: { year?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const currentYear = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 4);
  const year = searchParams.year || currentYear;

  const holidays = db.prepare(`
    SELECT date, name_th, name_en, is_workday, pt_special
    FROM public_holidays
    WHERE substr(date, 1, 4) = ?
    ORDER BY date ASC
  `).all(year) as HolidayRow[];

  // List of years that have holidays (for dropdown)
  const years = db.prepare(`
    SELECT DISTINCT substr(date, 1, 4) AS y FROM public_holidays ORDER BY y DESC
  `).all() as Array<{ y: string }>;
  const yearList = Array.from(new Set([currentYear, ...years.map((r) => r.y)])).sort();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.holidays.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.holidays.subtitle")}
        </p>
      </div>
      <HolidaysClient
        holidays={holidays}
        currentYear={year}
        yearList={yearList}
      />
    </div>
  );
}
