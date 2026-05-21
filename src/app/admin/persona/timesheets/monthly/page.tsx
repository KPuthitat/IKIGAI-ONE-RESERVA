// /admin/persona/timesheets/monthly — monthly late-detection
// summary per staff member for the active branch. Pulls every "in"
// event in the selected month, rolls up late count + total minutes
// late + the 20%-of-scheduled-time service-charge eligibility flag.
//
// Scheduled minutes are computed as (working days in the month) ×
// (assumed 8h shift). A user-configurable shift duration could
// replace the constant later — for now 8h is the labor-law
// assumption already used by the legacy payroll engine.
//
// The page is intentionally read-only — pay-out decisions still
// happen in the existing payroll system. This view exists to give
// admin the visibility to know who's on the bubble before payroll
// closes.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  monthlyLateStatsRoster,
  shiftStartByDateForUserMonth,
  scheduledMinutesByUserForMonth
} from "@/lib/roster";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สถิติการเข้างานของพนักงาน · PERSONA" };

const ASSUMED_SHIFT_MINUTES = 8 * 60; // 8-hour shift, matches payroll engine

type EmployeeRow = {
  user_id: number;
  display_name: string;
  employment_type: string | null;
  shift_start_time: string | null;
};

export default function MonthlyTimesheetPage({
  searchParams
}: {
  searchParams: { month?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  // Default month = current Bangkok month
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const currentMonth = nowBkk.toISOString().slice(0, 7); // 'YYYY-MM'
  const month = searchParams.month || currentMonth;

  // Month bounds in Bangkok local
  const monthStart = `${month}-01T00:00:00+07:00`;
  // Last day of month — JavaScript trick: day 0 of next month = last
  // day of this month.
  const [yyyy, mm] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}T23:59:59+07:00`;
  const monthStartIso = new Date(monthStart).toISOString();
  const monthEndIso = new Date(monthEnd).toISOString();

  // Staff assigned to this branch with their shift settings.
  const employees = db.prepare(`
    SELECT u.id AS user_id, u.display_name, u.employment_type,
           u.shift_start_time
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role = 'staff'
    ORDER BY u.display_name COLLATE NOCASE
  `).all(branch.id) as EmployeeRow[];

  // All "in" events for those users in this month at this branch.
  // Single query then bucket in JS — much faster than N queries.
  const ins = db.prepare(`
    SELECT user_id, ts FROM time_entries
    WHERE branch_id = ? AND type = 'in' AND ts >= ? AND ts <= ?
  `).all(branch.id, monthStartIso, monthEndIso) as
    Array<{ user_id: number; ts: string }>;

  const insByUser = new Map<number, Array<{ ts: string }>>();
  for (const r of ins) {
    if (!insByUser.has(r.user_id)) insByUser.set(r.user_id, []);
    insByUser.get(r.user_id)!.push({ ts: r.ts });
  }

  // Scheduled minutes — prefer the roster-assigned total (real shift
  // hours minus breaks) over the conservative daysInMonth × 8h
  // fallback. The roster lookup returns 0 for users who have no
  // assignments that month; in that case we fall back to the legacy
  // assumption so existing behaviour is preserved for branches that
  // haven't filled in a roster yet.
  const fallbackScheduledMinutes = lastDay * ASSUMED_SHIFT_MINUTES;
  const userIds = employees.map((e) => e.user_id);
  const rosterScheduledByUser = scheduledMinutesByUserForMonth(branch.id, month, userIds);

  const rows = employees.map((emp) => {
    const userIns = insByUser.get(emp.user_id) ?? [];
    const rosterShiftByDate = shiftStartByDateForUserMonth(branch.id, emp.user_id, month);
    const rosterMin = rosterScheduledByUser.get(emp.user_id) ?? 0;
    const scheduledMinutes = rosterMin > 0 ? rosterMin : fallbackScheduledMinutes;
    const stats = monthlyLateStatsRoster(
      userIns,
      rosterShiftByDate,
      emp.shift_start_time,    // fallback when roster has no row for that date
      scheduledMinutes
    );
    return {
      ...emp,
      inCount: userIns.length,
      ...stats
    };
  });

  // Month picker: build a small list of recent months (last 6) so
  // admin can jump back to closed pay periods without typing dates.
  const monthOptions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() - i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona/timesheets" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.timesheets.monthly.backToDaily")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.timesheets.monthly.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.timesheets.monthly.subtitle")}
        </p>
      </div>

      {/* Month picker */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "admin.persona.timesheets.monthly.monthPicker")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/admin/persona/timesheets/monthly?month=${m}`}
            className={`text-xs px-2.5 py-1 rounded border ${
              m === month
                ? "bg-brand text-white border-brand"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m}
          </Link>
        ))}
      </div>

      {/* Stats grid */}
      <div className="card">
        {rows.length === 0 ? (
          <div className="text-sm text-slate-400 text-center py-10">
            {t(lang, "admin.persona.timesheets.monthly.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.5px] text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-2">{t(lang, "admin.persona.timesheets.monthly.col.name")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.timesheets.monthly.col.type")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.timesheets.monthly.col.shiftStart")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.workDays")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.lateCount")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.lateMinutes")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.lateRatio")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.timesheets.monthly.col.scStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ratioPct = (r.ratio * 100).toFixed(1);
                  return (
                    <tr key={r.user_id} className="border-b border-slate-100 last:border-b-0">
                      <td className="py-2 pr-2 font-bold text-slate-800">{r.display_name}</td>
                      <td className="py-2 pr-2 text-xs text-slate-500">
                        {r.employment_type === "ft" ? "FT" :
                         r.employment_type === "pt" ? "PT" : "—"}
                      </td>
                      <td className="py-2 pr-2 font-mono text-xs">
                        {r.shift_start_time ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">{r.inCount}</td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.computable ? r.lateCount : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.computable ? `${r.totalMinutesLate}` : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.computable ? `${ratioPct}%` : "—"}
                      </td>
                      <td className="py-2 pr-2">
                        {!r.shift_start_time ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                            {t(lang, "admin.persona.timesheets.monthly.scStatus.noShift")}
                          </span>
                        ) : r.scEligible ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                            ✓ {t(lang, "admin.persona.timesheets.monthly.scStatus.eligible")}
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">
                            ✗ {t(lang, "admin.persona.timesheets.monthly.scStatus.ineligible")}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rule key */}
      <div className="card text-xs text-slate-500 space-y-1">
        <div className="font-bold text-slate-700 uppercase tracking-[0.5px] text-[10px] mb-1">
          {t(lang, "admin.persona.timesheets.monthly.rulesTitle")}
        </div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.grace")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.sc20pct")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.ptDeduct")}</div>
        <div className="text-slate-400 mt-2">
          {t(lang, "admin.persona.timesheets.monthly.rule.shiftSetHint")}
        </div>
      </div>
    </div>
  );
}
