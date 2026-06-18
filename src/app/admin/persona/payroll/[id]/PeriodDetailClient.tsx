"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import ConfirmModal from "@/app/components/ConfirmModal";
import PinPromptModal from "@/app/components/PinPromptModal";
import { nameWithPrefix } from "@/lib/name";

export type PeriodDetail = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  data_source: "auto" | "manual";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  ot_mode_snapshot: "flat" | "legal" | null;
  ot_flat_per_15min_snapshot: number | null;
  computed_by: number | null;
  computed_at: string | null;
  finalized_by: number | null;
  finalized_at: string | null;
  paid_by: number | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
  computed_by_name: string | null;
  computed_by_prefix: string | null;
  finalized_by_name: string | null;
  finalized_by_prefix: string | null;
  paid_by_name: string | null;
  paid_by_prefix: string | null;
};

export type PayrollLineRow = {
  id: number;
  user_id: number;
  employee_code: string | null;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
  pay_cycle_snapshot: "weekly" | "monthly" | null;
  hourly_rate_snapshot: number | null;
  monthly_salary_snapshot: number | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  holiday_minutes: number;
  shift_minutes: number;
  break_deducted_minutes: number;
  regular_minutes: number;
  ot_minutes: number;
  days_worked: number;
  leave_days: number;
  unpaid_leave_days: number;
  unpaired_clockins: number;
  base_pay: number;
  ot_pay: number;
  service_charge: number;
  other_additions: number;
  gross_pay: number;
  sso_amount: number;
  tax_amount: number;
  other_deductions: number;
  net_pay: number;
  overridden: number;
  notes: string | null;
};

function formatBkkDate(d: string, lang: Lang): string {
  return formatLongDate(d, lang);
}

