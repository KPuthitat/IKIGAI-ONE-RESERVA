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

export const metadata: Metadata = { title: "รายงานชั่วโมงทำงาน · PERSONA" };

type Entry = {
  user_id: number;
  ts: string;
  type: "in" | "out";
  display_name: string;
  title_prefix: string | null;
  employment_type: string | null;
};

type UserSummary = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: string | null;
  totalHours: number;
  daysWorked: number;
  pairCount: number;
  unpairedIns: number;     // clocked in without matching out
};

function monthRange(month: string): { fromIso: string; toIso: string } {
  const [y, m] = month.split("-").map(Number);
  const fromIso = new Date(`${month}-01T00:00:00+07:00`).toISOString();
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const to = `${month}-${String(lastDay).padStart(2, "0")}`;
  const toIso = new Date(`${to}T23:59:59+07:00`).toISOString();
  return { fromIso, toIso };
}

function bkkDate(iso: string): string {
  // Get Bangkok-local YYYY-MM-DD from ISO
  const ms = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function aggregateByUser(entries: Entry[]): Map<number, UserSummary> {
  // Group by user, sort by ts
  const byUser = new Map<number, Entry[]>();
  for (const e of entries) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id)!.push(e);
  }

  const out = new Map<number, UserSummary>();
  for (const [uid, list] of byUser) {
    list.sort((a, b) => a.ts.localeCompare(b.ts));
    let totalMs = 0;
    let pairs = 0;
    let unpairedIns = 0;
    let openIn: string | null = null;
    const daysWithWork = new Set<string>();

    for (const e of list) {
      if (e.type === "in") {
        if (openIn !== null) {
          // double "in" — discard previous open
          unpairedIns++;
        }
        openIn = e.ts;
      } else {
        // "out"
        if (openIn !== null) {
          const dur = new Date(e.ts).getTime() - new Date(openIn).getTime();
          if (dur > 0) {
            totalMs += dur;
            daysWithWork.add(bkkDate(openIn));
            pairs++;
          }
          openIn = null;
        }
        // unmatched out — ignore
      }
    }
    // Still-open shift at end of period
    if (openIn !== null) unpairedIns++;

    out.set(uid, {
      user_id: uid,
      display_name: list[0].display_name,
      title_prefix: list[0].title_prefix,
      employment_type: list[0].employment_type,
      totalHours: totalMs / 3_600_000,
      daysWorked: daysWithWork.size,
      pairCount: pairs,
      unpairedIns
    });
  }
  return out;
}

function employmentTypeLabel(et: string | null, lang: Lang): string {
  if (et === "ft") return t(lang, "admin.persona.employees.employment.ft");
  if (et === "pt") return t(lang, "admin.persona.employees.employment.pt");
  return t(lang, "admin.persona.employees.unset");
}

