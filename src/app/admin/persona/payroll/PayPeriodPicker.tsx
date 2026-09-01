"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { formatLongDate, formatMonthDay } from "@/lib/time";
import MonthPicker from "@/app/components/MonthPicker";
import { Icon } from "@/components/Icon";

// One row per (cycle, target, period_start, period_end) that already exists in DB
export type ExistingPeriod = {
  id: number;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft" | "all";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled";
  total_gross: number | null;
  total_net: number | null;
  line_count: number;
};

type SuggestedPeriod = {
  start: string;
  end: string;
  pay: string;
  cycle: "weekly" | "monthly";
  target: "pt" | "ft";
};

type DataSource = "auto" | "manual";

type ForceOpenContext = {
  sp: SuggestedPeriod;
};

// Compute weekly periods whose pay_date falls inside the given calendar month.
// (Pay date determines which month the period belongs to — for tax docs.)
function weeklyPayDatesInMonth(yearMonth: string): Array<{ start: string; end: string; pay: string }> {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const periods: Array<{ start: string; end: string; pay: string }> = [];
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCDay() === 1) {
      // This Monday is a pay-date for the previous Mon–Sun period.
      const sunday = new Date(dt.getTime() - 86400000);
      const monday = new Date(sunday.getTime() - 6 * 86400000);
      periods.push({
        start: monday.toISOString().slice(0, 10),
        end: sunday.toISOString().slice(0, 10),
        pay: dt.toISOString().slice(0, 10)
      });
    }
  }
  return periods;
}

// Group FT by the month the salary is PAID (owner 2026-09-01), so the FT round
// and the PT rounds paid the same month sit on one page. FT pays on the 5th of
// the month AFTER the work month, so the round PAID in `yearMonth` is the
// PREVIOUS month's work (work = yearMonth − 1, pay = the 5th of yearMonth).
function monthlyPeriodFor(yearMonth: string): { start: string; end: string; pay: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const workY = m === 1 ? y - 1 : y;
  const workM = m === 1 ? 12 : m - 1;
  const workYm = `${workY}-${String(workM).padStart(2, "0")}`;
  const lastDay = new Date(Date.UTC(workY, workM, 0)).getUTCDate();
  return {
    start: `${workYm}-01`,
    end: `${workYm}-${String(lastDay).padStart(2, "0")}`,
    pay: `${yearMonth}-05`
  };
}

function todayMonth(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 7);
}

function todayBkk(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10);
}

