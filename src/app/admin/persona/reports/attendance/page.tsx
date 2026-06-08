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

export const metadata: Metadata = { title: "รายงานการมาทำงาน · PERSONA" };

type StaffUser = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: string | null;
  weekly_off_days: string | null;       // CSV "1,2"
};

function parseOffSet(csv: string | null): Set<number> {
  const s = new Set<number>();
  if (!csv) return s;
  for (const tok of csv.split(",")) {
    const n = Number(tok.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 6) s.add(n);
  }
  return s;
}

type ApprovedLeave = {
  user_id: number;
  date_from: string;
  date_to: string;
};

function monthRange(month: string): { from: string; to: string; days: string[] } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= lastDay; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return {
    from: days[0],
    to: days[days.length - 1],
    days
  };
}

function dayOfWeek(date: string): number {
  // 0=Sun, ..., 6=Sat — using UTC interpretation (date is YYYY-MM-DD)
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function bkkDateOf(iso: string): string {
  const ms = new Date(iso).getTime() + 7 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function employmentTypeLabel(et: string | null, lang: Lang): string {
  if (et === "ft") return t(lang, "admin.persona.employees.employment.ft");
  if (et === "pt") return t(lang, "admin.persona.employees.employment.pt");
  return t(lang, "admin.persona.employees.unset");
}

export default function AttendanceReportPage({
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

  const { from, to, days } = monthRange(month);
  const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59+07:00`).toISOString();

  // Staff users (only those with employment_type set get attendance
  // tracking) — scoped to the admin's ACTIVE branch via user_branches
  // so an AT-HOME admin doesn't see NAMA staff in the attendance
  // report (previous version returned every staff in the system).
  let staffSql = `
    SELECT u.id, u.display_name, u.title_prefix, u.employment_type, u.weekly_off_days
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type IS NOT NULL
      AND u.is_test_account = 0
  `;
  const staffParams: Array<string | number> = [activeBranchId];
  if (userIdFilter) {
    staffSql += " AND u.id = ?";
    staffParams.push(userIdFilter);
  }
  staffSql += " ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END, u.display_name";
  const staff = db.prepare(staffSql).all(...staffParams) as StaffUser[];

  // Public holidays in month (only ones business considers off)
  const holidays = db.prepare(`
    SELECT date FROM public_holidays
    WHERE date >= ? AND date <= ? AND is_workday = 0
  `).all(from, to) as Array<{ date: string }>;
  const holidaySet = new Set(holidays.map((h) => h.date));

  // Approved leave covering days in month, per user
  const leaves = db.prepare(`
    SELECT user_id, date_from, date_to
    FROM leave_requests
    WHERE status = 'approved'
      AND NOT (date_to < ? OR date_from > ?)
  `).all(from, to) as ApprovedLeave[];
  // Map user_id → Set of YYYY-MM-DD covered
  const leaveByUser = new Map<number, Set<string>>();
  for (const lv of leaves) {
    if (!leaveByUser.has(lv.user_id)) leaveByUser.set(lv.user_id, new Set());
    const set = leaveByUser.get(lv.user_id)!;
    // Iterate days from max(from, date_from) to min(to, date_to)
    const start = lv.date_from < from ? from : lv.date_from;
    const end = lv.date_to > to ? to : lv.date_to;
    let cur = start;
    while (cur <= end) {
      set.add(cur);
      // Increment by one day (string math via Date)
      const nd = new Date(`${cur}T00:00:00Z`);
      nd.setUTCDate(nd.getUTCDate() + 1);
      cur = nd.toISOString().slice(0, 10);
    }
  }

  // Clock-in days per user — scoped to admin's active branch so
  // attendance counts reflect work AT THIS BRANCH only (a staff
  // who works at NAMA in the morning and HYPO in the afternoon
  // should count once at NAMA's report and once at HYPO's).
  const clockIns = db.prepare(`
    SELECT user_id, ts FROM time_entries
    WHERE type = 'in' AND branch_id = ? AND ts >= ? AND ts <= ?
  `).all(activeBranchId, fromIso, toIso) as Array<{ user_id: number; ts: string }>;
  const workedByUser = new Map<number, Set<string>>();
  for (const ci of clockIns) {
    if (!workedByUser.has(ci.user_id)) workedByUser.set(ci.user_id, new Set());
    workedByUser.get(ci.user_id)!.add(bkkDateOf(ci.ts));
  }

  // Roster-scheduled day-offs in the month (owner 2026-06-08). The
  // schedule's "วันหยุด" must count as off — previously only the static
  // weekly_off_days were considered, so a roster day-off with no clock-in
  // was wrongly counted as ขาดงาน (absent).
  const dayOffRows = db.prepare(`
    SELECT ra.user_id, ra.assignment_date AS d
    FROM roster_assignments ra
    JOIN shift_codes sc ON sc.id = ra.shift_code_id
    WHERE ra.branch_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
      AND sc.kind = 'day_off'
  `).all(activeBranchId, from, to) as Array<{ user_id: number; d: string }>;
  const dayOffByUser = new Map<number, Set<string>>();
  for (const r of dayOffRows) {
    if (!dayOffByUser.has(r.user_id)) dayOffByUser.set(r.user_id, new Set());
    dayOffByUser.get(r.user_id)!.add(r.d);
  }

  // Classify each day for each user
  type Counts = {
    worked: number; leave: number; off: number; holiday: number; absent: number; future: number;
  };
  const userCounts = new Map<number, Counts>();
  for (const u of staff) {
    const counts: Counts = { worked: 0, leave: 0, off: 0, holiday: 0, absent: 0, future: 0 };
    const userLeaves = leaveByUser.get(u.id) ?? new Set();
    const userWorked = workedByUser.get(u.id) ?? new Set();
    const userDayOff = dayOffByUser.get(u.id) ?? new Set();
    const offSet = parseOffSet(u.weekly_off_days);

    for (const d of days) {
      // Future dates → don't penalize as absent
      if (d > today) { counts.future++; continue; }
      // Priority order:
      // 1. holiday
      if (holidaySet.has(d)) { counts.holiday++; continue; }
      // 2. day off — either the static weekly_off_days OR a roster-
      //    scheduled day_off assignment (owner 2026-06-08).
      if ((offSet.size > 0 && offSet.has(dayOfWeek(d))) || userDayOff.has(d)) {
        counts.off++; continue;
      }
      // 3. leave (approved)
      if (userLeaves.has(d)) { counts.leave++; continue; }
      // 4. worked
      if (userWorked.has(d)) { counts.worked++; continue; }
      // 5. absent
      counts.absent++;
    }
    userCounts.set(u.id, counts);
  }

  // Staff list for dropdown — same branch scope as the report data
  // itself. Showing every staff in the system would let admin pick
  // a sibling-branch user and see (empty) zero counts; better to
  // hide them entirely so the picker only lists relevant people.
  const staffList = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.is_test_account = 0
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all(activeBranchId) as StaffOpt[];

  // Aggregations
  const totals = { worked: 0, leave: 0, off: 0, holiday: 0, absent: 0 };
  for (const c of userCounts.values()) {
    totals.worked += c.worked;
    totals.leave += c.leave;
    totals.off += c.off;
    totals.holiday += c.holiday;
    totals.absent += c.absent;
  }

  // CSV
  const csvHeaders = [
    t(lang, "admin.persona.reports.attendance.col.employee"),
    t(lang, "admin.persona.reports.attendance.col.employmentType"),
    t(lang, "admin.persona.reports.attendance.col.worked"),
    t(lang, "admin.persona.reports.attendance.col.leave"),
    t(lang, "admin.persona.reports.attendance.col.off"),
    t(lang, "admin.persona.reports.attendance.col.holiday"),
    t(lang, "admin.persona.reports.attendance.col.absent")
  ];
  const csvRows: CsvCell[][] = staff.map((u) => {
    const c = userCounts.get(u.id)!;
    return [
      nameWithPrefix(u.title_prefix, u.display_name),
      employmentTypeLabel(u.employment_type, lang),
      c.worked,
      c.leave,
      c.off,
      c.holiday,
      c.absent
    ];
  });
  const csv = rowsToCsv(csvHeaders, csvRows);
  const csvFilename = `attendance-${month}${userIdFilter ? `-u${userIdFilter}` : ""}.csv`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/reports" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.reports.backToHub")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.reports.attendance.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.reports.attendance.desc")}
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
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.attendance.col.worked")}
          </div>
          <div className="text-2xl font-bold mt-1 text-emerald-600">{totals.worked}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.attendance.col.leave")}
          </div>
          <div className="text-2xl font-bold mt-1 text-amber-600">{totals.leave}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.attendance.col.off")}
          </div>
          <div className="text-2xl font-bold mt-1 text-slate-500">{totals.off}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.attendance.col.holiday")}
          </div>
          <div className="text-2xl font-bold mt-1 text-violet-600">{totals.holiday}</div>
        </div>
        <div className="card">
          <div className="text-xs text-slate-500">
            {t(lang, "admin.persona.reports.attendance.col.absent")}
          </div>
          <div className={`text-2xl font-bold mt-1 ${totals.absent > 0 ? "text-rose-600" : "text-slate-300"}`}>
            {totals.absent}
          </div>
        </div>
      </div>

      {/* Detail table */}
      <div className="card">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.reports.attendance.detail")}
        </h2>
        {staff.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {t(lang, "admin.persona.reports.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.attendance.col.employee")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.reports.attendance.col.employmentType")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.attendance.col.worked")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.attendance.col.leave")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.attendance.col.off")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.attendance.col.holiday")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.reports.attendance.col.absent")}</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((u) => {
                  const c = userCounts.get(u.id)!;
                  return (
                    <tr key={u.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-3 font-medium">{nameWithPrefix(u.title_prefix, u.display_name)}</td>
                      <td className="py-2 pr-3 text-slate-600">{employmentTypeLabel(u.employment_type, lang)}</td>
                      <td className="py-2 pr-3 text-right text-emerald-700 font-medium">{c.worked}</td>
                      <td className="py-2 pr-3 text-right text-amber-700">{c.leave}</td>
                      <td className="py-2 pr-3 text-right text-slate-500">{c.off}</td>
                      <td className="py-2 pr-3 text-right text-violet-700">{c.holiday}</td>
                      <td className={`py-2 pr-3 text-right ${c.absent > 0 ? "text-rose-600 font-medium" : "text-slate-300"}`}>
                        {c.absent}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-slate-400 mt-3">
          {t(lang, "admin.persona.reports.attendance.note")}
        </p>
      </div>
    </div>
  );
}
