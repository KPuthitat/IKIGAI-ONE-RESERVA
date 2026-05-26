import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { rowsToCsv, type CsvCell } from "@/lib/csv";
import { todayBkk } from "@/lib/time";
import { nameWithPrefix } from "@/lib/name";
import ReportToolbar, { type StaffOpt } from "../ReportToolbar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รายงานการลา · PERSONA" };

type LeaveRow = {
  ref_no: string | null;
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  type: string;
  date_from: string;
  date_to: string;
  days: number;
  hours: number | null;
  decided_at: string | null;
  is_special_request: number;
};

function monthRange(month: string): { from: string; to: string } {
  // month = "YYYY-MM" → from = first day, to = last day
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  // Last day of month: day 0 of next month
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function leaveTypeLabel(code: string, lang: Lang): string {
  return t(lang, `leave.type.${code}` as any);
}

function formatBkkDate(iso: string | null, lang: Lang): string {
  if (!iso) return "";
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const date = bkk.toISOString().slice(0, 10);
  if (lang === "th") {
    const [y, m, dd] = date.split("-");
    return `${dd}/${m}/${String(Number(y) + 543).slice(2)}`;
  }
  return date;
}

export default function LeaveReportPage({
  searchParams
}: {
  searchParams: { month?: string; user_id?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const today = todayBkk();
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "")
    ? searchParams.month!
    : today.slice(0, 7);
  const userIdFilter = searchParams.user_id ? Number(searchParams.user_id) : null;

  const { from, to } = monthRange(month);

  // Pull approved leave with date_from within the month
  // (Note: leave that spans into next month is still counted in its start month)
  const params: Array<string | number> = [from, to];
  let userClause = "";
  if (userIdFilter) {
    userClause = "AND r.user_id = ?";
    params.push(userIdFilter);
  }

  const rows = db.prepare(`
    SELECT r.ref_no, r.user_id, u.display_name, u.title_prefix, r.type, r.date_from, r.date_to,
           r.days, r.hours, r.decided_at, r.is_special_request
    FROM leave_requests r
    JOIN users u ON r.user_id = u.id
    WHERE r.status = 'approved'
      AND r.date_from >= ? AND r.date_from <= ? ${userClause}
    ORDER BY r.date_from,
             CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all(...params) as LeaveRow[];

  // Staff dropdown
  const staffList = db.prepare(`
    SELECT id, display_name, title_prefix FROM users
    WHERE role = 'staff' AND is_test_account = 0
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `).all() as StaffOpt[];

  // Aggregations
  const totalRequests = rows.length;
  const totalDays = rows.reduce((sum, r) => sum + r.days, 0);
  const totalHours = rows.reduce((sum, r) => sum + (r.hours ?? 0), 0);

  const byType: Record<string, { count: number; days: number; hours: number }> = {};
  for (const r of rows) {
    if (!byType[r.type]) byType[r.type] = { count: 0, days: 0, hours: 0 };
    byType[r.type].count += 1;
    byType[r.type].days += r.days;
    byType[r.type].hours += r.hours ?? 0;
  }
  const typesSorted = Object.entries(byType).sort((a, b) => b[1].days - a[1].days);

  // Build CSV (server-side, pass to client for download)
  const csvHeaders = [
    t(lang, "admin.persona.reports.leave.col.refNo"),
    t(lang, "admin.persona.reports.leave.col.employee"),
    t(lang, "admin.persona.reports.leave.col.type"),
    t(lang, "admin.persona.reports.leave.col.from"),
    t(lang, "admin.persona.reports.leave.col.to"),
    t(lang, "admin.persona.reports.leave.col.days"),
    t(lang, "admin.persona.reports.leave.col.hours"),
    t(lang, "admin.persona.reports.leave.col.decidedAt"),
    t(lang, "admin.persona.reports.leave.col.special")
  ];
  const csvRows: CsvCell[][] = rows.map((r) => [
    r.ref_no ?? "",
    nameWithPrefix(r.title_prefix, r.display_name),
    leaveTypeLabel(r.type, lang),
    r.date_from,
    r.date_to,
    r.days,
    r.hours ?? "",
    r.decided_at ? r.decided_at.slice(0, 10) : "",
    r.is_special_request === 1 ? "★" : ""
  ]);
  const csv = rowsToCsv(csvHeaders, csvRows);
  const csvFilename = `leave-${month}${userIdFilter ? `-u${userIdFilter}` : ""}.csv`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/reports" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.reports.backToHub")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.reports.leave.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.reports.leave.desc")}
        </p>
      </div>

      <ReportToolbar
        lang={lang}
        month={month}
        userId={userIdFilter}
        staffList={staffList}
        csv={csv}
        csvFilename={csvFilename}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.leave.summary.requests")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalRequests}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.leave.summary.totalDays")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">
            {totalDays.toFixed(totalDays % 1 ? 1 : 0)}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.leave.summary.totalHours")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">
            {totalHours > 0 ? totalHours.toFixed(1) : "-"}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.leave.summary.types")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{typesSorted.length}</div>
        </div>
      </div>

      {/* Breakdown by type */}
      {typesSorted.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-2">
            {t(lang, "admin.persona.reports.leave.byType")}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            {typesSorted.map(([code, agg]) => (
              <div key={code} className="bg-slate-50 rounded-md px-3 py-2">
                <div className="text-xs text-slate-500">{leaveTypeLabel(code, lang)}</div>
                <div className="font-bold text-slate-800">
                  {agg.days.toFixed(agg.days % 1 ? 1 : 0)} {t(lang, "leave.unit.days")}
                  {agg.hours > 0 && (
                    <span className="text-slate-500 font-normal ml-1">
                      ({agg.hours.toFixed(1)} {t(lang, "leave.unit.hours")})
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-400">
                  {agg.count} {t(lang, "admin.persona.reports.leave.requestsLabel")}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detail table */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.reports.leave.detail")}
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {t(lang, "admin.persona.reports.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.leave.col.refNo")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.leave.col.employee")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.leave.col.type")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.leave.col.dates")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.leave.col.days")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.leave.col.hours")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.leave.col.decidedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-500">
                      {r.ref_no ?? ""}
                    </td>
                    <td className="py-2 pr-3 font-medium">{nameWithPrefix(r.title_prefix, r.display_name)}</td>
                    <td className="py-2 pr-3">
                      {leaveTypeLabel(r.type, lang)}
                      {r.is_special_request === 1 && (
                        <span className="ml-1 text-[10px] text-violet-700">★</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {r.date_from === r.date_to
                        ? formatBkkDate(`${r.date_from}T00:00:00Z`, lang)
                        : `${formatBkkDate(`${r.date_from}T00:00:00Z`, lang)} → ${formatBkkDate(`${r.date_to}T00:00:00Z`, lang)}`}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {r.days % 1 ? r.days.toFixed(1) : r.days}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {r.hours != null ? r.hours.toFixed(1) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-slate-500 text-xs">
                      {r.decided_at ? formatBkkDate(r.decided_at, lang) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