export default function HoursReportPage({
  searchParams
}: {
  searchParams: { month?: string; user_id?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const activeBranchId = user.activeBranchId;

  const today = todayBkk();
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "")
    ? searchParams.month!
    : today.slice(0, 7);
  const userIdFilter = searchParams.user_id ? Number(searchParams.user_id) : null;

  const { fromIso, toIso } = monthRange(month);

  // Scope entries to admin's active branch (same as attendance
  // report). Previously returned every staff's hours globally —
  // an AT-HOME admin could see NAMA staff's work hours.
  const params: Array<string | number> = [activeBranchId, fromIso, toIso];
  let userClause = "";
  if (userIdFilter) {
    userClause = "AND te.user_id = ?";
    params.push(userIdFilter);
  }

  const entries = db.prepare(`
    SELECT te.user_id, te.ts, te.type, u.display_name, u.title_prefix, u.employment_type
    FROM time_entries te
    JOIN users u ON te.user_id = u.id
    WHERE te.branch_id = ? AND te.ts >= ? AND te.ts <= ? ${userClause}
    ORDER BY te.user_id, te.ts
  `).all(...params) as Entry[];

  const summaries = aggregateByUser(entries);
  const summaryRows = Array.from(summaries.values()).sort((a, b) => {
    const orderA = a.employment_type === "ft" ? 0 : a.employment_type === "pt" ? 1 : 2;
    const orderB = b.employment_type === "ft" ? 0 : b.employment_type === "pt" ? 1 : 2;
    if (orderA !== orderB) return orderA - orderB;
    return a.display_name.localeCompare(b.display_name, "th");
  });

  // Staff list for dropdown — scoped to admin's active branch.
  const staffList = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role = 'staff'
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all(activeBranchId) as StaffOpt[];

  // Aggregations
  const totalEmployees = summaryRows.length;
  const totalHours = summaryRows.reduce((s, r) => s + r.totalHours, 0);
  const avgHours = totalEmployees ? totalHours / totalEmployees : 0;
  const totalUnpaired = summaryRows.reduce((s, r) => s + r.unpairedIns, 0);

  // CSV
  const csvHeaders = [
    t(lang, "admin.persona.reports.hours.col.employee"),
    t(lang, "admin.persona.reports.hours.col.employmentType"),
    t(lang, "admin.persona.reports.hours.col.totalHours"),
    t(lang, "admin.persona.reports.hours.col.daysWorked"),
    t(lang, "admin.persona.reports.hours.col.avgPerDay"),
    t(lang, "admin.persona.reports.hours.col.shifts"),
    t(lang, "admin.persona.reports.hours.col.unpaired")
  ];
  const csvRows: CsvCell[][] = summaryRows.map((r) => [
    nameWithPrefix(r.title_prefix, r.display_name),
    employmentTypeLabel(r.employment_type, lang),
    r.totalHours.toFixed(2),
    r.daysWorked,
    r.daysWorked > 0 ? (r.totalHours / r.daysWorked).toFixed(2) : "0",
    r.pairCount,
    r.unpairedIns
  ]);
  const csv = rowsToCsv(csvHeaders, csvRows);
  const csvFilename = `hours-${month}${userIdFilter ? `-u${userIdFilter}` : ""}.csv`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/reports" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.reports.backToHub")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.reports.hours.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.reports.hours.desc")}
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
            {t(lang, "admin.persona.reports.hours.summary.employees")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalEmployees}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.hours.summary.totalHours")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalHours.toFixed(1)}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.hours.summary.avgPerEmp")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{avgHours.toFixed(1)}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.hours.summary.unpaired")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${totalUnpaired > 0 ? "text-amber-600" : "text-slate-300"}`}>
            {totalUnpaired}
          </div>
        </div>
      </div>

      {/* Detail table */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.reports.hours.detail")}
        </h2>
        {summaryRows.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {t(lang, "admin.persona.reports.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.hours.col.employee")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.hours.col.employmentType")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.hours.col.totalHours")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.hours.col.daysWorked")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.hours.col.avgPerDay")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.hours.col.shifts")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.hours.col.unpaired")}</th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.map((r) => (
                  <tr key={r.user_id} className="border-b border-slate-100 last:border-0">
                    <td className="py-2 pr-3 font-medium">{nameWithPrefix(r.title_prefix, r.display_name)}</td>
                    <td className="py-2 pr-3 text-slate-600">
                      {employmentTypeLabel(r.employment_type, lang)}
                    </td>
                    <td className="py-2 pr-3 text-right font-medium">{r.totalHours.toFixed(1)}</td>
                    <td className="py-2 pr-3 text-right">{r.daysWorked}</td>
                    <td className="py-2 pr-3 text-right">
                      {r.daysWorked > 0 ? (r.totalHours / r.daysWorked).toFixed(1) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right text-slate-500">{r.pairCount}</td>
                    <td className={`py-2 pr-3 text-right ${r.unpairedIns > 0 ? "text-amber-600 font-medium" : "text-slate-300"}`}>
                      {r.unpairedIns}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {totalUnpaired > 0 && (
          <p className="text-xs text-amber-700 mt-3">
            ⚠️ {t(lang, "admin.persona.reports.hours.unpairedHint")}
          </p>
        )}
      </div>
    </div>
  );
}