export default function PayPeriodPicker({
  lang, existing
}: {
  lang: Lang;
  existing: ExistingPeriod[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [month, setMonth] = useState<string>(todayMonth());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [forceOpen, setForceOpen] = useState<ForceOpenContext | null>(null);
  // สร้างทุกสาขาทีเดียว (owner 2026-07-27) — when on, create hits every branch
  // in the company and lands on the combined company-cycle page.
  const [allBranches, setAllBranches] = useState(false);

  // Lookup map: key = "cycle|target|start|end"
  const existingByKey = useMemo(() => {
    const map = new Map<string, ExistingPeriod>();
    for (const p of existing) {
      map.set(`${p.cycle}|${p.target}|${p.period_start}|${p.period_end}`, p);
    }
    return map;
  }, [existing]);

  const weeklyDates = useMemo(() => weeklyPayDatesInMonth(month), [month]);
  const monthlyDates = useMemo(() => monthlyPeriodFor(month), [month]);

  async function createPeriod(
    p: SuggestedPeriod,
    dataSource: DataSource,
    forceOpenParams?: { pin: string; reason: string }
  ): Promise<{ ok: boolean; error?: string }> {
    const key = `${p.cycle}|${p.target}|${p.start}|${p.end}|${dataSource}`;
    setBusyKey(key);
    setErrMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/payroll/periods"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycle: p.cycle,
          target: p.target,
          data_source: dataSource,
          period_start: p.start,
          period_end: p.end,
          pay_date: p.pay,
          all_branches: allBranches,
          ...(forceOpenParams ? {
            force_open_pin: forceOpenParams.pin,
            force_open_reason: forceOpenParams.reason
          } : {})
        })
      });
      const j = await res.json().catch(() => ({}));
      // All-branches mode → land on the combined company-cycle page.
      if (j?.ok && allBranches && j.cycle_rep_id) {
        startTransition(() => router.push(`/admin/persona/payroll/cycle/${j.cycle_rep_id}`));
        return { ok: true };
      }
      if (j?.ok && j.period_id) {
        startTransition(() => router.push(`/admin/persona/payroll/${j.period_id}`));
        return { ok: true };
      } else {
        const errKey =
          j?.error === "duplicate_period" ? "admin.persona.payroll.err.duplicate" :
          j?.error === "invalid_range" ? "admin.persona.payroll.err.invalidRange" :
          j?.error === "future_pin_required" ? "admin.persona.payroll.err.pinRequired" :
          j?.error === "future_reason_required" ? "admin.persona.payroll.err.reasonRequired" :
          j?.error === "pin_invalid" ? "admin.persona.payroll.err.pinInvalid" :
          j?.error === "user_pin_not_set" ? "admin.persona.payroll.err.userPinNotSet" :
          "common.error";
        if (!forceOpenParams) setErrMsg(t(lang, errKey as any));
        return { ok: false, error: t(lang, errKey as any) };
      }
    } catch {
      if (!forceOpenParams) setErrMsg(t(lang, "common.error"));
      return { ok: false, error: t(lang, "common.error") };
    } finally {
      setBusyKey(null);
    }
  }

  const monthLabel = formatMonthDay(`${month}-15`, lang).split(" ").slice(1).join(" "); // just the month-name
  const today = todayBkk();

  return (
    <div className="card border-l-4 border-brand bg-rose-50/30 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-bold text-slate-800">
            {t(lang, "admin.persona.payroll.hub.payPeriods")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.hub.payPeriodsDesc")}
          </p>
        </div>
        <MonthPicker value={month} onChange={setMonth} lang={lang} />
      </div>

      {/* All-branches toggle — create the period for every branch at once */}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none bg-white/70 border border-slate-200 rounded-lg px-3 py-2 w-fit">
        <input
          type="checkbox"
          checked={allBranches}
          onChange={(e) => setAllBranches(e.target.checked)}
          className="w-4 h-4 accent-brand"
        />
        <span className="font-medium text-slate-700">{t(lang, "admin.persona.payroll.hub.allBranches")}</span>
        <span className="text-xs text-slate-400">{t(lang, "admin.persona.payroll.hub.allBranchesHint")}</span>
      </label>

      {errMsg && (
        <div className="text-rose-600 text-sm">✗ {errMsg}</div>
      )}

      {/* Three flat sections — เงินเดือน → เลือกเดือน → เลือกรอบจ่าย */}

      {/* 1. ประจำรายเดือน — Full-time monthly (top priority) */}
      <Section
        lang={lang}
        title={t(lang, "admin.persona.payroll.hub.cat.ftMonthly")}
        desc={t(lang, "admin.persona.payroll.hub.cat.ftMonthlyDesc", { month: monthLabel })}
        dotColor="bg-emerald-600"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {(() => {
            const sp: SuggestedPeriod = { ...monthlyDates, cycle: "monthly", target: "ft" };
            const key = `monthly|ft|${monthlyDates.start}|${monthlyDates.end}`;
            const ex = existingByKey.get(key);
            return (
              <PeriodCard
                key={key}
                lang={lang}
                start={monthlyDates.start}
                end={monthlyDates.end}
                pay={monthlyDates.pay}
                cycleLabel={t(lang, "admin.persona.payroll.hub.cat.ftMonthly")}
                existing={ex}
                busyKey={busyKey}
                cardKey={key}
                onCreate={(ds) => createPeriod(sp, ds)}
                onForceOpen={() => setForceOpen({ sp })}
                onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                today={today}
                accentClass="hover:border-emerald-500/60"
                allBranches={allBranches}
              />
            );
          })()}
        </div>
      </Section>

      {/* ประจำรายสัปดาห์ removed (owner 2026-06-09): FT paid monthly only. */}

      {/* 2. พาร์ทไทม์ — Part-time (weekly only) */}
      <Section
        lang={lang}
        title={t(lang, "admin.persona.payroll.hub.cat.pt")}
        desc={t(lang, "admin.persona.payroll.hub.cat.ptDesc", { month: monthLabel })}
        dotColor="bg-violet-500"
      >
        {weeklyDates.length === 0 ? (
          <p className="text-xs text-slate-500 italic px-3">
            {t(lang, "admin.persona.payroll.hub.noMondays")}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {weeklyDates.map((p) => {
              const sp: SuggestedPeriod = { ...p, cycle: "weekly", target: "pt" };
              const key = `weekly|pt|${p.start}|${p.end}`;
              const ex = existingByKey.get(key);
              return (
                <PeriodCard
                  key={key}
                  lang={lang}
                  start={p.start}
                  end={p.end}
                  pay={p.pay}
                  cycleLabel={t(lang, "admin.persona.payroll.hub.cat.pt")}
                  existing={ex}
                  busyKey={busyKey}
                  cardKey={key}
                  onCreate={(ds) => createPeriod(sp, ds)}
                  onForceOpen={() => setForceOpen({ sp })}
                  onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                  accentClass="hover:border-violet-400/60"
                  today={today}
                  allBranches={allBranches}
                />
              );
            })}
          </div>
        )}
      </Section>

      {/* Force-open modal for future periods */}
      {forceOpen && (
        <ForceOpenModal
          lang={lang}
          context={forceOpen}
          onCancel={() => setForceOpen(null)}
          onConfirm={async (ds, pin, reason) => {
            const r = await createPeriod(forceOpen.sp, ds, { pin, reason });
            if (r.ok) setForceOpen(null);
            return r;
          }}
        />
      )}
    </div>
  );
}

