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

import { Fragment } from "react";
import Link from "next/link";
import type { Metadata } from "next";
import SvcCalcModal from "./SvcCalcModal";
import SvcPayoutActions from "./SvcPayoutActions";
import { requireAdmin, userCanViewPayroll } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
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

  // Payout batch state for the "ทำจ่ายแล้ว" action (owner 2026-07-21).
  const payoutBatch = db.prepare(
    "SELECT status, total_net, total_wht, posted_at FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?"
  ).get(branch.id, month) as
    { status: string; total_net: number; total_wht: number; posted_at: string | null } | undefined;
  const canManagePayout = userCanViewPayroll(user);
  const payoutStatus =
    (["draft", "finalized", "paid", "posted"].includes(payoutBatch?.status ?? "")
      ? payoutBatch!.status
      : "draft") as "draft" | "finalized" | "paid" | "posted";

  // Build the 6-month picker (current + 5 previous) the same way the
  // monthly timesheet view does, so admin can scrub closed periods.
  const monthOptions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() - i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  // Group the distribution table (owner 2026-07-21): พนักงานประจำ (FT) first,
  // then พนักงานพาร์ทไทม์ (PT); within each, ประกันสังคม (sso) before หักภาษี ณ
  // ที่จ่าย (wht). Stable sort preserves the underlying employee_code order.
  const typeRank = (t: string | null) => (t === "ft" ? 0 : t === "pt" ? 1 : 2);
  const taxRank = (m: string) => (m === "wht" ? 1 : 0);
  const distGroups = (["ft", "pt", "other"] as const)
    .map((key) => ({
      key,
      label: key === "ft" ? "พนักงานประจำ" : key === "pt" ? "พนักงานพาร์ทไทม์" : "อื่นๆ",
      rows: summary.rows
        .filter((r) => (key === "other" ? typeRank(r.employmentType) === 2 : r.employmentType === key))
        .slice()
        .sort((a, b) => taxRank(a.taxMode) - taxRank(b.taxMode))
    }))
    .filter((g) => g.rows.length > 0);

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

      {/* Summary cards (owner 2026-07-21 — same shape as ค่าตอบแทน) */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard
          label={t(lang, "admin.persona.svc.tile.collected")}
          value={fmtMoney(summary.totalCollected)}
          sub={t(lang, "admin.persona.svc.tile.collectedHint", {
            days: String(summary.daysWithEntries),
            total: String(summary.daysInMonth)
          })}
        />
        <SummaryCard
          label={t(lang, "admin.persona.svc.tile.staffPool")}
          value={fmtMoney(summary.staffPoolTotal)}
          sub={t(lang, "admin.persona.svc.tile.staffPoolHint", {
            pct: String(Math.round(SVC_STAFF_SHARE_RATIO * 100))
          })}
        />
        <SummaryCard
          label={t(lang, "admin.persona.svc.tile.companyPool")}
          value={fmtMoney(summary.companyPoolTotal)}
          sub={t(lang, "admin.persona.svc.tile.companyPoolHint", {
            splitPct: String(Math.round(SVC_COMPANY_SHARE_RATIO * 100))
          })}
        />
        <SummaryCard
          label="ยอดจ่ายจริง (สุทธิ)"
          value={fmtMoney(summary.totalNetPayout)}
          accent="emerald"
          sub={summary.totalWht > 0 ? `หัก ณ ที่จ่ายรวม ${fmtMoney(summary.totalWht)}` : undefined}
        />
        <SummaryCard
          label={t(lang, "admin.persona.svc.tile.payoutDate")}
          value={summary.payoutDate}
          sub={t(lang, "admin.persona.svc.tile.payoutDateHint")}
          accent="brand"
        />
      </div>
      {summary.companyPoolFromForfeit > 0 && (
        <p className="text-xs text-amber-700">
          {t(lang, "admin.persona.svc.forfeitNote", {
            amount: fmtMoney(summary.companyPoolFromForfeit)
          })}
        </p>
      )}

      {/* Payout / ACCOUNTA posting (owner 2026-07-21) */}
      {canManagePayout && summary.rows.length > 0 && (
        <SvcPayoutActions
          yearMonth={month}
          status={payoutStatus}
          totalNet={payoutBatch?.total_net ?? 0}
          totalWht={payoutBatch?.total_wht ?? 0}
          postedAt={payoutBatch?.posted_at ?? null}
          netPayoutPreview={summary.totalNetPayout}
        />
      )}

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
                <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                  <th className="py-2 pr-3">{t(lang, "admin.persona.svc.col.name")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.svc.col.daysWorked")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.svc.col.hoursWorked")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.svc.col.lateRatio")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.svc.col.gross")}</th>
                  <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.svc.col.net")}</th>
                  <th className="py-2 pr-3">{t(lang, "admin.persona.svc.col.status")}</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {distGroups.map((g) => (
                  <Fragment key={g.key}>
                    <tr className="bg-slate-50">
                      <td colSpan={8} className="py-1.5 px-2 text-xs font-bold text-slate-600">
                        {g.label} ({g.rows.length} คน)
                      </td>
                    </tr>
                    {g.rows.map((r) => {
                      const hours = (r.totalMinutesWorked / 60).toFixed(1);
                      const latePct = (r.lateRatio * 100).toFixed(1);
                      return (
                        <tr key={r.userId} className="border-b border-slate-100">
                          <td className="py-2 pr-3">
                            <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                              <span>{r.displayName}</span>
                              {r.taxMode === "wht" && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                                  {t(lang, "admin.persona.employees.taxMode.whtTag")}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-2 pr-3 text-right text-slate-600">{r.daysWorked}</td>
                          <td className="py-2 pr-3 text-right text-slate-600">{hours}</td>
                          <td className="py-2 pr-3 text-right text-slate-500">
                            {r.shiftStartTime ? `${latePct}%` : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            {fmtMoney(r.grossAllocation)}
                          </td>
                          <td className={`py-2 pr-3 text-right font-bold ${
                            r.forfeited ? "text-rose-500 line-through" : "text-emerald-700"
                          }`}>
                            {fmtMoney(r.netPayout)}
                            {!r.forfeited && r.taxMode === "wht" && (
                              <span className="block text-[9px] font-normal text-rose-500">หัก ณ ที่จ่าย 3%</span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
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
                          <td className="py-2 pr-3 text-right">
                            <SvcCalcModal
                              displayName={r.displayName}
                              grossAllocation={r.grossAllocation}
                              netAllocation={r.netAllocation}
                              forfeited={r.forfeited}
                              forfeitReason={r.forfeitReason}
                              dailyBreakdown={r.dailyBreakdown}
                              taxMode={r.taxMode}
                              whtAmount={r.whtAmount}
                              netPayout={r.netPayout}
                              excludedDays={r.excludedDays}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-medium">
                  <td className="py-2 pr-3">รวมทั้งหมด ({summary.rows.length} คน)</td>
                  <td className="py-2 pr-3 text-right">
                    {summary.rows.reduce((s, r) => s + r.daysWorked, 0)}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {(summary.rows.reduce((s, r) => s + r.totalMinutesWorked, 0) / 60).toFixed(1)}
                  </td>
                  <td className="py-2 pr-3"></td>
                  <td className="py-2 pr-3 text-right">
                    {fmtMoney(summary.rows.reduce((s, r) => s + r.grossAllocation, 0))}
                  </td>
                  <td className="py-2 pr-3 text-right text-emerald-700">
                    {fmtMoney(summary.totalNetPayout)}
                    {summary.totalWht > 0 && (
                      <span className="block text-[9px] font-normal text-rose-500">
                        หัก ณ ที่จ่ายรวม {fmtMoney(summary.totalWht)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3"></td>
                  <td className="py-2 pr-3"></td>
                </tr>
              </tfoot>
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

// Summary stat card — same shape as the payroll (ค่าตอบแทน) page's SummaryCard
// (owner 2026-07-21): own .card, big bold number, muted label + sub.
function SummaryCard({
  label, value, sub, accent
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "amber" | "rose" | "brand";
}) {
  const valueCls =
    accent === "emerald" ? "text-emerald-700" :
    accent === "amber"   ? "text-amber-600" :
    accent === "rose"    ? "text-rose-600" :
    accent === "brand"   ? "text-brand" :
    "text-slate-800";
  return (
    <div className="card">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}
