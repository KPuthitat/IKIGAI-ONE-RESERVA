"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import ConfirmModal from "@/app/components/ConfirmModal";

export type PeriodDetail = {
  id: number;
  cycle: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "cancelled";
  ot_mode_snapshot: "flat" | "legal" | null;
  ot_flat_per_15min_snapshot: number | null;
  computed_by: number | null;
  computed_at: string | null;
  finalized_by: number | null;
  finalized_at: string | null;
  notes: string | null;
  created_at: string;
  computed_by_name: string | null;
  finalized_by_name: string | null;
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
  if (!d) return "";
  if (lang === "th") {
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}/${String(Number(y) + 543).slice(2)}`;
  }
  return d;
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

export default function PeriodDetailClient({
  lang, period, lines
}: { lang: Lang; period: PeriodDetail; lines: PayrollLineRow[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [editLine, setEditLine] = useState<PayrollLineRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);

  const isDraft = period.status === "draft";
  const isFinalized = period.status === "finalized";

  async function performAction(action: "recompute" | "finalize" | "unfinalize"): Promise<void> {
    setBusy(action);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${period.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t(lang, `admin.persona.payroll.action.${action}Done` as any) });
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

  const otModeBadge =
    period.ot_mode_snapshot === "flat"
      ? `${t(lang, "admin.persona.payroll.detail.otFlat")} ${period.ot_flat_per_15min_snapshot ?? 0} ฿/15m`
      : t(lang, "admin.persona.payroll.detail.otLegal");

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">
            {period.cycle === "weekly"
              ? t(lang, "admin.persona.payroll.hub.weeklyTitle")
              : t(lang, "admin.persona.payroll.hub.monthlyTitle")}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {formatBkkDate(period.period_start, lang)} – {formatBkkDate(period.period_end, lang)}
            <span className="text-slate-400 mx-2">|</span>
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
          {isDraft && (
            <>
              <button type="button" onClick={() => performAction("recompute")}
                disabled={busy !== null} className="btn-secondary text-sm">
                {busy === "recompute" ? "..." : "↻ " + t(lang, "admin.persona.payroll.action.recompute")}
              </button>
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
            <button type="button" onClick={() => performAction("unfinalize")}
              disabled={busy !== null} className="btn-secondary text-sm">
              {busy === "unfinalize" ? "..." : "↺ " + t(lang, "admin.persona.payroll.action.unfinalize")}
            </button>
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
          isFinalized ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
        }`}>
          {isFinalized
            ? t(lang, "admin.persona.payroll.status.finalized")
            : t(lang, "admin.persona.payroll.status.draft")}
        </span>
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

      {/* Lines table */}
      <div className="card overflow-x-auto">
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
                {isDraft && <th className="py-2 pr-3"></th>}
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
                  {isDraft && (
                    <td className="py-2 pr-3 text-right">
                      <button type="button" onClick={() => setEditLine(l)}
                        className="text-xs text-brand hover:underline">
                        {t(lang, "common.edit")}
                      </button>
                    </td>
                  )}
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
                {isDraft && <td></td>}
              </tr>
            </tfoot>
          </table>
        )}
      </div>

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
    </>
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
      const res = await fetch(apiUrl(`/api/admin/persona/payroll/periods/${periodId}/lines/${line.user_id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_pay: Number(basePay),
          ot_pay: Number(otPay),
          service_charge: Number(svc),
          other_additions: Number(otherAdd),
          other_deductions: Number(otherDed),
          notes
        })
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
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800">{t(lang, "admin.persona.payroll.detail.editLine")}</h3>
          <p className="text-sm text-slate-500">{line.display_name}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.basePay")}</label>
            <input type="number" step="0.01" className="input" value={basePay} onChange={(e) => setBasePay(e.target.value)} />
          </div>
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.col.otPay")}</label>
            <input type="number" step="0.01" className="input" value={otPay} onChange={(e) => setOtPay(e.target.value)} />
          </div>
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
