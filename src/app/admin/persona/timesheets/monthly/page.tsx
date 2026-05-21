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
import { nameWithPrefix } from "@/lib/name";
import {
  computeMonthlyAttendanceStats,
  type MonthlyAttendanceStats
} from "@/lib/monthly-attendance-stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "สถิติการเข้างานของพนักงาน · PERSONA" };

type EmployeeRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
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

  // Staff assigned to this branch with their shift settings.
  const employees = db.prepare(`
    SELECT u.id AS user_id, u.display_name, u.title_prefix,
           u.employment_type, u.shift_start_time
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role IN ('staff','admin') AND u.status != 'disabled'
    ORDER BY u.display_name COLLATE NOCASE
  `).all(branch.id) as EmployeeRow[];

  // Phase P4 (2026-05-21) — richer per-user stats. The engine owns all
  // of: worked hours, late/early-out counts, leaves by type, restricted-
  // day leaves, abnormal leaves, combined %, and the 3-tier SC ruling.
  const richStatsByUser = computeMonthlyAttendanceStats(
    branch.id,
    month,
    employees.map((e) => ({ user_id: e.user_id, shift_start_time: e.shift_start_time }))
  );

  const rows = employees.map((emp) => {
    const rich = richStatsByUser.get(emp.user_id) as MonthlyAttendanceStats;
    return { ...emp, rich };
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
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.workedHours")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.lateEarly")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.leave")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.restrictedLeave")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.abnormalLeave")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.timesheets.monthly.col.combinedPct")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.timesheets.monthly.col.scStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const rich = r.rich;
                  const workedHours = (rich.workedMinutes / 60);
                  const combinedPct = rich.combinedPenaltyPct.toFixed(1);
                  const tierLabel =
                    rich.scTier === "full" ? t(lang, "admin.persona.timesheets.monthly.scTier.full") :
                    rich.scTier === "half" ? t(lang, "admin.persona.timesheets.monthly.scTier.half") :
                    t(lang, "admin.persona.timesheets.monthly.scTier.none");
                  const tierCls =
                    rich.scTier === "full" ? "bg-emerald-100 text-emerald-700"
                    : rich.scTier === "half" ? "bg-amber-100 text-amber-700"
                    : "bg-rose-100 text-rose-700";
                  // Tooltip: leave breakdown by type for hover-on-the-leave-count cell.
                  const leaveBreakdown = Object.entries(rich.leaveCountByType)
                    .map(([k, n]) => `${t(lang, `leave.type.${k}` as any)}: ${n}`)
                    .join(" · ");
                  return (
                    <tr key={r.user_id} className="border-b border-slate-100 last:border-b-0">
                      <td className="py-2 pr-2 font-bold text-slate-800">{nameWithPrefix(r.title_prefix, r.display_name)}</td>
                      <td className="py-2 pr-2 text-xs text-slate-500">
                        {r.employment_type === "ft" ? "FT" :
                         r.employment_type === "pt" ? "PT" : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {rich.computable ? workedHours.toFixed(1) : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono text-xs">
                        {rich.computable
                          ? <span title={t(lang, "admin.persona.timesheets.monthly.lateEarlyTooltip", { late: rich.lateMinutesTotal, early: rich.earlyOutMinutesTotal })}>
                              {rich.lateCount}/{rich.earlyOutCount}
                            </span>
                          : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        <span title={leaveBreakdown || undefined}>
                          {rich.totalLeaveDays || "—"}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {rich.leavesOnRestrictedDays || "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {rich.abnormalLeaveCount || "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {rich.computable ? `${combinedPct}%` : "—"}
                      </td>
                      <td className="py-2 pr-2">
                        {!rich.computable ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                            {t(lang, "admin.persona.timesheets.monthly.scStatus.noShift")}
                          </span>
                        ) : (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${tierCls}`}>
                            {tierLabel}
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
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.workedHours")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.grace")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.combinedPct")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.scTiers")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.restrictedDays")}</div>
        <div>{t(lang, "admin.persona.timesheets.monthly.rule.abnormalLeaves")}</div>
        <div className="text-slate-400 mt-2">
          {t(lang, "admin.persona.timesheets.monthly.rule.shiftSetHint")}
        </div>
      </div>
    </div>
  );
}
