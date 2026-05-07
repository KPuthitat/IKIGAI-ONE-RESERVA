"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { formatLongDate } from "@/lib/time";
import ConfirmModal from "@/app/components/ConfirmModal";

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
  finalized_by_name: string | null;
  paid_by_name: string | null;
};

export type PayrollLineRow = {
  id: number;
  user_id: number;
  employee_code: string | null;
  display_name: string;
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

function fmtMoney(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type AddableStaff = {
  id: number;
  display_name: string;
  employment_type: "pt" | "ft" | null;
};

export type UnlockEntry = {
  id: number;
  reason: string;
  unlocked_at: string;
  unlocked_by_name: string | null;
  action: string;  // 'unlock' | 'force_open'
};

export default function PeriodDetailClient({
  lang, period, lines, addableStaff, unlockHistory, superadminPinSet, staleSnapshotCount
}: {
  lang: Lang;
  period: PeriodDetail;
  lines: PayrollLineRow[];
  addableStaff: AddableStaff[];
  unlockHistory: UnlockEntry[];
  superadminPinSet: boolean;
  staleSnapshotCount: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editLine, setEditLine] = useState<PayrollLineRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [confirmPay, setConfirmPay] = useState(false);
  const [unpayOpen, setUnpayOpen] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  // Mark-paid date — defaults to today (BKK), admin can backdate
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [paidAt, setPaidAt] = useState(todayBkk);

  const isDraft = period.status === "draft";
  const isFinalized = period.status === "finalized";
  const isPaid = period.status === "paid";

  async function performAction(action: "recompute" | "finalize" | "unfinalize" | "mark_paid"): Promise<void> {
    setBusy(action);
    setMsg(null);
    try {
      const body: Record<string, unknown> = { action };
      if (action === "mark_paid") body.paid_at = paidAt;
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
          j?.error === "pin_not_set" ? "admin.persona.payroll.err.pinNotSet" :
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
              {period.computed_by_name && ` (${period.computed_by_name})`}
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
              <button type="button" onClick={() => setConfirmFinalize(true)}
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
                disabled={busy !== null || !superadminPinSet}
                title={!superadminPinSet ? t(lang, "admin.persona.payroll.err.pinNotSet") : undefined}
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
            {period.paid_by_name && ` (${period.paid_by_name})`}
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
                      <span>{l.display_name}</span>
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
                        <span>{l.hourly_rate_snapshot.toFixed(0)} {t(lang, "admin.persona.employees.bahtPerHour")}</span>
                      )}
                      {l.employment_type === "ft" && l.monthly_salary_snapshot != null && (
                        <span>
                          {l.monthly_salary_snapshot.toLocaleString()} ฿ /
                          {l.pay_cycle_snapshot === "weekly"
                            ? t(lang, "admin.persona.employees.cycleWeekly")
                            : t(lang, "admin.persona.employees.cycleMonthly")}
                        </span>
                      )}
                      {l.holiday_minutes > 0 && (
                        <span className="ml-2 text-rose-600">★ {fmtMin(l.holiday_minutes)} {t(lang, "admin.persona.payroll.detail.onHoliday")}</span>
                      )}
                      {l.unpaired_clockins > 0 && (
                        <span className="ml-2 text-amber-700">⚠ {l.unpaired_clockins} {t(lang, "admin.persona.payroll.detail.unpairedShort")}</span>
                      )}
                      {l.overridden === 1 && (
                        <span className="ml-2 text-sky-700">★ {t(lang, "admin.persona.payroll.detail.overridden")}</span>
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

      <ConfirmModal
        open={confirmFinalize}
        title={t(lang, "admin.persona.payroll.confirmFinalizeTitle")}
        body={<p>{t(lang, "admin.persona.payroll.confirmFinalize")}</p>}
        confirmLabel={t(lang, "admin.persona.payroll.action.finalize")}
        cancelLabel={t(lang, "common.cancel")}
        variant="default"
        busy={busy === "finalize"}
        onConfirm={async () => {
          await performAction("finalize");
          setConfirmFinalize(false);
        }}
        onCancel={() => setConfirmFinalize(false)}
      />

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
                      <span>{u.unlocked_by_name ?? "—"}</span>
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
                    {s.display_name} · {empLabel}
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
          <label className="label">{t(lang, "admin.persona.payroll.field.superadminPin")}</label>
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

function LineEditModal({
  lang, periodId, line, onClose, onSaved
}: {
  lang: Lang;
  periodId: number;
  line: PayrollLineRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Two tabs: by hours (recompute pay) or by amount (override pay directly).
  const [mode, setMode] = useState<"hours" | "amount">("hours");

  // Hours-based fields (minutes shown as hours for UX)
  const minToHours = (m: number) => (m / 60).toFixed(2).replace(/\.?0+$/, "");
  const [regHrs, setRegHrs] = useState(minToHours(line.regular_minutes));
  const [otHrs, setOtHrs] = useState(minToHours(line.ot_minutes));
  const [holidayHrs, setHolidayHrs] = useState(minToHours(line.holiday_minutes));
  const [leaveDays, setLeaveDays] = useState(String(line.leave_days || 0));
  const [daysWorked, setDaysWorked] = useState(String(line.days_worked || 0));

  // Amount-based fields
  const [basePay, setBasePay] = useState(String(line.base_pay));
  const [otPay, setOtPay] = useState(String(line.ot_pay));
  const [svc, setSvc] = useState(String(line.service_charge));
  const [otherAdd, setOtherAdd] = useState(String(line.other_additions));
  const [otherDed, setOtherDed] = useState(String(line.other_deductions));

  const [notes, setNotes] = useState(line.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const body = mode === "hours"
        ? {
            regular_minutes: Math.round(Number(regHrs) * 60),
            ot_minutes: Math.round(Number(otHrs) * 60),
            holiday_minutes: Math.round(Number(holidayHrs) * 60),
            leave_days: Number(leaveDays),
            days_worked: Number(daysWorked),
            service_charge: Number(svc),
            other_additions: Number(otherAdd),
            other_deductions: Number(otherDed),
            notes
          }
        : {
            base_pay: Number(basePay),
            ot_pay: Number(otPay),
            service_charge: Number(svc),
            other_additions: Number(otherAdd),
            other_deductions: Number(otherDed),
            notes
          };
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) onSaved();
      else setErr(j?.error ?? t(lang, "common.error"));
    } catch {
      setErr(t(lang, "common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800">{t(lang, "admin.persona.payroll.detail.editLine")}</h3>
          <p className="text-sm text-slate-500">{line.display_name}</p>
        </div>

        {/* Mode toggle */}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setMode("hours")}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition ${
              mode === "hours" ? "border-brand bg-rose-50/40 text-brand ring-1 ring-brand/30"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}>
            {t(lang, "admin.persona.payroll.detail.modeHours")}
          </button>
          <button type="button" onClick={() => setMode("amount")}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition ${
              mode === "amount" ? "border-brand bg-rose-50/40 text-brand ring-1 ring-brand/30"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}>
            {t(lang, "admin.persona.payroll.detail.modeAmount")}
          </button>
        </div>

        {mode === "hours" ? (
          <>
            <p className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.detail.modeHoursHint")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.col.regularHrs")}</label>
                <input type="number" step="0.25" min="0" className="input"
                  value={regHrs} onChange={(e) => setRegHrs(e.target.value)} />
              </div>
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.col.otHrs")}</label>
                <input type="number" step="0.25" min="0" className="input"
                  value={otHrs} onChange={(e) => setOtHrs(e.target.value)} />
              </div>
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.detail.holidayHrs")}</label>
                <input type="number" step="0.25" min="0" className="input"
                  value={holidayHrs} onChange={(e) => setHolidayHrs(e.target.value)} />
              </div>
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.detail.daysWorked")}</label>
                <input type="number" step="1" min="0" className="input"
                  value={daysWorked} onChange={(e) => setDaysWorked(e.target.value)} />
              </div>
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.detail.leaveDays")}</label>
                <input type="number" step="0.5" min="0" className="input"
                  value={leaveDays} onChange={(e) => setLeaveDays(e.target.value)} />
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.detail.modeAmountHint")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.col.basePay")}</label>
                <input type="number" step="0.01" className="input" value={basePay} onChange={(e) => setBasePay(e.target.value)} />
              </div>
              <div>
                <label className="label">{t(lang, "admin.persona.payroll.col.otPay")}</label>
                <input type="number" step="0.01" className="input" value={otPay} onChange={(e) => setOtPay(e.target.value)} />
              </div>
            </div>
          </>
        )}

        {/* Common fields shown in both modes */}
        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100">
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.svc")}</label>
            <input type="number" step="0.01" className="input" value={svc} onChange={(e) => setSvc(e.target.value)} />
          </div>
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.otherAdd")}</label>
            <input type="number" step="0.01" className="input" value={otherAdd} onChange={(e) => setOtherAdd(e.target.value)} />
          </div>
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.otherDed")}</label>
            <input type="number" step="0.01" className="input" value={otherDed} onChange={(e) => setOtherDed(e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.col.notes")}</label>
          <input type="text" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </div>
        <p className="text-xs text-amber-700">
          ⚠ {t(lang, "admin.persona.payroll.detail.overrideHint")}
        </p>
        {err && <p className="text-rose-600 text-sm">✗ {err}</p>}
        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            {t(lang, "common.cancel")}
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
            {busy ? t(lang, "common.submitting") : t(lang, "common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
