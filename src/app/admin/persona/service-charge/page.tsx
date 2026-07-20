// /admin/persona/service-charge — monthly Service Charge dashboard
//
// Two layers:
//   1. Daily ledger — one row per day of the selected month. Shows
//      who entered the amount, when, who edited last. Admin can edit
//      any row inline (forwards to /api/admin/persona/service-charge/daily).
//      Missing days surface as "ยังไม่ลงข้อมูล" so admin can spot gaps.
//
//   2. Monthly distribution — per-staff: minutes worked, gross
//      allocation (60% pool ÷ hours weight), forfeiture reason if
//      any, net payout. Totals row at the bottom reconciles back to
//      the original SVC collected.
//
// Read-only by default — admin clicks an edit button on a daily row
// to mutate. Forfeitures are computed live; no separate "finalize"
// step today (the bank CSV in /payroll handles actual disbursement).

import Link from "next/link";
import type { Metadata } from "next";
import SvcCalcModal from "./SvcCalcModal";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  computeMonthlySvcSummary,
  listDailyForMonth,
  SVC_STAFF_SHARE_RATIO,
  SVC_COMPANY_SHARE_RATIO
} from "@/lib/service-charge";
import ServiceChargeClient from "./ServiceChargeClient";
import OwlMascot from "../../../components/OwlMascot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Service Charge · PERSONA" };

