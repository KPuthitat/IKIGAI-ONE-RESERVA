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
import SvcManualEntry from "./SvcManualEntry";
import SvcForfeitExemptButton from "./SvcForfeitExemptButton";
import SvcDeductionEditor from "./SvcDeductionEditor";
import { requireAdmin, userCanViewPayroll } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { fmtMoney } from "@/lib/format";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  computeMonthlySvcSummary,
  computeBranchSvcPayout,
  isSharedSvcMonth,
  listDailyForMonth,
  isManualSvcMonth,
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

  // When the month is on "คำนวณรวมทั้งบริษัท", the actual payout + ACCOUNTA posting
  // uses the combined-pool amounts attributed to THIS branch (owner 2026-08-20), so
  // the payout preview must reflect that — not the plain per-branch total below.
  const combinedMode = branch.company_id != null && !isManualSvcMonth(month)
    && isSharedSvcMonth(branch.company_id, month);
  const branchPayout = combinedMode ? computeBranchSvcPayout(branch.id, month) : null;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const payoutPreviewNet = branchPayout ? round2(branchPayout.reduce((s, r) => s + r.net, 0)) : summary.totalNetPayout;
  const payoutPreviewWht = branchPayout ? round2(branchPayout.reduce((s, r) => s + r.wht, 0)) : summary.totalWht;

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

  // Manual-entry month (owner 2026-07-21): pre-system months are typed by hand.
  // The entry table is editable only while the batch is still draft.
  const manual = summary.manualEntry;
  const canEditManual = canManagePayout && payoutStatus === "draft";
  // Forfeiture exemption is a distribution change — only allow while the branch's
  // payout is still draft (finalized/paid/posted is locked; owner 2026-08-20).
  const canExempt = canManagePayout && payoutStatus === "draft";
  const whtRate = manual
    ? ((db.prepare("SELECT wht_rate FROM payroll_settings LIMIT 1")
        .get() as { wht_rate: number } | undefined)?.wht_rate ?? 0.03)
    : 0.03;

  // Build the 12-month picker (current + 11 previous) so admin can scrub closed
  // periods — and reach pre-system months (< 2026-06) to hand-enter their SVC
  // (owner 2026-07-21).
  const monthOptions: string[] = [];
  for (let i = 0; i < 12; i++) {
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
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {t(lang, "admin.persona.svc.title")}
            <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            {t(lang, "admin.persona.svc.subtitle")}
          </p>
        </div>
        <Link
          href={`/admin/persona/service-charge/company?month=${month}`}
          className="text-xs px-3 py-1.5 rounded border border-brand/40 text-brand hover:bg-brand/5 whitespace-nowrap font-medium"
        >
          ดูรวมทั้งบริษัท →
        </Link>
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
            title={isManualSvcMonth(m) ? "เดือนก่อนเริ่มใช้ระบบ — กรอกเอง" : undefined}
            className={`text-xs px-2.5 py-1 rounded border ${
              m === month
                ? "bg-brand text-white border-brand"
                : isManualSvcMonth(m)
                ? "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m}{isManualSvcMonth(m) ? " ✎" : ""}
          </Link>
        ))}
      </div>

      {/* Summary cards (owner 2026-07-21 — same shape as ค่าตอบแทน). Manual
          (pre-system) months don't have a POS total / 60-40 split, so they show
          only the hand-entered staff total, net payout and payout date. */}
      {manual ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <SummaryCard
            label="ยอด SVC พนักงานรวม (กรอกเอง)"
            value={fmtMoney(summary.staffPoolTotal)}
            sub="เดือนก่อนเริ่มใช้ระบบ · ยอดก่อนหักภาษี"
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
      ) : (
        <>
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
              value={fmtMoney(payoutPreviewNet)}
              accent="emerald"
              sub={combinedMode
                ? "ตัวเลขรวมทั้งบริษัท (ปันมาสาขานี้)"
                : (summary.totalWht > 0 ? `หัก ณ ที่จ่ายรวม ${fmtMoney(payoutPreviewWht)}` : undefined)}
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
          {summary.totalGroupInsurance > 0 && (
            <p className="text-xs text-slate-600">
              หักประกันกลุ่มจากเซอร์วิสชาร์จรวม {fmtMoney(summary.totalGroupInsurance)} บาท
              (พนักงานใหม่ในช่วง — ประจำ 3 เดือนแรก / พาร์ทไทม์ 12 เดือนแรก · ฿350 ต่อคนต่อเดือน
              ตั้งเป็นเจ้าหนี้รอนำส่งบริษัทประกันเมื่อยืนยันลงบัญชี)
            </p>
          )}
        </>
      )}

      {/* Combined-calc notice — payout/accounting for this month uses the
          company-wide numbers attributed to this branch (owner 2026-08-20). */}
      {combinedMode && (
        <div className="card border-brand/40 bg-brand/5 text-xs text-slate-700">
          เดือนนี้เปิด <b>คำนวณเซอร์วิสชาร์จรวมทั้งบริษัท</b> — ยอดทำจ่าย/ลงบัญชีของสาขานี้
          อิงตัวเลข<b>รวมทั้งบริษัท</b> (ส่วนที่ปันมาให้สาขานี้) ตารางด้านล่างแสดงตัวเลขรายสาขาไว้อ้างอิง
          · ดูรายคนแบบเต็มได้ที่{" "}
          <Link href={`/admin/persona/service-charge/company?month=${month}`} className="text-brand underline font-medium">
            หน้ารวมทั้งบริษัท
          </Link>
        </div>
      )}

      {/* Payout / ACCOUNTA posting (owner 2026-07-21) */}
      {canManagePayout && summary.rows.length > 0 && (
        <SvcPayoutActions
          yearMonth={month}
          status={payoutStatus}
          totalNet={payoutBatch?.total_net ?? 0}
          totalWht={payoutBatch?.total_wht ?? 0}
          postedAt={payoutBatch?.posted_at ?? null}
          netPayoutPreview={payoutPreviewNet}
        />
      )}

      {/* Daily ledger + admin edit — only for live (system) months. Pre-system
          months have no POS daily data; they're entered per-staff by hand below. */}
      {!manual && (
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
      )}

      {/* Manual per-staff entry (pre-system month) */}
      {manual && (
        <SvcManualEntry
          yearMonth={month}
          whtRate={whtRate}
          canEdit={canEditManual}
          rows={summary.rows.map((r) => ({
            userId: r.userId,
            displayName: r.displayName,
            employmentType: r.employmentType,
            taxMode: r.taxMode,
            gross: r.grossAllocation
          }))}
        />
      )}

      {/* Per-staff distribution — computed months only (manual months show the
          editable entry table above instead). */}
      {!manual && (
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
                            {!r.forfeited && (r.foodClawback > 0 || r.otherDeductions > 0 || r.groupInsurance > 0 || r.taxMode === "wht") && (
                              <span className="block whitespace-nowrap text-[9px] font-normal text-rose-500 leading-tight">
                                {[
                                  r.foodClawback > 0 ? `ค่าอาหาร ${fmtMoney(r.foodClawback)}` : null,
                                  r.otherDeductions > 0 ? `อื่นๆ ${fmtMoney(r.otherDeductions)}` : null,
                                  r.groupInsurance > 0 ? `ประกันกลุ่ม ${fmtMoney(r.groupInsurance)}` : null,
                                  r.taxMode === "wht" ? "ภาษี 3%" : null
                                ].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3">
                            {r.exempted ? (
                              <SvcForfeitExemptButton userId={r.userId} yearMonth={month}
                                forfeited={false} exempted reason={r.exemptReason}
                                canEdit={canExempt} />
                            ) : r.forfeited ? (
                              <div className="flex flex-col items-start gap-1">
                                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                                  r.forfeitReason === "late_20pct" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-700"
                                }`}>
                                  ✗ {r.forfeitReason === "late_20pct"
                                    ? t(lang, "admin.persona.svc.status.late20")
                                    : t(lang, "admin.persona.svc.status.resignation")}
                                </span>
                                <SvcForfeitExemptButton userId={r.userId} yearMonth={month}
                                  forfeited exempted={false} reason={r.forfeitReason}
                                  canEdit={canExempt} />
                              </div>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                                ✓ {t(lang, "admin.persona.svc.status.eligible")}
                              </span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <SvcDeductionEditor
                                userId={r.userId}
                                yearMonth={month}
                                displayName={r.displayName}
                                items={r.otherDeductionItems}
                                canEdit={canExempt}
                              />
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
                                foodClawback={r.foodClawback}
                                foodClawbackDays={r.foodClawbackDays}
                                otherDeductions={r.otherDeductions}
                                otherDeductionItems={r.otherDeductionItems}
                                groupInsurance={r.groupInsurance}
                              />
                            </div>
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
      )}

      {/* Rule key — computed months only. Manual months follow a different,
          simpler rule (hand-entered gross, WHT withheld). */}
      {!manual ? (
        <div className="card text-xs text-slate-500 space-y-1">
          <div className="font-bold text-slate-700 uppercase tracking-[0.5px] text-[10px] mb-1">
            {t(lang, "admin.persona.svc.rulesTitle")}
          </div>
          <div>{t(lang, "admin.persona.svc.rule.split")}</div>
          <div>{t(lang, "admin.persona.svc.rule.byHours")}</div>
          <div>{t(lang, "admin.persona.svc.rule.late20")}</div>
          <div>{t(lang, "admin.persona.svc.rule.resignation")}</div>
          <div>{t(lang, "admin.persona.svc.rule.payout")}</div>
          <div>· วันเวลาผิดปกติ (ลืมลงเวลาเข้า/ออก) ไม่นับ SVC — มีผลตั้งแต่ มิ.ย. 2026</div>
          <div>· สูงสุด 8 ชม. (480 นาที) ต่อวัน · เกินได้เฉพาะมีโอทีอนุมัติ · ลงเวลาวันที่ไม่มีกะไม่นับ — มีผลตั้งแต่ ก.ค. 2026</div>
        </div>
      ) : (
        <div className="card text-xs text-slate-500 space-y-1">
          <div className="font-bold text-slate-700 uppercase tracking-[0.5px] text-[10px] mb-1">
            เดือนก่อนเริ่มใช้ระบบ (กรอกเอง)
          </div>
          <div>· กรอกยอดเซอร์วิสชาร์จก่อนหักภาษีของแต่ละคนด้วยมือ (ไม่ดึงจากเวลาทำงาน)</div>
          <div>· ระบบหัก ณ ที่จ่าย 3% ให้พนักงานกลุ่มหักภาษีอัตโนมัติ</div>
          <div>· ปิดยอด → ทำจ่าย → ลงบัญชี ACCOUNTA เหมือนเดือนปกติ</div>
          <div>· {t(lang, "admin.persona.svc.rule.payout")}</div>
        </div>
      )}
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