// ── Force-open modal — admin's PIN + reason for opening a future period ──

function ForceOpenModal({
  lang, context: _ctx, onCancel, onConfirm
}: {
  lang: Lang;
  context: ForceOpenContext;
  onCancel: () => void;
  onConfirm: (ds: DataSource, pin: string, reason: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [dataSource, setDataSource] = useState<DataSource>("auto");
  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (pin.length < 4) {
      setErr(t(lang, "admin.persona.payroll.err.pinRequired"));
      return;
    }
    if (!reason.trim()) {
      setErr(t(lang, "admin.persona.payroll.err.reasonRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await onConfirm(dataSource, pin, reason.trim());
    if (!r.ok) {
      setErr(r.error ?? t(lang, "common.error"));
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold text-slate-800 text-lg">
            {t(lang, "admin.persona.payroll.confirmForceOpenTitle")}
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            {t(lang, "admin.persona.payroll.confirmForceOpenBody")}
          </p>
        </div>
        {/* Data-source choice — replaces the 2-button card */}
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.dataSource")}</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className={`border rounded-lg p-3 cursor-pointer transition ${
              dataSource === "auto"
                ? "border-brand bg-rose-50/40 ring-1 ring-brand/30"
                : "border-slate-200 hover:bg-slate-50"
            }`}>
              <div className="flex items-center gap-2">
                <input type="radio" checked={dataSource === "auto"}
                  onChange={() => setDataSource("auto")} />
                <span className="text-sm font-medium">
                  {t(lang, "admin.persona.payroll.hub.createAuto")}
                </span>
              </div>
            </label>
            <label className={`border rounded-lg p-3 cursor-pointer transition ${
              dataSource === "manual"
                ? "border-brand bg-rose-50/40 ring-1 ring-brand/30"
                : "border-slate-200 hover:bg-slate-50"
            }`}>
              <div className="flex items-center gap-2">
                <input type="radio" checked={dataSource === "manual"}
                  onChange={() => setDataSource("manual")} />
                <span className="text-sm font-medium">
                  {t(lang, "admin.persona.payroll.hub.createManual")}
                </span>
              </div>
            </label>
          </div>
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
          <label className="label">{t(lang, "admin.persona.payroll.field.forceOpenReason")}</label>
          <textarea
            className="input min-h-[80px]"
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t(lang, "admin.persona.payroll.field.forceOpenReasonPlaceholder")}
          />
        </div>
        {err && <p className="text-rose-600 text-sm">✗ {err}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium disabled:opacity-50">
            {t(lang, "common.cancel")}
          </button>
          <button type="button" onClick={submit}
            disabled={busy || pin.length < 4 || reason.trim().length === 0}
            className="flex-1 py-2.5 rounded-full bg-amber-500 text-white text-sm font-bold hover:bg-amber-600 disabled:opacity-50">
            {busy ? "…" : t(lang, "common.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section wrapper for category headings ───────────────────────────

function Section({
  lang: _lang, title, desc, dotColor, children
}: {
  lang: Lang;
  title: string;
  desc: string;
  dotColor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-800 whitespace-nowrap">
          <span className={`inline-block w-2 h-2 rounded-full ${dotColor} mr-2 align-middle`}></span>
          {title}
        </h3>
        <span className="text-xs text-slate-500">{desc}</span>
      </div>
      {children}
    </div>
  );
}

function PeriodCard({
  lang, start, end, pay, cycleLabel, existing, busyKey, cardKey,
  onCreate, onOpen, onForceOpen, accentClass, today, allBranches
}: {
  lang: Lang;
  start: string;
  end: string;
  pay: string;
  cycleLabel: string;
  existing: ExistingPeriod | undefined;
  busyKey: string | null;
  cardKey: string;
  onCreate: (ds: DataSource) => void;
  onOpen: (id: number) => void;
  onForceOpen: () => void;
  accentClass: string;
  today: string;       // YYYY-MM-DD (Bangkok)
  allBranches: boolean;
}) {
  const isExisting = !!existing;
  const isPaid = existing?.status === "paid";
  const isFinalized = existing?.status === "finalized";
  // Future/incomplete period — its last day hasn't passed yet. Keyed on period
  // END, not pay date (owner 2026-08-03: a finished month can be opened right away,
  // no waiting for the 5th). Display muted + force-open only while still running.
  const isFuture = !isExisting && end >= today;
  const busyAuto = busyKey === `${cardKey}|auto`;
  const busyManual = busyKey === `${cardKey}|manual`;

  let statusLabel = "";
  let statusCls = "";
  if (isPaid) {
    statusLabel = t(lang, "admin.persona.payroll.status.paid");
    statusCls = "bg-sky-100 text-sky-700";
  } else if (isFinalized) {
    statusLabel = t(lang, "admin.persona.payroll.status.finalized");
    statusCls = "bg-emerald-100 text-emerald-700";
  } else if (isExisting) {
    statusLabel = t(lang, "admin.persona.payroll.status.draft");
    statusCls = "bg-amber-100 text-amber-700";
  }

  const cardBgCls = isPaid
    ? "bg-sky-50/60 border-sky-200"
    : isFinalized
    ? "bg-emerald-50/60 border-emerald-200"
    : isExisting
    ? "bg-amber-50/60 border-amber-200"
    : isFuture
    ? "bg-slate-50/40 border-slate-200 opacity-60"
    : `bg-white border-slate-200 ${accentClass}`;

  // Show the actually-stored pay_date for existing periods (so the card never
  // disagrees with what's inside on the detail page). Fall back to the
  // suggested default for unsaved cards.
  const displayedPay = existing?.pay_date ?? pay;

  return (
    <div className={`rounded-lg border p-3 transition ${cardBgCls}`}>
      <div className="text-xs text-slate-500">{cycleLabel}</div>
      <div className="font-medium text-slate-800 mt-0.5 leading-tight">
        {formatMonthDay(start, lang)} – {formatMonthDay(end, lang)}
      </div>
      <div className="text-xs text-slate-500 mt-1">
        {t(lang, "admin.persona.payroll.col.payDate")}:{" "}
        <span className="font-medium text-slate-700">{formatLongDate(displayedPay, lang)}</span>
      </div>
      {isExisting && (
        <div className="text-xs mt-2">
          <span className={`inline-block px-1.5 py-0.5 rounded font-medium ${statusCls}`}>
            {statusLabel}
          </span>
          {existing.line_count > 0 && (
            <span className="ml-2 text-slate-500">
              {existing.line_count} {t(lang, "admin.persona.payroll.col.staff")}
              {existing.total_net != null && (
                <> · {existing.total_net.toLocaleString()} ฿</>
              )}
            </span>
          )}
        </div>
      )}
      <div className="mt-3">
        {isExisting ? (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => onOpen(existing!.id)}
              className="w-full py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
            >
              {t(lang, "admin.persona.payroll.hub.openPeriod")} →
            </button>
            {/* Exists for THIS branch — in all-branches mode, offer to fill the
                branches that don't have it yet (route skips the ones that do). */}
            {allBranches && !isFuture && (
              <button
                type="button"
                onClick={() => onCreate("auto")}
                disabled={busyAuto || busyManual}
                className="w-full py-1.5 rounded-full bg-brand/90 hover:bg-brand text-white text-xs font-bold disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {busyAuto ? "…" : <><Icon name="building" className="h-3.5 w-3.5" />{t(lang, "admin.persona.payroll.hub.fillOtherBranches")}</>}
              </button>
            )}
          </div>
        ) : isFuture ? (
          <div className="text-center py-2">
            <div className="text-xs text-slate-500 italic mb-1.5">
              {t(lang, "admin.persona.payroll.hub.notReachedYet")}
            </div>
            <button
              type="button"
              onClick={() => onForceOpen()}
              disabled={busyAuto || busyManual}
              className="text-xs text-amber-700 hover:text-amber-800 hover:underline disabled:opacity-50"
              title={t(lang, "admin.persona.payroll.hub.forceOpenHint")}
            >
              {(busyAuto || busyManual) ? "…" : t(lang, "admin.persona.payroll.hub.forceOpenLink")}
            </button>
          </div>
        ) : allBranches ? (
          // All-branches mode → one auto-create button that covers every branch.
          <button
            type="button"
            onClick={() => onCreate("auto")}
            disabled={busyAuto || busyManual}
            className="w-full py-1.5 rounded-full bg-brand hover:opacity-90 text-white text-xs font-bold disabled:opacity-50"
            title={t(lang, "admin.persona.payroll.hub.allBranchesHint")}
          >
            <span className="inline-flex items-center justify-center gap-1.5">
              {busyAuto ? "…" : <><Icon name="building" className="h-3.5 w-3.5" />{t(lang, "admin.persona.payroll.hub.createAllBranches")}</>}
            </span>
          </button>
        ) : (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => onCreate("auto")}
              disabled={busyAuto || busyManual}
              className="w-full py-1.5 rounded-full bg-brand hover:opacity-90 text-white text-xs font-bold disabled:opacity-50"
              title={t(lang, "admin.persona.payroll.hub.dataSourceAutoHint")}
            >
              {busyAuto ? "…" : t(lang, "admin.persona.payroll.hub.createAuto")}
            </button>
            <button
              type="button"
              onClick={() => onCreate("manual")}
              disabled={busyAuto || busyManual}
              className="w-full py-1.5 rounded-md bg-white border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-700 disabled:opacity-50"
              title={t(lang, "admin.persona.payroll.hub.dataSourceManualHint")}
            >
              {busyManual ? "…" : t(lang, "admin.persona.payroll.hub.createManual")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