export default function AdminServiceChargePage({
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
  const currentMonth = nowBkk.toISOString().slice(0, 7);
  const month = searchParams.month || currentMonth;

  const dailyRows = listDailyForMonth(branch.id, month);
  const summary = computeMonthlySvcSummary(branch.id, month);

  // Build the 6-month picker (current + 5 previous) the same way the
  // monthly timesheet view does, so admin can scrub closed periods.
  const monthOptions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() - i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.svc.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.svc.subtitle")}
        </p>
      </div>

      {/* Month picker */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "admin.persona.svc.month")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/admin/persona/service-charge?month=${m}`}
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

      {/* Summary tiles */}
      <div className="card">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
          <Tile
            label={t(lang, "admin.persona.svc.tile.collected")}
            value={summary.totalCollected}
            hint={t(lang, "admin.persona.svc.tile.collectedHint", {
              days: String(summary.daysWithEntries),
              total: String(summary.daysInMonth)
            })}
          />
          <Tile
            label={t(lang, "admin.persona.svc.tile.staffPool")}
            value={summary.staffPoolTotal}
            hint={t(lang, "admin.persona.svc.tile.staffPoolHint", {
              pct: String(Math.round(SVC_STAFF_SHARE_RATIO * 100))
            })}
            accent="emerald"
          />
          <Tile
            label={t(lang, "admin.persona.svc.tile.companyPool")}
            value={summary.companyPoolTotal}
            hint={t(lang, "admin.persona.svc.tile.companyPoolHint", {
              splitPct: String(Math.round(SVC_COMPANY_SHARE_RATIO * 100))
            })}
            accent="slate"
          />
          <Tile
            label={t(lang, "admin.persona.svc.tile.payoutDate")}
            valueText={summary.payoutDate}
            hint={t(lang, "admin.persona.svc.tile.payoutDateHint")}
            accent="brand"
          />
        </div>
        {summary.companyPoolFromForfeit > 0 && (
          <p className="mt-3 text-xs text-amber-700">
            {t(lang, "admin.persona.svc.forfeitNote", {
              amount: summary.companyPoolFromForfeit.toFixed(2)
            })}
          </p>
        )}
      </div>

      {/* Daily ledger + admin edit. Pulls the client component so admin
          can edit any row inline. Server passes both raw daily rows +
          a list of "missing" dates so the UI can show "ยังไม่ลงข้อมูล"
          rows for transparency. */}
      <ServiceChargeClient
        month={month}
        dailyRows={dailyRows.map((r) => ({
          id: r.id,
          date: r.date,
          amount: r.amount_baht,
          enteredByName: r.entered_by_name,
          enteredAt: r.entered_at,
          updatedByName: r.updated_by_name,
          updatedAt: r.updated_at
        }))}
        daysInMonth={summary.daysInMonth}
      />

      {/* Per-staff distribution */}
      <div className="card">
        <h2 className="font-bold text-slate-800 text-sm mb-3">
          {t(lang, "admin.persona.svc.distTitle")}
        </h2>
        {summary.rows.length === 0 ? (
          <div className="text-center py-10">
            <OwlMascot size={80} mood="thinking" />
            <p className="text-sm text-slate-400 mt-3">
              {t(lang, "admin.persona.svc.distEmpty")}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.5px] text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-2">{t(lang, "admin.persona.svc.col.name")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.svc.col.type")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.svc.col.daysWorked")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.svc.col.hoursWorked")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.svc.col.lateRatio")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.svc.col.gross")}</th>
                  <th className="py-2 pr-2 text-right">{t(lang, "admin.persona.svc.col.net")}</th>
                  <th className="py-2 pr-2">{t(lang, "admin.persona.svc.col.status")}</th>
                  <th className="py-2 pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {summary.rows.map((r) => {
                  const hours = (r.totalMinutesWorked / 60).toFixed(1);
                  const latePct = (r.lateRatio * 100).toFixed(1);
                  return (
                    <tr key={r.userId} className="border-b border-slate-100 last:border-b-0">
                      <td className="py-2 pr-2 font-bold text-slate-800">{r.displayName}</td>
                      <td className="py-2 pr-2 text-xs text-slate-500">
                        {r.employmentType === "ft" ? "FT" :
                         r.employmentType === "pt" ? "PT" : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">{r.daysWorked}</td>
                      <td className="py-2 pr-2 text-right font-mono">{hours}</td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.shiftStartTime ? `${latePct}%` : "—"}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono">
                        {r.grossAllocation.toFixed(2)}
                      </td>
                      <td className={`py-2 pr-2 text-right font-mono font-bold ${
                        r.forfeited ? "text-rose-500 line-through" : "text-emerald-700"
                      }`}>
                        {r.netAllocation.toFixed(2)}
                      </td>
                      <td className="py-2 pr-2">
                        {!r.forfeited ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                            ✓ {t(lang, "admin.persona.svc.status.eligible")}
                          </span>
                        ) : r.forfeitReason === "late_20pct" ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-bold">
                            ✗ {t(lang, "admin.persona.svc.status.late20")}
                          </span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">
                            ✗ {t(lang, "admin.persona.svc.status.resignation")}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-2 text-right">
                        <SvcCalcModal
                          displayName={r.displayName}
                          grossAllocation={r.grossAllocation}
                          netAllocation={r.netAllocation}
                          forfeited={r.forfeited}
                          forfeitReason={r.forfeitReason}
                          dailyBreakdown={r.dailyBreakdown}
                        />
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
          {t(lang, "admin.persona.svc.rulesTitle")}
        </div>
        <div>{t(lang, "admin.persona.svc.rule.split")}</div>
        <div>{t(lang, "admin.persona.svc.rule.byHours")}</div>
        <div>{t(lang, "admin.persona.svc.rule.late20")}</div>
        <div>{t(lang, "admin.persona.svc.rule.resignation")}</div>
        <div>{t(lang, "admin.persona.svc.rule.payout")}</div>
      </div>
    </div>
  );
}

// Lightweight stat tile reused for the 4-tile summary at the top.
function Tile({
  label, value, valueText, hint, accent
}: {
  label: string;
  value?: number;
  valueText?: string;
  hint: string;
  accent?: "emerald" | "slate" | "brand";
}) {
  const accentCls =
    accent === "emerald" ? "text-emerald-700" :
    accent === "slate"   ? "text-slate-700" :
    accent === "brand"   ? "text-brand" :
    "text-slate-800";
  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-[0.5px] text-slate-500 font-bold">
        {label}
      </div>
      <div className={`text-xl font-bold font-mono ${accentCls}`}>
        {valueText ?? (value ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div className="text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}
