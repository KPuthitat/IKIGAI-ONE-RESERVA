import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import { rowsToCsv, type CsvCell } from "@/lib/csv";
import { todayBkk } from "@/lib/time";
import { nameWithPrefix } from "@/lib/name";
import QuotaToolbar from "./QuotaToolbar";
import type { StaffOpt } from "../ReportToolbar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "โควตาการลา · PERSONA" };

type StaffUser = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  gender: string | null;
  employment_type: string | null;
};

type LeaveType = {
  code: string;
  default_quota_days: number | null;
  gender_eligibility: "all" | "male" | "female";
  employment_eligibility: "all" | "pt" | "ft";
  sort_order: number;
};

type QuotaOverride = {
  user_id: number;
  type: string;
  quota_days: number;
};

type LeaveSum = {
  user_id: number;
  type: string;
  total_days: number;
};

function isEligible(u: StaffUser, lt: LeaveType): boolean {
  if (lt.gender_eligibility !== "all" && lt.gender_eligibility !== u.gender) return false;
  if (lt.employment_eligibility !== "all" && lt.employment_eligibility !== u.employment_type) return false;
  return true;
}

function leaveTypeLabel(code: string, lang: Lang): string {
  return t(lang, `leave.type.${code}` as any);
}

export default function QuotaReportPage({
  searchParams
}: {
  searchParams: { year?: string; user_id?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const today = todayBkk();
  const currentYear = Number(today.slice(0, 4));
  const year = searchParams.year && /^\d{4}$/.test(searchParams.year)
    ? Number(searchParams.year)
    : currentYear;
  const userIdFilter = searchParams.user_id ? Number(searchParams.user_id) : null;

  const yearFrom = `${year}-01-01`;
  const yearTo = `${year}-12-31`;

  // Staff users (only those with employment_type set)
  let staffSql = `
    SELECT id, display_name, title_prefix, gender, employment_type
    FROM users
    WHERE role = 'staff' AND employment_type IS NOT NULL
  `;
  const staffParams: Array<string | number> = [];
  if (userIdFilter) {
    staffSql += " AND id = ?";
    staffParams.push(userIdFilter);
  }
  staffSql += " ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END, display_name";
  const staff = db.prepare(staffSql).all(...staffParams) as StaffUser[];

  // Leave types catalog
  const leaveTypes = db.prepare(`
    SELECT code, default_quota_days, gender_eligibility, employment_eligibility, sort_order
    FROM leave_types
    ORDER BY sort_order
  `).all() as LeaveType[];

  // Quota overrides
  const overrides = db.prepare(`
    SELECT user_id, type, quota_days FROM user_leave_quotas
  `).all() as QuotaOverride[];
  const overrideMap = new Map<string, number>();
  for (const o of overrides) overrideMap.set(`${o.user_id}|${o.type}`, o.quota_days);

  // Used days per (user, type) within the year (approved only)
  const sums = db.prepare(`
    SELECT user_id, type, SUM(days) AS total_days
    FROM leave_requests
    WHERE status = 'approved'
      AND date_from >= ? AND date_from <= ?
    GROUP BY user_id, type
  `).all(yearFrom, yearTo) as LeaveSum[];
  const usedMap = new Map<string, number>();
  for (const s of sums) usedMap.set(`${s.user_id}|${s.type}`, s.total_days);

  // Build long-format rows
  type Row = {
    user_id: number;
    display_name: string;
    title_prefix: string | null;
    type: string;
    quota: number | null;
    used: number;
    balance: number | null;
    isOverride: boolean;
  };
  const rows: Row[] = [];
  for (const u of staff) {
    for (const lt of leaveTypes) {
      if (!isEligible(u, lt)) continue;
      const overrideQuota = overrideMap.get(`${u.id}|${lt.code}`);
      const quota = overrideQuota !== undefined ? overrideQuota : lt.default_quota_days;
      const used = usedMap.get(`${u.id}|${lt.code}`) ?? 0;
      const balance = quota !== null ? quota - used : null;
      rows.push({
        user_id: u.id,
        display_name: u.display_name,
        title_prefix: u.title_prefix,
        type: lt.code,
        quota,
        used,
        balance,
        isOverride: overrideQuota !== undefined
      });
    }
  }

  // Staff list for dropdown (full list, not just filtered)
  const staffList = db.prepare(`
    SELECT id, display_name, title_prefix FROM users WHERE role = 'staff'
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `).all() as StaffOpt[];

  // Year options — current ± 1
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  // Aggregations
  const totalEmployees = staff.length;
  const totalUsed = rows.reduce((s, r) => s + r.used, 0);
  const overdrawn = rows.filter((r) => r.balance !== null && r.balance < 0).length;
  const lowBalance = rows.filter(
    (r) => r.balance !== null && r.balance > 0 && r.balance <= 1
  ).length;

  // CSV
  const csvHeaders = [
    t(lang, "admin.persona.reports.quota.col.employee"),
    t(lang, "admin.persona.reports.quota.col.type"),
    t(lang, "admin.persona.reports.quota.col.quota"),
    t(lang, "admin.persona.reports.quota.col.used"),
    t(lang, "admin.persona.reports.quota.col.balance"),
    t(lang, "admin.persona.reports.quota.col.overrideFlag")
  ];
  const csvRows: CsvCell[][] = rows.map((r) => [
    nameWithPrefix(r.title_prefix, r.display_name),
    leaveTypeLabel(r.type, lang),
    r.quota ?? "",
    r.used,
    r.balance ?? "",
    r.isOverride ? "*" : ""
  ]);
  const csv = rowsToCsv(csvHeaders, csvRows);
  const csvFilename = `quota-${year}${userIdFilter ? `-u${userIdFilter}` : ""}.csv`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/reports" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.reports.backToHub")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.reports.quota.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.reports.quota.desc")}
        </p>
      </div>

      <QuotaToolbar
        lang={lang}
        year={year}
        userId={userIdFilter}
        staffList={staffList}
        csv={csv}
        csvFilename={csvFilename}
        yearOptions={yearOptions}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.quota.summary.employees")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalEmployees}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.quota.summary.totalUsed")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-800">{totalUsed.toFixed(totalUsed % 1 ? 1 : 0)}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.quota.summary.lowBalance")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${lowBalance > 0 ? "text-amber-600" : "text-slate-300"}`}>
            {lowBalance}
          </div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.quota.summary.overdrawn")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${overdrawn > 0 ? "text-rose-600" : "text-slate-300"}`}>
            {overdrawn}
          </div>
        </div>
      </div>

      {/* Detail table */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.reports.quota.detail")}
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
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.quota.col.employee")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.quota.col.type")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.quota.col.quota")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.quota.col.used")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.quota.col.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const balanceColor =
                    r.balance === null ? "text-slate-400" :
                    r.balance < 0 ? "text-rose-600 font-bold" :
                    r.balance <= 1 ? "text-amber-600 font-medium" :
                    "text-emerald-700";
                  // Visual divider between users
                  const prevUser = i > 0 ? rows[i - 1].user_id : null;
                  const isFirstOfUser = prevUser !== r.user_id;
                  return (
                    <tr key={i} className={`border-b border-slate-100 last:border-0 ${isFirstOfUser ? "border-t-2 border-t-slate-200" : ""}`}>
                      <td className="py-2 pr-3 font-medium">
                        {isFirstOfUser ? nameWithPrefix(r.title_prefix, r.display_name) : ""}
                      </td>
                      <td className="py-2 pr-3 text-slate-600">
                        {leaveTypeLabel(r.type, lang)}
                        {r.isOverride && (
                          <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-sky-100 text-sky-700">
                            {t(lang, "admin.persona.reports.quota.overrideTag")}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {r.quota !== null ? (r.quota % 1 ? r.quota.toFixed(1) : r.quota) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        {r.used > 0 ? (r.used % 1 ? r.used.toFixed(1) : r.used) : <span className="text-slate-300">0</span>}
                      </td>
                      <td className={`py-2 pr-3 text-right ${balanceColor}`}>
                        {r.balance !== null ? (r.balance % 1 ? r.balance.toFixed(1) : r.balance) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-400 mt-3">
          {t(lang, "admin.persona.reports.quota.note")}
        </p>
      </div>
    </div>
  );
}