function fmtMin(min: number): string {
  if (min === 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// fmtMoney moved to @/lib/format (2026-05) — single source of truth
// so display drift between payslip / summary / period-detail can't
// happen again. Import below ensures all three surfaces share an
// identical 2dp shape.

export type AddableStaff = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  employment_type: "pt" | "ft" | null;
};

export type UnlockEntry = {
  id: number;
  reason: string;
  unlocked_at: string;
  unlocked_by_name: string | null;
  unlocked_by_prefix: string | null;
  action: string;  // 'unlock' | 'force_open'
};

export default function PeriodDetailClient({
  lang, period, lines, addableStaff, unlockHistory, userPinSet, staleSnapshotCount
}: {
  lang: Lang;
  period: PeriodDetail;
  lines: PayrollLineRow[];
  addableStaff: AddableStaff[];
  unlockHistory: UnlockEntry[];
  userPinSet: boolean;
  staleSnapshotCount: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editLine, setEditLine] = useState<PayrollLineRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // confirmFinalize is now replaced by pinFinalizeOpen — the PIN modal
  // captures the PIN and sends it together with the finalize action.
  const [pinFinalizeOpen, setPinFinalizeOpen] = useState(false);
  const [confirmPay, setConfirmPay] = useState(false);
  const [unpayOpen, setUnpayOpen] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  // Mark-paid date — defaults to today (BKK), admin can backdate
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [paidAt, setPaidAt] = useState(todayBkk);

  const isDraft = period.status === "draft";
  const isFinalized = period.status === "finalized";
  const isPaid = period.status === "paid";

  async function performAction(
    action: "recompute" | "finalize" | "unfinalize" | "mark_paid",
    pin?: string
  ): Promise<void> {
    setBusy(action);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "mark_paid") body.paid_at = paidAt;
      if (action === "finalize" && pin) body.pin = pin;
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        // Map snake_case action → camelCase i18n suffix (mark_paid → markPaidDone)
        const doneKey =
          action === "mark_paid" ? "admin.persona.payroll.action.markPaidDone" :
          action === "recompute" ? "admin.persona.payroll.action.recomputeDone" :
          action === "finalize" ? "admin.persona.payroll.action.finalizeDone" :
          "admin.persona.payroll.action.unfinalizeDone";
        setMsg({ kind: "ok", text: t(lang, doneKey as any) });
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
      }
    } catch {
      setMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setBusy(null);
    }
  }

  async function addEmployee(targetUserId: number): Promise<void> {
    setBusy("add_emp");
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}/lines`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: targetUserId })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setAddStaffOpen(false);
        setMsg({ kind: "ok", text: t(lang, "admin.persona.payroll.action.addEmployeeDone") });
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
      }
    } catch {
      setMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setBusy(null);
    }
  }

  async function performUnpay(pin: string, reason: string): Promise<void> {
    setBusy("unpay");
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unpay", pin, reason })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setUnpayOpen(false);
        setMsg({ kind: "ok", text: t(lang, "admin.persona.payroll.action.unpayDone") });
        startTransition(() => router.refresh());
      } else {
        const errKey =
          j?.error === "pin_invalid" ? "admin.persona.payroll.err.pinInvalid" :
          j?.error === "user_pin_not_set" ? "admin.persona.payroll.err.userPinNotSet" :
          j?.error === "pin_required" ? "admin.persona.payroll.err.pinRequired" :
          j?.error === "reason_required" ? "admin.persona.payroll.err.reasonRequired" :
          "common.error";
        setMsg({ kind: "err", text: t(lang, errKey as any) });
      }
    } catch {
      setMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setBusy(null);
    }
  }

  async function deletePeriod(): Promise<void> {
    setBusy("delete");
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}`), {
        method: "DELETE"
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setConfirmDelete(false);
        startTransition(() => router.push("/admin/persona/payroll"));
      } else {
        setConfirmDelete(false);
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
        setBusy(null);
      }
    } catch {
      setConfirmDelete(false);
      setMsg({ kind: "err", text: t(lang, "common.error") });
      setBusy(null);
    }
  }

  // Aggregations
  const totals = lines.reduce(
    (acc, l) => ({
      gross: acc.gross + l.gross_pay,
      sso: acc.sso + l.sso_amount,
      tax: acc.tax + l.tax_amount,
      net: acc.net + l.net_pay,
      ot: acc.ot + l.ot_pay,
      ptCount: acc.ptCount + (l.employment_type === "pt" ? 1 : 0),
      ftCount: acc.ftCount + (l.employment_type === "ft" ? 1 : 0),
      ssoCount: acc.ssoCount + (l.salary_tax_mode_snapshot === "sso" ? 1 : 0),
      whtCount: acc.whtCount + (l.salary_tax_mode_snapshot === "wht" ? 1 : 0),
      holidayMin: acc.holidayMin + l.holiday_minutes
    }),
    { gross: 0, sso: 0, tax: 0, net: 0, ot: 0, ptCount: 0, ftCount: 0, ssoCount: 0, whtCount: 0, holidayMin: 0 }
  );

  const otFlatPer15 = period.ot_flat_per_15min_snapshot ?? 0;
  const otModeBadge =
    period.ot_mode_snapshot === "flat"
      ? t(lang, "admin.persona.payroll.otFlatLabel", {
          baht: String(otFlatPer15),
          perHour: String(otFlatPer15 * 4)
        })
      : t(lang, "admin.persona.payroll.otLegalLabel");

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 whitespace-nowrap">
            {period.cycle === "monthly"
              ? t(lang, "admin.persona.payroll.hub.cat.ftMonthly")
              : period.target === "pt"
              ? t(lang, "admin.persona.payroll.hub.cat.pt")
              : t(lang, "admin.persona.payroll.hub.cat.ftWeekly")}
          </h1>
          <p className="text-sm text-slate-600 mt-1 whitespace-nowrap">
            {formatBkkDate(period.period_start, lang)} – {formatBkkDate(period.period_end, lang)}
          </p>
          <p className="text-sm text-slate-600 mt-0.5 whitespace-nowrap">
            {t(lang, "admin.persona.payroll.col.payDate")}: <span className="font-medium">{formatBkkDate(period.pay_date, lang)}</span>
          </p>
          {period.computed_at && (
            <p className="text-xs text-slate-500 mt-1">
              {t(lang, "admin.persona.payroll.detail.computedAt", {
                ts: new Date(period.computed_at).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })
              })}
              {period.computed_by_name && ` (${nameWithPrefix(period.computed_by_prefix, period.computed_by_name)})`}
              <span className="mx-1">·</span>
              OT: {otModeBadge}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isDraft && period.data_source === "auto" && (
            <button type="button" onClick={() => performAction("recompute")}
              disabled={busy !== null} className="btn-secondary text-sm">
              {busy === "recompute" ? "..." : "↻ " + t(lang, "admin.persona.payroll.action.recompute")}
            </button>
          )}
          {isDraft && (
            <>
              <button type="button" onClick={() => setPinFinalizeOpen(true)}
                disabled={busy !== null} className="btn-primary text-sm">
                {busy === "finalize" ? "..." : "✓ " + t(lang, "admin.persona.payroll.action.finalize")}
              </button>
              <button type="button" onClick={() => setConfirmDelete(true)}
                disabled={busy !== null}
                className="text-sm px-3 py-1.5 rounded-md text-rose-700 hover:bg-rose-50">
                {busy === "delete" ? "..." : t(lang, "common.delete")}
              </button>
            </>
          )}
          {isFinalized && (
            <>
              <button type="button" onClick={() => performAction("unfinalize")}
                disabled={busy !== null} className="btn-secondary text-sm">
                {busy === "unfinalize" ? "..." : "↺ " + t(lang, "admin.persona.payroll.action.unfinalize")}
              </button>
              <button type="button" onClick={() => setConfirmPay(true)}
                disabled={busy !== null}
                className="text-sm px-4 py-1.5 rounded-md bg-sky-600 hover:bg-sky-700 text-white font-medium">
                {busy === "mark_paid" ? "..." : t(lang, "admin.persona.payroll.action.markPaid")}
              </button>
            </>
          )}
          {(isFinalized || isPaid) && (
            <a
              href={apiUrl(`/api/admin/persona/payroll/periods/${period.id}/bank-csv`)}
              className="text-sm px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50"
              download
            >
              {t(lang, "admin.persona.payroll.action.downloadBankCsv")}
            </a>
          )}
          {isPaid && (
            <>
              <span className="text-sm text-sky-700 font-medium px-3 py-1.5 rounded-md bg-sky-50 border border-sky-200">
                ✓ {t(lang, "admin.persona.payroll.action.alreadyPaid")}
              </span>
              <button
                type="button"
                onClick={() => setUnpayOpen(true)}
                disabled={busy !== null || !userPinSet}
                title={!userPinSet ? t(lang, "admin.persona.payroll.err.userPinNotSet") : undefined}
                className="text-sm px-3 py-1.5 rounded-md text-rose-700 hover:bg-rose-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t(lang, "admin.persona.payroll.action.unpay")}
              </button>
            </>
          )}
        </div>
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      {/* Status badge + warnings */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs px-2 py-1 rounded font-medium ${
          isPaid ? "bg-sky-100 text-sky-700" :
          isFinalized ? "bg-emerald-100 text-emerald-700" :
          "bg-amber-100 text-amber-700"
        }`}>
          {isPaid
            ? t(lang, "admin.persona.payroll.status.paid")
            : isFinalized
            ? t(lang, "admin.persona.payroll.status.finalized")
            : t(lang, "admin.persona.payroll.status.draft")}
        </span>
        <span className={`text-xs px-2 py-1 rounded font-medium ${
          period.data_source === "auto"
            ? "bg-violet-50 text-violet-700 border border-violet-200"
            : "bg-amber-50 text-amber-700 border border-amber-200"
        }`}>
          {period.data_source === "auto"
            ? t(lang, "admin.persona.payroll.detail.dataSourceAuto")
            : t(lang, "admin.persona.payroll.detail.dataSourceManual")}
        </span>
        {isPaid && period.paid_at && (
          <span className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.detail.paidNotice", {
              ts: new Date(period.paid_at).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })
            })}
            {period.paid_by_name && ` (${nameWithPrefix(period.paid_by_prefix, period.paid_by_name)})`}
          </span>
        )}
        {isFinalized && (
          <span className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.detail.finalizedNotice")}
          </span>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard label={t(lang, "admin.persona.payroll.col.staff")}
          value={`${lines.length}`}
          sub={`${t(lang, "admin.persona.employees.employment.pt")} ${totals.ptCount} · ${t(lang, "admin.persona.employees.employment.ft")} ${totals.ftCount}`} />
        <SummaryCard label={t(lang, "admin.persona.payroll.col.gross")}
          value={fmtMoney(totals.gross)} />
        <SummaryCard label={t(lang, "admin.persona.payroll.col.ot")}
          value={fmtMoney(totals.ot)} accent="amber"
          sub={totals.holidayMin > 0 ? `${t(lang, "admin.persona.payroll.detail.holidayMinutes")}: ${fmtMin(totals.holidayMin)}` : undefined} />
        <SummaryCard label={t(lang, "admin.persona.payroll.col.deductions")}
          value={fmtMoney(totals.sso + totals.tax)}
          sub={`${t(lang, "admin.persona.payroll.col.sso")} ${fmtMoney(totals.sso)} · ${t(lang, "admin.persona.payroll.col.tax")} ${fmtMoney(totals.tax)}`}
          accent="rose" />
        <SummaryCard label={t(lang, "admin.persona.payroll.col.net")}
          value={fmtMoney(totals.net)} accent="emerald" />
      </div>

      {/* Stale-snapshot banner — admin changed employee data after compute */}
      {isDraft && staleSnapshotCount > 0 && (
        <div className="card border-l-4 border-amber-400 bg-amber-50/60 flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="font-semibold text-amber-900">
              {t(lang, "admin.persona.payroll.detail.staleBannerTitle")}
            </h3>
            <p className="text-sm text-amber-800 mt-1">
              {t(lang, "admin.persona.payroll.detail.staleBannerBody", { n: String(staleSnapshotCount) })}
            </p>
          </div>
          <button type="button"
            onClick={() => performAction("recompute")}
            disabled={busy !== null}
            className="btn-secondary text-sm whitespace-nowrap">
            {busy === "recompute" ? "..." : "↻ " + t(lang, "admin.persona.payroll.action.recompute")}
          </button>
        </div>
      )}

      {/* Lines table */}
      <div className="card overflow-x-auto">
        {/* Add-employee button — always visible when draft (modal handles
            the empty state gracefully if everyone is already added). */}
        {isDraft && (
          <div className="mb-3 flex justify-end">
            <button
              type="button"
              onClick={() => setAddStaffOpen(true)}
              disabled={busy !== null}
              className="text-sm px-3 py-1.5 rounded-md bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 whitespace-nowrap disabled:opacity-50"
            >
              + {t(lang, "admin.persona.payroll.action.addEmployee")}
            </button>
          </div>
        )}
        {lines.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">
            {t(lang, "admin.persona.payroll.detail.noLines")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-2 pr-3">{t(lang, "admin.persona.payroll.col.staff")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.regularHrs")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.otHrs")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.basePay")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.otPay")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.gross")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.sso")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.tax")}</th>
                <th className="py-2 pr-3 text-right">{t(lang, "admin.persona.payroll.col.net")}</th>
                <th className="py-2 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className={`border-b border-slate-100 last:border-0 ${l.overridden ? "bg-sky-50/40" : ""}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800 flex items-center gap-1.5 flex-wrap">
                      <span>{nameWithPrefix(l.title_prefix, l.display_name)}</span>
                      {l.employment_type === "pt" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                          {t(lang, "admin.persona.employees.employment.pt")}
                        </span>
                      )}
                      {l.employment_type === "ft" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                          {t(lang, "admin.persona.employees.employment.ft")}
                        </span>
                      )}
                      {l.salary_tax_mode_snapshot === "wht" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                          title={t(lang, "admin.persona.employees.taxMode.wht")}>
                          {t(lang, "admin.persona.employees.taxMode.whtTag")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">
                      {l.employment_type === "pt" && l.hourly_rate_snapshot != null && (
                        <span>{fmtMoney(l.hourly_rate_snapshot)} {t(lang, "admin.persona.employees.bahtPerHour")}</span>
                      )}
                      {l.employment_type === "ft" && l.monthly_salary_snapshot != null && (
                        <span>
                          {fmtMoney(l.monthly_salary_snapshot)} ฿ /
                          {l.pay_cycle_snapshot === "weekly"
                            ? t(lang, "admin.persona.employees.cycleWeekly")
                            : t(lang, "admin.persona.employees.cycleMonthly")}
                        </span>
                      )}
                      {l.holiday_minutes > 0 && (
                        <span className="ml-2 text-rose-600">{fmtMin(l.holiday_minutes)} {t(lang, "admin.persona.payroll.detail.onHoliday")}</span>
                      )}
                      {l.unpaired_clockins > 0 && (
                        <span className="ml-2 text-amber-700">{l.unpaired_clockins} {t(lang, "admin.persona.payroll.detail.unpairedShort")}</span>
                      )}
                      {l.overridden === 1 && (
                        <span className="ml-2 text-sky-700">{t(lang, "admin.persona.payroll.detail.overridden")}</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-600">{fmtMin(l.regular_minutes)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700">{l.ot_minutes > 0 ? fmtMin(l.ot_minutes) : "—"}</td>
                  <td className="py-2 pr-3 text-right">{fmtMoney(l.base_pay)}</td>
                  <td className="py-2 pr-3 text-right text-amber-700">{l.ot_pay > 0 ? fmtMoney(l.ot_pay) : "—"}</td>
                  <td className="py-2 pr-3 text-right font-medium">{fmtMoney(l.gross_pay)}</td>
                  <td className="py-2 pr-3 text-right text-slate-500">{fmtMoney(l.sso_amount)}</td>
                  <td className="py-2 pr-3 text-right text-slate-500">{fmtMoney(l.tax_amount)}</td>
                  <td className="py-2 pr-3 text-right font-bold text-emerald-700">{fmtMoney(l.net_pay)}</td>
                  <td className="py-2 pr-3 text-right whitespace-nowrap">
                    <Link
                      href={`/admin/persona/payroll/${period.id}/payslip/${l.user_id}`}
                      target="_blank"
                      rel="noopener"
                      className="inline-block text-xs px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium"
                    >
                      {t(lang, "admin.persona.payroll.detail.viewPayslip")} ↗
                    </Link>
                    {isDraft && (
                      <button type="button" onClick={() => setEditLine(l)}
                        className="ml-1 text-xs px-2 py-1 rounded text-brand hover:bg-rose-50">
                        {t(lang, "common.edit")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-300 font-medium">
                <td className="py-2 pr-3">{t(lang, "admin.persona.payroll.detail.total")}</td>
                <td colSpan={4}></td>
                <td className="py-2 pr-3 text-right">{fmtMoney(totals.gross)}</td>
                <td className="py-2 pr-3 text-right text-slate-500">{fmtMoney(totals.sso)}</td>
                <td className="py-2 pr-3 text-right text-slate-500">{fmtMoney(totals.tax)}</td>
                <td className="py-2 pr-3 text-right text-emerald-700">{fmtMoney(totals.net)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* ── Transfer / remittance summary ─────────────────────── */}
      {lines.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-3">
            {t(lang, "admin.persona.payroll.detail.transferTitle")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.detail.transferToStaff")}
              </div>
              <div className="text-2xl font-bold mt-1 text-emerald-700">
                {fmtMoney(totals.net)} ฿
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {t(lang, "admin.persona.payroll.detail.transferToStaffHint", { n: lines.length })}
              </div>
            </div>
            <div className="rounded-lg border border-sky-200 bg-sky-50/50 p-4">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.detail.transferSso")}
              </div>
              <div className="text-2xl font-bold mt-1 text-sky-700">
                {fmtMoney(totals.sso)} ฿
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {t(lang, "admin.persona.payroll.detail.transferSsoHint", {
                  count: String(totals.ssoCount)
                })}
              </div>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4">
              <div className="text-xs text-slate-500">
                {t(lang, "admin.persona.payroll.detail.transferTax")}
              </div>
              <div className="text-2xl font-bold mt-1 text-amber-700">
                {fmtMoney(totals.tax)} ฿
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {totals.whtCount > 0
                  ? t(lang, "admin.persona.payroll.detail.transferTaxHintMixed", {
                      sso: String(totals.ssoCount), wht: String(totals.whtCount)
                    })
                  : t(lang, "admin.persona.payroll.detail.transferTaxHintAll")}
              </div>
            </div>
          </div>
        </div>
      )}

      {editLine && isDraft && (
        <LineEditModal
          lang={lang}
          periodId={period.id}
          line={editLine}
          onClose={() => setEditLine(null)}
          onSaved={() => {
            setEditLine(null);
            startTransition(() => router.refresh());
          }}
        />
      )}

      <ConfirmModal
        open={confirmDelete}
        title={t(lang, "admin.persona.payroll.confirmDeleteTitle")}
        body={<p>{t(lang, "admin.persona.payroll.confirmDelete")}</p>}
        confirmLabel={t(lang, "common.delete")}
        cancelLabel={t(lang, "common.cancel")}
        variant="danger"
        busy={busy === "delete"}
        onConfirm={() => deletePeriod()}
        onCancel={() => setConfirmDelete(false)}
      />

      {pinFinalizeOpen && (
        <PinPromptModal
          title={t(lang, "admin.persona.payroll.confirmFinalizeTitle")}
          description={<p className="text-xs text-slate-600">{t(lang, "admin.persona.payroll.confirmFinalize")}</p>}
          submitLabel={t(lang, "admin.persona.payroll.action.finalize")}
          onClose={() => setPinFinalizeOpen(false)}
          onSubmit={async (pin) => {
            const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}`), {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "finalize", pin })
            });
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.message ?? j.error ?? t(lang, "common.error") };
            }
            setPinFinalizeOpen(false);
            setMsg({ kind: "ok", text: t(lang, "admin.persona.payroll.action.finalizeDone" as any) });
            startTransition(() => router.refresh());
            return { ok: true };
          }}
        />
      )}

      <ConfirmModal
        open={confirmPay}
        title={t(lang, "admin.persona.payroll.confirmPayTitle")}
        body={
          <div className="space-y-3">
            <p>{t(lang, "admin.persona.payroll.confirmPay")}</p>
            <div>
              <label className="label">
                {t(lang, "admin.persona.payroll.field.actualPaidDate")}
              </label>
              <input
                type="date"
                className="input"
                value={paidAt}
                max={todayBkk}
                onChange={(e) => setPaidAt(e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">
                {t(lang, "admin.persona.payroll.field.actualPaidDateHint")}
              </p>
            </div>
          </div>
        }
        confirmLabel={t(lang, "admin.persona.payroll.action.markPaid")}
        cancelLabel={t(lang, "common.cancel")}
        variant="info"
        busy={busy === "mark_paid"}
        onConfirm={async () => {
          await performAction("mark_paid");
          setConfirmPay(false);
        }}
        onCancel={() => setConfirmPay(false)}
      />

      {/* Add-employee picker modal */}
      <AddStaffModal
        open={addStaffOpen}
        lang={lang}
        addableStaff={addableStaff}
        busy={busy === "add_emp"}
        onConfirm={(uid) => addEmployee(uid)}
        onCancel={() => setAddStaffOpen(false)}
      />

      {/* Superadmin unpay modal */}
      <UnpayModal
        open={unpayOpen}
        lang={lang}
        busy={busy === "unpay"}
        onConfirm={(pin, reason) => performUnpay(pin, reason)}
        onCancel={() => setUnpayOpen(false)}
      />

      {/* Audit history — shown when there are unlock/force-open events */}
      {unlockHistory.length > 0 && (
        <div className="card border-l-4 border-amber-300 bg-amber-50/40">
          <h2 className="font-semibold text-slate-800 mb-2">
            {t(lang, "admin.persona.payroll.detail.unlockHistoryTitle")}
          </h2>
          <ul className="space-y-2">
            {unlockHistory.map((u) => {
              const actionLabel =
                u.action === "force_open"
                  ? t(lang, "admin.persona.payroll.detail.actionForceOpen")
                  : t(lang, "admin.persona.payroll.detail.actionUnlock");
              const actionCls =
                u.action === "force_open"
                  ? "bg-amber-200 text-amber-800"
                  : "bg-rose-200 text-rose-800";
              return (
                <li key={u.id} className="text-sm border-b border-amber-200 last:border-0 pb-2 last:pb-0">
                  <div className="flex justify-between items-center text-xs text-slate-500 gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${actionCls}`}>
                        {actionLabel}
                      </span>
                      <span>{u.unlocked_by_name ? nameWithPrefix(u.unlocked_by_prefix, u.unlocked_by_name) : "—"}</span>
                    </div>
                    <span>{new Date(u.unlocked_at).toLocaleString("en-GB", { timeZone: "Asia/Bangkok" })}</span>
                  </div>
                  <div className="text-slate-700 mt-0.5">{u.reason}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

// ── AddStaff modal ────────────────────────────────────────────────────

function AddStaffModal({
  open, lang, addableStaff, busy, onConfirm, onCancel
}: {
  open: boolean;
  lang: Lang;
  addableStaff: AddableStaff[];
  busy: boolean;
  onConfirm: (userId: number) => void;
  onCancel: () => void;
}) {
  const [pickedId, setPickedId] = useState<number | "">("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-slate-800 text-lg">
          {t(lang, "admin.persona.payroll.action.addEmployee")}
        </h3>
        <p className="text-sm text-slate-600">
          {t(lang, "admin.persona.payroll.detail.addEmployeeBody")}
        </p>
        {addableStaff.length === 0 ? (
          <p className="text-sm text-slate-400 italic">
            {t(lang, "admin.persona.payroll.detail.noAddableStaff")}
          </p>
        ) : (
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.staff")}</label>
            <select
              className="input"
              value={pickedId}
              onChange={(e) => setPickedId(e.target.value === "" ? "" : Number(e.target.value))}
            >
              <option value="">— {t(lang, "common.choose")} —</option>
              {addableStaff.map((s) => {
                const empLabel =
                  s.employment_type === "ft" ? t(lang, "admin.persona.employees.employment.ft") :
                  s.employment_type === "pt" ? t(lang, "admin.persona.employees.employment.pt") :
                  t(lang, "admin.persona.employees.unset");
                return (
                  <option key={s.id} value={s.id}>
                    {nameWithPrefix(s.title_prefix, s.display_name)} · {empLabel}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
            {t(lang, "common.cancel")}
          </button>
          <button type="button"
            onClick={() => typeof pickedId === "number" && onConfirm(pickedId)}
            disabled={busy || pickedId === ""}
            className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold hover:opacity-90 disabled:opacity-50">
            {busy ? "…" : t(lang, "common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Superadmin unpay modal ────────────────────────────────────────────

function UnpayModal({
  open, lang, busy, onConfirm, onCancel
}: {
  open: boolean;
  lang: Lang;
  busy: boolean;
  onConfirm: (pin: string, reason: string) => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800 text-lg">
            {t(lang, "admin.persona.payroll.confirmUnpayTitle")}
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            {t(lang, "admin.persona.payroll.confirmUnpayBody")}
          </p>
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.userPin")}</label>
          <input type="password" inputMode="numeric" autoComplete="off"
            className="input tracking-widest text-center text-lg"
            value={pin} maxLength={12}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            placeholder="••••" />
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.unpayReason")}</label>
          <textarea
            className="input min-h-[88px]"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t(lang, "admin.persona.payroll.field.unpayReasonPlaceholder")}
          />
        </div>
        <p className="text-xs text-amber-700">
          {t(lang, "admin.persona.payroll.field.unpayWarning")}
        </p>
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
            {t(lang, "common.cancel")}
          </button>
          <button type="button"
            onClick={() => onConfirm(pin, reason)}
            disabled={busy || pin.length < 4 || reason.trim().length === 0}
            className="flex-1 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50">
            {busy ? "…" : t(lang, "admin.persona.payroll.action.unpay")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, accent }: {
  label: string; value: string; sub?: string;
  accent?: "amber" | "rose" | "emerald";
}) {
  const valueCls =
    accent === "amber" ? "text-amber-600" :
    accent === "rose" ? "text-rose-600" :
    accent === "emerald" ? "text-emerald-700" :
    "text-slate-800";
  return (
    <div className="card">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueCls}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}

type BreakdownDay = {
  date: string;
  pairs: Array<{
    workIn: string | null;
    workOut: string | null;
    durationMinutes: number;
    schedIn: string | null;
    schedOut: string | null;
    breakMinutes: number;
    effectiveMinutes: number;
    otMinutes: number;
    otPay: number;
    pay: number;
    edited: boolean;
    lateMin: number;
    earlyMin: number;
    holiday: boolean;
    statusLabel: string | null;
  }>;
  totalMinutes: number;
  effectiveMinutes: number;
  breakMinutes: number;
  otMinutes: number;
  otPay: number;
  pay: number;
  edited: boolean;
  override: {
    clock_in: string | null; clock_out: string | null;
    sched_in: string | null; sched_out: string | null;
    break_min: number | null; worked_min: number | null;
    ot_min: number | null; ot_pay: number | null; ot_until: string | null;
  } | null;
  // OT "until" time in effect (override ?? approved request), and the
  // approved request alone (for the "ขออนุมัติถึง …" hint).
  otUntil: string | null;
  otApprovedUntil: string | null;
  // Work shift (กะ) assigned to this date — drives the tag on worked days.
  shift: { code: string; name: string | null; color: string | null } | null;
};

function LineEditModal({
  lang, periodId, line, onClose, onSaved
}: {
  lang: Lang;
  periodId: number;
  line: PayrollLineRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  // The whole modal is now the per-day field-override editor (owner spec
  // 2026-06-03). The old aggregate "ปรับยอด/เพิ่ม-หัก" form was removed —
  // every correction is made per-day per-field below, PIN-gated + logged.

  // Per-day clock editor (owner spec 2026-06-03) — click a day in the
  // table to edit that day's recorded เวลาเข้า/ออก. The edit is saved as
  // a payroll-scoped override (staff time-clock untouched) and the line
  // recomputes. selectedDate drives the inline panel below the table.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selDay, setSelDay] = useState<BreakdownDay | null>(null);
  // Per-day inputs — PREFILLED with the day's current effective values
  // (override ?? computed) so the panel mirrors the table. Editing is
  // gated: fields stay locked until the admin verifies their PIN, then
  // only the fields they actually changed are saved as overrides.
  const [dayIn, setDayIn] = useState("");
  const [dayOut, setDayOut] = useState("");
  const [daySchedIn, setDaySchedIn] = useState("");
  const [daySchedOut, setDaySchedOut] = useState("");
  const [dayBreak, setDayBreak] = useState("");      // minutes
  const [dayWorked, setDayWorked] = useState("");    // hours
  const [dayOtUntil, setDayOtUntil] = useState("");  // HH:MM (approved OT until)
  const [dayOtPay, setDayOtPay] = useState("");      // baht
  // Snapshot of the prefilled values (dirty detection) + which fields
  // already carried a saved override (always resent on save).
  const [dayInit, setDayInit] = useState<Record<string, string>>({});
  const [dayHad, setDayHad] = useState<Record<string, boolean>>({});
  // PIN gate: fields are read-only until unlocked; dayPin holds the
  // verified PIN so "บันทึก" can resend it without re-prompting.
  const [dayUnlocked, setDayUnlocked] = useState(false);
  const [dayPin, setDayPin] = useState("");
  const [daySaving, setDaySaving] = useState(false);
  const [dayPinOpen, setDayPinOpen] = useState(false);
  const [dayMsg, setDayMsg] = useState<string | null>(null);
  // Period bounds (from the breakdown response) bound the add-a-day picker.
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");

  // ลาไม่รับค่าจ้าง — line-level day count; deducts salary/30 per day (FT).
  const [ulDays, setUlDays] = useState(String(line.unpaid_leave_days ?? 0));
  const [ulPinOpen, setUlPinOpen] = useState(false);
  const [ulMsg, setUlMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Daily time-entry breakdown — owner spec 2026-06-01 promoted this
  // from a collapsible footer to the primary view of the modal.
  const [breakdownDays, setBreakdownDays] = useState<BreakdownDay[] | null>(null);
  const [breakdownLoading, setBreakdownLoading] = useState(true);
  const [breakdownErr, setBreakdownErr] = useState<string | null>(null);
  // Bumped after a successful per-day save so the parent knows to
  // refresh its line list when the modal closes.
  const [dirty, setDirty] = useState(false);
  // Always show every calendar day in the period (owner 2026-06-18): worked
  // days tag the กะ, the rest show วันหยุด / ลา / ขาดงาน. The API now returns
  // a row for every day, so this just drives the full-range iteration.
  const [showAllDays] = useState(true);

  const loadBreakdown = useCallback(async () => {
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}/breakdown`),
        { headers: { "content-type": "application/json" } }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setBreakdownErr(j?.error ?? t(lang, "common.error"));
        return;
      }
      setBreakdownDays(j.days as BreakdownDay[]);
      if (j.period_start) setPeriodStart(j.period_start as string);
      if (j.period_end) setPeriodEnd(j.period_end as string);
      setBreakdownErr(null);
    } catch {
      setBreakdownErr(t(lang, "common.error"));
    } finally {
      setBreakdownLoading(false);
    }
  }, [lang, periodId, line.user_id]);

  useEffect(() => { void loadBreakdown(); }, [loadBreakdown]);

  // Recompute this line from current sources (no PIN — read-only inputs).
  const [recomputing, setRecomputing] = useState(false);
  async function recompute() {
    setRecomputing(true);
    setDayMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}/recompute`),
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setDirty(true);
        setDayMsg("คำนวณใหม่เรียบร้อย");
        await loadBreakdown();
      } else {
        setDayMsg(j?.error ?? t(lang, "common.error"));
      }
    } finally { setRecomputing(false); }
  }

  const hrStr = (min: number | null | undefined) =>
    min == null || min <= 0 ? "" : (min / 60).toFixed(2).replace(/\.?0+$/, "");

  // Open the per-day editor for a day. Every input is PREFILLED with the
  // value currently in effect (saved override ?? the table's computed
  // value) so the panel mirrors the row above. Fields start locked.
  function pickDay(day: BreakdownDay) {
    const ov = day.override;
    const spanIn = day.pairs.find((p) => p.workIn)?.workIn ?? "";
    const spanOut = [...day.pairs].reverse().find((p) => p.workOut)?.workOut ?? "";
    const sp = day.pairs.find((p) => p.schedIn);
    const vIn = ov?.clock_in ?? spanIn;
    const vOut = ov?.clock_out ?? spanOut;
    const vSchedIn = ov?.sched_in ?? sp?.schedIn ?? "";
    const vSchedOut = ov?.sched_out ?? sp?.schedOut ?? "";
    const vBreak = day.breakMinutes > 0 ? String(day.breakMinutes) : "";
    const vWorked = hrStr(day.effectiveMinutes);
    const vOtUntil = day.otUntil ?? "";
    const vOtPay = day.otPay > 0 ? String(day.otPay) : "";
    setSelectedDate(day.date);
    setSelDay(day);
    setDayIn(vIn); setDayOut(vOut);
    setDaySchedIn(vSchedIn); setDaySchedOut(vSchedOut);
    setDayBreak(vBreak); setDayWorked(vWorked);
    setDayOtUntil(vOtUntil); setDayOtPay(vOtPay);
    setDayInit({ in: vIn, out: vOut, schedIn: vSchedIn, schedOut: vSchedOut,
      brk: vBreak, worked: vWorked, otUntil: vOtUntil, otPay: vOtPay });
    setDayHad({
      clock: ov?.clock_in != null,
      sched: ov?.sched_in != null,
      brk: ov?.break_min != null,
      worked: ov?.worked_min != null,
      otUntil: ov?.ot_until != null,
      otPay: ov?.ot_pay != null
    });
    setDayUnlocked(false); setDayPin(""); setDayMsg(null);
  }

  function selectDateByValue(date: string) {
    const day = breakdownDays?.find((d) => d.date === date);
    if (day) { pickDay(day); return; }
    // A date not yet in the breakdown (no activity) — start blank.
    setSelectedDate(date); setSelDay(null);
    setDayIn(""); setDayOut(""); setDaySchedIn(""); setDaySchedOut("");
    setDayBreak(""); setDayWorked(""); setDayOtUntil(""); setDayOtPay("");
    setDayInit({ in: "", out: "", schedIn: "", schedOut: "",
      brk: "", worked: "", otUntil: "", otPay: "" });
    setDayHad({ clock: false, sched: false, brk: false, worked: false, otUntil: false, otPay: false });
    setDayUnlocked(false); setDayPin(""); setDayMsg(null);
  }

  // "แก้ไข (ใส่ PIN)" → verify the PIN up front, then unlock the fields.
  // The actual save re-verifies server-side; this is just the gate.
  async function verifyAndUnlock(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/verify-pin`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setDayPin(pin);
        setDayUnlocked(true);
        setDayPinOpen(false);
        return { ok: true };
      }
      const map: Record<string, string> = {
        wrong_pin: "PIN ไม่ถูกต้อง",
        no_pin: "คุณยังไม่ได้ตั้ง PIN",
        user_not_found: t(lang, "common.error")
      };
      return { ok: false, message: map[j?.error] ?? t(lang, "common.error") };
    } catch {
      return { ok: false, message: t(lang, "common.error") };
    }
  }

  // Save the day. clock in/out is always sent (it defines the worked
  // shift the field overrides attach to); the other fields are sent only
  // when the admin changed them (or they were already pinned) so an
  // untouched value keeps auto-computing. Uses the PIN captured at unlock.
  async function doSaveDay(): Promise<void> {
    if (!selectedDate) return;
    const numOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
    const hrToMin = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 60));

    const clockDirty = dayIn !== dayInit.in || dayOut !== dayInit.out;
    const schedDirty = daySchedIn !== dayInit.schedIn || daySchedOut !== dayInit.schedOut;
    const breakDirty = dayBreak !== dayInit.brk;
    const workedDirty = dayWorked !== dayInit.worked;
    const otUntilDirty = dayOtUntil !== dayInit.otUntil;
    const otPayDirty = dayOtPay !== dayInit.otPay;
    const anyDirty = clockDirty || schedDirty || breakDirty || workedDirty || otUntilDirty || otPayDirty;
    const hadAny = selDay?.override != null;

    if (!anyDirty && !hadAny) {
      setDayMsg("ไม่มีการเปลี่ยนแปลง");
      return;
    }
    if ((!dayIn) !== (!dayOut)) {
      setDayMsg("ต้องกรอกทั้งเวลาเข้าและออก (หรือเว้นว่างทั้งคู่)");
      return;
    }
    const sendSched = schedDirty || dayHad.sched;
    if (sendSched && ((!daySchedIn) !== (!daySchedOut))) {
      setDayMsg("ต้องกรอกทั้งเวลาเข้าและเลิกงาน (หรือเว้นว่างทั้งคู่)");
      return;
    }

    setDaySaving(true);
    setDayMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}/day`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            work_date: selectedDate,
            clock_in: dayIn || null,
            clock_out: dayOut || null,
            sched_in: sendSched ? (daySchedIn || null) : null,
            sched_out: sendSched ? (daySchedOut || null) : null,
            break_min: (breakDirty || dayHad.brk) ? numOrNull(dayBreak) : null,
            worked_min: (workedDirty || dayHad.worked) ? hrToMin(dayWorked) : null,
            ot_until: (otUntilDirty || dayHad.otUntil) ? (dayOtUntil || null) : null,
            ot_pay: (otPayDirty || dayHad.otPay) ? numOrNull(dayOtPay) : null,
            admin_pin: dayPin
          })
        }
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setDirty(true);
        setSelectedDate(null);
        setSelDay(null);
        setDayMsg("บันทึกแล้ว");
        await loadBreakdown();
      } else {
        const map: Record<string, string> = {
          wrong_pin: "PIN ไม่ถูกต้อง", no_pin: "คุณยังไม่ได้ตั้ง PIN",
          need_both_times: "ต้องกรอกทั้งเวลาเข้าและออก",
          need_both_sched: "ต้องกรอกทั้งเวลาเข้าและเลิกงาน",
          must_be_draft: "รอบนี้ไม่ใช่ฉบับร่างแล้ว"
        };
        setDayMsg(map[j?.error] ?? j?.error ?? t(lang, "common.error"));
      }
    } catch {
      setDayMsg(t(lang, "common.error"));
    } finally {
      setDaySaving(false);
    }
  }

  // Drop this day's override entirely (revert to the system-computed
  // value). Sends all-null with the captured PIN.
  async function clearDayOverride(): Promise<void> {
    if (!selectedDate) return;
    setDaySaving(true);
    setDayMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}/day`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            work_date: selectedDate,
            clock_in: null, clock_out: null, sched_in: null, sched_out: null,
            break_min: null, worked_min: null, ot_until: null, ot_pay: null,
            admin_pin: dayPin
          })
        }
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setDirty(true);
        setSelectedDate(null);
        setSelDay(null);
        setDayMsg("ล้างการแก้ไขแล้ว ใช้ค่าที่ระบบคำนวณ");
        await loadBreakdown();
      } else {
        setDayMsg(j?.error ?? t(lang, "common.error"));
      }
    } catch {
      setDayMsg(t(lang, "common.error"));
    } finally {
      setDaySaving(false);
    }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-4xl w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800">{t(lang, "admin.persona.payroll.detail.editLine")}</h3>
          <p className="text-sm text-slate-500">{nameWithPrefix(line.title_prefix, line.display_name)}</p>
          {line.hourly_rate_snapshot != null && (
            <p className="text-[11px] text-slate-400 mt-0.5">
              อัตราค่าตอบแทน: {fmtMoney(line.hourly_rate_snapshot)} บาท/ชม.
            </p>
          )}
        </div>

        {/* ลาไม่รับค่าจ้าง — FT only (salary-based). Deducts salary/30 per
            day even for full-time staff (owner 2026-06-17). */}
        {line.hourly_rate_snapshot == null && line.monthly_salary_snapshot != null && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="text-sm font-semibold text-slate-700">ลาไม่รับค่าจ้าง</div>
                <div className="text-[11px] text-slate-500">
                  หักเงินเดือน ÷ 30 ต่อวัน = {fmtMoney(line.monthly_salary_snapshot / 30)} บาท/วัน
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="number" min="0" max="31" step="0.5"
                  className="input !w-20 text-right" value={ulDays}
                  onChange={(e) => setUlDays(e.target.value)} />
                <span className="text-xs text-slate-500">วัน</span>
                <button type="button" className="btn-secondary !py-1.5 disabled:opacity-50"
                  disabled={(Number(ulDays) || 0) === line.unpaid_leave_days}
                  onClick={() => setUlPinOpen(true)}>บันทึก</button>
              </div>
            </div>
            {(Number(ulDays) || 0) > 0 && (
              <div className="text-[11px] text-rose-600">
                หักประมาณ ฿{fmtMoney((line.monthly_salary_snapshot / 30) * (Number(ulDays) || 0))}
              </div>
            )}
            {ulMsg && (
              <p className={`text-[11px] ${ulMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{ulMsg.text}</p>
            )}
          </div>
        )}
        {ulPinOpen && (
          <PinPromptModal
            title="ยืนยันบันทึกลาไม่รับค่าจ้าง"
            description={<p className="text-xs text-slate-600">หักเงินเดือน ÷ 30 × {ulDays} วัน — ใส่ PIN เพื่อยืนยัน</p>}
            submitLabel="บันทึก"
            onClose={() => setUlPinOpen(false)}
            onSubmit={async (pin) => {
              const res = await fetch(
                apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}`),
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ unpaid_leave_days: Number(ulDays) || 0, admin_pin: pin })
                }
              );
              const j = await res.json().catch(() => ({}));
              if (!res.ok || !j.ok) return { ok: false, message: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" };
              setUlPinOpen(false); setDirty(true);
              setUlMsg({ kind: "ok", text: "บันทึกแล้ว — ยอดสุทธิจะอัปเดตเมื่อปิดหน้าต่าง" });
              return { ok: true };
            }}
          />
        )}

        {/* Daily time-entry breakdown — PRIMARY view per owner spec
            2026-06-01. Shows where each day's pay comes from before
            asking the admin to confirm aggregate totals. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-slate-800 text-sm">
              เวลาเข้า-ออกแต่ละวัน (ที่มาของยอด)
            </h4>
            <div className="flex items-center gap-3">
              {/* Every day in the period now shows (worked = กะ tag, otherwise
                  วันหยุด / ลา / ขาดงาน) — owner 2026-06-18. The old
                  "แสดงทุกวันในรอบ" toggle is no longer needed. */}
              {breakdownDays && (
                <span className="text-[10px] text-slate-400">
                  มาทำงาน {breakdownDays.filter((d) => d.pairs.some((p) => p.workIn)).length} วัน
                  {" · "}ทั้งรอบ {breakdownDays.length} วัน
                </span>
              )}
            </div>
          </div>
          {breakdownLoading && (
            <p className="text-xs text-slate-500">กำลังโหลด…</p>
          )}
          {breakdownErr && (
            <p className="text-xs text-rose-600">✗ {breakdownErr}</p>
          )}
          {breakdownDays && breakdownDays.length === 0 && !showAllDays && (
            <p className="text-xs text-slate-500 italic bg-slate-50 rounded p-3 text-center">
              ไม่มีบันทึกเวลาเข้า-ออกในรอบนี้
              — เปิด &quot;แสดงทุกวันในรอบ&quot; เพื่อเพิ่มเวลารายวัน หรือกรอกค่าตอบแทนในส่วนสรุปด้านล่าง
            </p>
          )}
          {breakdownDays && (breakdownDays.length > 0 || showAllDays) && (() => {
            const showMoney = line.hourly_rate_snapshot != null;
            const clampedPair = (p: BreakdownDay["pairs"][number]) =>
              p.durationMinutes > 0 &&
              (p.effectiveMinutes + p.otMinutes + p.breakMinutes) !== p.durationMinutes;
            const tot = breakdownDays.reduce((s, d) => ({
              work: s.work + d.effectiveMinutes,
              brk: s.brk + d.breakMinutes,
              ot: s.ot + d.otMinutes,
              otPay: s.otPay + d.otPay,
              pay: s.pay + d.pay
            }), { work: 0, brk: 0, ot: 0, otPay: 0, pay: 0 });
            // When "show all days" is on, render a row for every calendar
            // day in the period — blank (clickable to add) where there's
            // no punch (owner 2026-06-08). Totals still come from real days.
            const byDate = new Map(breakdownDays.map((d) => [d.date, d] as const));
            const addYmd = (ymd: string): string => {
              const dd = new Date(`${ymd}T00:00:00Z`);
              dd.setUTCDate(dd.getUTCDate() + 1);
              return dd.toISOString().slice(0, 10);
            };
            const dateList: string[] = [];
            if (showAllDays && periodStart && periodEnd) {
              for (let d = periodStart; d <= periodEnd; d = addYmd(d)) dateList.push(d);
            } else {
              for (const d of breakdownDays) dateList.push(d.date);
            }
            const moneyCols = showMoney ? 2 : 0;
            return (
            <>
            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-xs whitespace-nowrap">
                <thead className="bg-slate-100">
                  <tr className="text-slate-600">
                    <th className="text-left px-2 py-1.5 font-semibold">วันที่</th>
                    <th className="text-left px-2 py-1.5 font-semibold">บันทึกเวลาเข้าออก</th>
                    <th className="text-left px-2 py-1.5 font-semibold">เวลาเข้าออกงาน</th>
                    <th className="text-right px-2 py-1.5 font-semibold">เวลาพัก</th>
                    <th className="text-right px-2 py-1.5 font-semibold">ชั่วโมงทำงาน</th>
                    <th className="text-right px-2 py-1.5 font-semibold">ทำงานล่วงเวลา</th>
                    {showMoney && <th className="text-right px-2 py-1.5 font-semibold">ค่าล่วงเวลา</th>}
                    {showMoney && <th className="text-right px-2 py-1.5 font-semibold">ค่าตอบแทน</th>}
                  </tr>
                </thead>
                <tbody>
                  {dateList.map((date) => {
                    const day = byDate.get(date);
                    if (!day) {
                      // Blank day (no punch) — click to add via the editor.
                      return (
                        <tr key={date}
                          onClick={() => selectDateByValue(date)}
                          className={`border-t border-slate-100 cursor-pointer hover:bg-rose-50/40 ${selectedDate === date ? "bg-rose-50" : ""}`}>
                          <td className="px-2 py-1.5 font-mono text-slate-400">{date}</td>
                          <td className="px-2 py-1.5 text-slate-300 italic">— ยังไม่มีการลงเวลา (กดเพื่อเพิ่ม) —</td>
                          <td className="px-2 py-1.5 text-slate-300">—</td>
                          <td className="px-2 py-1.5 text-right text-slate-300">—</td>
                          <td className="px-2 py-1.5 text-right text-slate-300">—</td>
                          <td className="px-2 py-1.5 text-right text-slate-300">—</td>
                          {Array.from({ length: moneyCols }).map((_, k) => (
                            <td key={k} className="px-2 py-1.5 text-right text-slate-300">—</td>
                          ))}
                        </tr>
                      );
                    }
                    const isSel = selectedDate === day.date;
                    return day.pairs.map((p, i) => (
                      <tr key={`${day.date}-${i}`}
                        onClick={() => pickDay(day)}
                        className={`border-t border-slate-100 cursor-pointer hover:bg-rose-50/40 ${isSel ? "bg-rose-50" : ""}`}>
                        <td className="px-2 py-1.5 font-mono">
                          {i === 0 && (
                            <span className="inline-flex items-center gap-1 flex-wrap">
                              {day.date}
                              {/* กะ tag on worked days (owner 2026-06-18). Status
                                  rows (วันหยุด/ลา/ขาดงาน) skip it — their label
                                  shows in the next column. */}
                              {!p.statusLabel && day.shift && (
                                <span className="text-[8px] px-1 rounded font-sans font-bold"
                                  style={{ backgroundColor: day.shift.color || "#e2e8f0", color: "#1a1a2e" }}
                                  title={day.shift.name ?? day.shift.code}>
                                  {day.shift.code}
                                </span>
                              )}
                              {day.edited && (
                                <span className="text-[8px] px-1 rounded bg-amber-100 text-amber-700 font-sans">แก้ไขแล้ว</span>
                              )}
                              {p.holiday && (
                                <span className="text-[8px] px-1 rounded bg-violet-100 text-violet-700 font-sans">วันพิเศษ ×1.5</span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono">
                          {p.statusLabel ? (
                            <span className={`text-[10px] font-sans px-1.5 py-0.5 rounded ${
                              p.statusLabel === "ขาดงาน"
                                ? "bg-rose-100 text-rose-700"
                                : p.statusLabel === "วันหยุด"
                                ? "bg-slate-100 text-slate-600"
                                : "bg-sky-100 text-sky-700"
                            }`}>{p.statusLabel}</span>
                          ) : (
                            <>
                              {p.workIn ?? <span className="text-rose-500">ขาด</span>}
                              <span className="text-slate-300">–</span>
                              {p.workOut ?? <span className="text-rose-500">ขาด</span>}
                              {clampedPair(p) && (
                                <span className="block text-[9px] text-slate-400">
                                  ลงเวลาจริง {fmtMin(p.durationMinutes)}
                                </span>
                              )}
                              {(p.lateMin > 0 || p.earlyMin > 0) && (
                                <span className="block text-[9px] font-sans">
                                  {p.lateMin > 0 && (
                                    <span className="text-rose-600">มาสาย {p.lateMin} น.</span>
                                  )}
                                  {p.lateMin > 0 && p.earlyMin > 0 && " · "}
                                  {p.earlyMin > 0 && (
                                    <span className="text-amber-600">กลับก่อน {p.earlyMin} น.</span>
                                  )}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-slate-500">
                          {p.schedIn && p.schedOut
                            ? `${p.schedIn}–${p.schedOut}`
                            : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-500">
                          {p.breakMinutes > 0 ? fmtMin(p.breakMinutes) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {p.effectiveMinutes > 0 ? fmtMin(p.effectiveMinutes) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {p.otMinutes > 0 ? fmtMin(p.otMinutes) : <span className="text-slate-300">—</span>}
                        </td>
                        {showMoney && (
                          <td className="px-2 py-1.5 text-right font-mono">
                            {p.otPay > 0 ? fmtMoney(p.otPay) : <span className="text-slate-300">—</span>}
                          </td>
                        )}
                        {showMoney && (
                          <td className="px-2 py-1.5 text-right font-mono">
                            {p.pay > 0 ? fmtMoney(p.pay) : <span className="text-slate-300">—</span>}
                          </td>
                        )}
                      </tr>
                    ));
                  })}
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                    <td className="px-2 py-1.5" colSpan={3}>รวมทั้งหมด</td>
                    <td className="px-2 py-1.5 text-right font-mono text-slate-500">
                      {tot.brk > 0 ? fmtMin(tot.brk) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{fmtMin(tot.work)}</td>
                    <td className="px-2 py-1.5 text-right font-mono">{tot.ot > 0 ? fmtMin(tot.ot) : "—"}</td>
                    {showMoney && (
                      <td className="px-2 py-1.5 text-right font-mono">{tot.otPay > 0 ? fmtMoney(tot.otPay) : "—"}</td>
                    )}
                    {showMoney && (
                      <td className="px-2 py-1.5 text-right font-mono">{fmtMoney(tot.pay)}</td>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>
            {showMoney && (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs bg-rose-50/60 rounded-lg px-3 py-2 border border-rose-100">
                <span className="text-slate-600">
                  คำนวณชั่วโมงทำงานรวม: <b className="text-slate-800">{fmtMin(tot.work)}</b>
                  {tot.ot > 0 && <> + ล่วงเวลา <b className="text-slate-800">{fmtMin(tot.ot)}</b></>}
                </span>
                <span className="text-slate-600">
                  คำนวณค่าตอบแทนรวม: <b className="text-brand">{fmtMoney(tot.pay)}</b>
                </span>
              </div>
            )}
            </>
            );
          })()}
          <p className="text-[10px] text-slate-400 leading-relaxed">
            {line.employment_type === "pt"
              ? <>&quot;ชั่วโมงทำงาน&quot; = เวลาหลังปัดเข้ากรอบกะ (เข้าก่อน/สายไม่เกิน 5 นาที = เริ่มตามกะ · ออกหลัง/ก่อนเลิกไม่เกิน 5 นาที = เลิกตามกะ) แล้วหักเวลาพักตามกะ. ส่วนเกิน 8 ชม./วัน นับเป็นทำงานล่วงเวลา</>
              : <>ค่าตอบแทนของพนักงานประจำคิดจากเงินเดือน ไม่ใช่ชั่วโมง — ตารางนี้แสดงเวลาเพื่ออ้างอิงเท่านั้น</>}
          </p>
        </div>

        {/* ── Per-day clock editor (primary, owner spec 2026-06-03) ── */}
        <div className="border-t-2 border-slate-200 pt-2 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h4 className="font-bold text-slate-800 text-sm">แก้ไขรายวัน</h4>
            <div className="flex items-center gap-2">
              <button type="button" onClick={recompute} disabled={recomputing}
                className="text-[11px] px-2.5 py-1 rounded-md border border-slate-300 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {recomputing ? "กำลังคำนวณ…" : "คำนวณใหม่"}
              </button>
              {periodStart && (
                <label className="text-[11px] text-slate-500 flex items-center gap-1">
                  เลือก/เพิ่มวัน:
                  <input type="date" className="input !w-auto !py-1 text-xs"
                    min={periodStart} max={periodEnd} value={selectedDate ?? ""}
                    onChange={(e) => { if (e.target.value) selectDateByValue(e.target.value); }} />
                </label>
              )}
            </div>
          </div>
          {!selectedDate && (
            <p className="text-[11px] text-slate-500">
              กดที่วันในตารางด้านบนเพื่อดูค่าที่ใช้อยู่ — ถ้าจะแก้ ใส่ PIN ก่อน แล้วแก้เฉพาะช่องที่ผิด (ช่องที่ไม่แตะจะคำนวณอัตโนมัติตามเดิม)
            </p>
          )}
          {selectedDate && (() => {
            const schedPair = selDay?.pairs.find((p) => p.schedIn);
            const locked = !dayUnlocked;
            const cancelEdit = () => {
              if (selDay) pickDay(selDay);
              else selectDateByValue(selectedDate);
            };
            return (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm font-bold text-slate-800">
                  วันที่ {selectedDate}
                  {locked
                    ? <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-500 font-normal">อ่านอย่างเดียว</span>
                    : <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-normal">แก้ไขได้</span>}
                </span>
                <button type="button" onClick={() => { setSelectedDate(null); setSelDay(null); }}
                  className="text-xs text-slate-400 hover:text-slate-600">ปิด</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">บันทึกเวลาเข้า</label>
                  <input type="time" className="input" disabled={locked} value={dayIn} onChange={(e) => setDayIn(e.target.value)} />
                </div>
                <div>
                  <label className="label">บันทึกเวลาออก</label>
                  <input type="time" className="input" disabled={locked} value={dayOut} onChange={(e) => setDayOut(e.target.value)} />
                </div>
                <div>
                  <label className="label">เวลาเข้างาน (กะ)</label>
                  <input type="time" className="input" disabled={locked} value={daySchedIn} onChange={(e) => setDaySchedIn(e.target.value)} />
                </div>
                <div>
                  <label className="label">เวลาเลิกงาน (กะ)</label>
                  <input type="time" className="input" disabled={locked} value={daySchedOut} onChange={(e) => setDaySchedOut(e.target.value)} />
                </div>
                <div>
                  <label className="label">เวลาพัก (นาที)</label>
                  <input type="number" min="0" step="1" className="input" disabled={locked} value={dayBreak}
                    onChange={(e) => setDayBreak(e.target.value)} />
                </div>
                <div>
                  <label className="label">ชั่วโมงทำงาน (ชม.)</label>
                  <input type="number" min="0" step="0.25" className="input" disabled={locked} value={dayWorked}
                    onChange={(e) => setDayWorked(e.target.value)} />
                </div>
                <div>
                  <label className="label">ทำงานล่วงเวลา (อนุมัติถึงเวลา)</label>
                  <input type="time" className="input" disabled={locked} value={dayOtUntil}
                    onChange={(e) => setDayOtUntil(e.target.value)} />
                </div>
                <div>
                  <label className="label">ค่าล่วงเวลา (บาท)</label>
                  <input type="number" min="0" step="0.01" className="input" disabled={locked} value={dayOtPay}
                    onChange={(e) => setDayOtPay(e.target.value)} />
                </div>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                ทุกช่องแสดงค่าที่ใช้อยู่ปัจจุบัน — แก้เฉพาะช่องที่ผิด ช่องที่ไม่แตะจะคำนวณอัตโนมัติตามเดิม
                {schedPair?.schedIn && <> · กะตามระบบ {schedPair.schedIn}–{schedPair.schedOut}</>}
                <br />
                ทำงานล่วงเวลา: {selDay?.otApprovedUntil
                  ? <>มีการขออนุมัติถึง <b>{selDay.otApprovedUntil}</b> น. — ระบบใช้เวลานี้คำนวณให้ แก้ได้ถ้าไม่ตรง</>
                  : <>ยังไม่มีการขออนุมัติล่วงเวลา — ใส่เวลาที่อนุมัติให้ได้ถ้ามี</>}
                <br />การแก้ไขต้องยืนยันด้วยรหัส PIN และเก็บ log โดยไม่กระทบบันทึกเวลาจริงของพนักงาน
              </p>
              {locked ? (
                <button type="button" onClick={() => setDayPinOpen(true)}
                  className="w-full py-2 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold">
                  แก้ไข (ใส่ PIN)
                </button>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  <button type="button" onClick={cancelEdit} disabled={daySaving}
                    className="px-3 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm disabled:opacity-50">
                    ยกเลิก
                  </button>
                  {selDay?.override && (
                    <button type="button" onClick={clearDayOverride} disabled={daySaving}
                      className="px-3 py-2 rounded-lg border border-rose-300 text-rose-600 text-sm disabled:opacity-50">
                      ล้างการแก้ไข (ใช้ค่าระบบ)
                    </button>
                  )}
                  <button type="button" onClick={doSaveDay} disabled={daySaving}
                    className="flex-1 py-2 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
                    {daySaving ? "กำลังบันทึก…" : "บันทึก"}
                  </button>
                </div>
              )}
            </div>
            );
          })()}
          {dayMsg && <p className="text-xs text-emerald-600">{dayMsg}</p>}
        </div>

        <div className="flex gap-2 pt-2 border-t border-slate-200">
          <button type="button" onClick={() => { if (dirty) onSaved(); else onClose(); }}
            className="flex-1 py-2.5 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold">
            {dirty ? "เสร็จสิ้น" : t(lang, "common.close")}
          </button>
        </div>
      </div>
    </div>

    {dayPinOpen && selectedDate && (
      <PinPromptModal
        title="ใส่ PIN เพื่อแก้ไข"
        description={
          <>
            แก้ไขรายวันของ{" "}
            <b>{nameWithPrefix(line.title_prefix, line.display_name)}</b>{" "}
            วันที่ <b>{selectedDate}</b> — ใส่ PIN ของคุณเพื่อปลดล็อก
            การแก้ไขจะถูกเก็บ log และไม่กระทบบันทึกเวลาจริงของพนักงาน
          </>
        }
        submitLabel="ปลดล็อก"
        onSubmit={verifyAndUnlock}
        onClose={() => setDayPinOpen(false)}
      />
    )}
    </>
  );
}
