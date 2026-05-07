"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { formatLongDate, formatMonthDay } from "@/lib/time";

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

function monthlyPeriodFor(yearMonth: string): { start: string; end: string; pay: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
  return {
    start: `${yearMonth}-01`,
    end,
    pay: end
  };
}

function todayMonth(): string {
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 7);
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

  async function createPeriod(p: SuggestedPeriod, dataSource: DataSource): Promise<void> {
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
          pay_date: p.pay
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok && j.period_id) {
        startTransition(() => router.push(`/admin/persona/payroll/${j.period_id}`));
      } else {
        const errKey =
          j?.error === "duplicate_period" ? "admin.persona.payroll.err.duplicate" :
          j?.error === "invalid_range" ? "admin.persona.payroll.err.invalidRange" :
          "common.error";
        setErrMsg(t(lang, errKey as any));
      }
    } catch {
      setErrMsg(t(lang, "common.error"));
    } finally {
      setBusyKey(null);
    }
  }

  const monthLabel = formatMonthDay(`${month}-15`, lang).split(" ").slice(1).join(" "); // just the month-name

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
        <input
          type="month"
          className="input text-sm max-w-[160px]"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
      </div>

      {errMsg && (
        <div className="text-rose-600 text-sm">✗ {errMsg}</div>
      )}

      {/* ── Part-time group ─────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-800">
            <span className="inline-block w-2 h-2 rounded-full bg-violet-500 mr-2 align-middle"></span>
            {t(lang, "admin.persona.employees.employment.pt")}
          </h3>
          <span className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.hub.ptGroupDesc", { month: monthLabel })}
          </span>
        </div>
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
                  cycleLabel={t(lang, "admin.persona.payroll.hub.weeklyShort")}
                  existing={ex}
                  busyKey={busyKey}
                  cardKey={key}
                  onCreate={(ds) => createPeriod(sp, ds)}
                  onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                  accentClass="hover:border-violet-400/60"
                />
              );
            })}
          </div>
        )}
      </div>

      {/* ── Full-time group ─────────────────────────────────── */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-slate-800">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-2 align-middle"></span>
            {t(lang, "admin.persona.employees.employment.ft")}
          </h3>
          <span className="text-xs text-slate-500">
            {t(lang, "admin.persona.payroll.hub.ftGroupDesc", { month: monthLabel })}
          </span>
        </div>
        {/* FT-weekly subgroup */}
        <div className="mb-3">
          <div className="text-xs font-medium text-slate-500 mb-1.5 px-1">
            ▸ {t(lang, "admin.persona.payroll.hub.weeklySub")}
          </div>
          {weeklyDates.length === 0 ? (
            <p className="text-xs text-slate-500 italic px-3">
              {t(lang, "admin.persona.payroll.hub.noMondays")}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {weeklyDates.map((p) => {
                const sp: SuggestedPeriod = { ...p, cycle: "weekly", target: "ft" };
                const key = `weekly|ft|${p.start}|${p.end}`;
                const ex = existingByKey.get(key);
                return (
                  <PeriodCard
                    key={key}
                    lang={lang}
                    start={p.start}
                    end={p.end}
                    pay={p.pay}
                    cycleLabel={t(lang, "admin.persona.payroll.hub.weeklyShort")}
                    existing={ex}
                    busy={busyKey === key}
                    onCreate={() => createPeriod(sp)}
                    onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                    accentClass="hover:border-emerald-400/60"
                  />
                );
              })}
            </div>
          )}
        </div>
        {/* FT-monthly subgroup */}
        <div>
          <div className="text-xs font-medium text-slate-500 mb-1.5 px-1">
            ▸ {t(lang, "admin.persona.payroll.hub.monthlySub")}
          </div>
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
                  cycleLabel={t(lang, "admin.persona.payroll.hub.monthlyShort")}
                  existing={ex}
                  busyKey={busyKey}
                  cardKey={key}
                  onCreate={(ds) => createPeriod(sp, ds)}
                  onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                  accentClass="hover:border-emerald-400/60"
                />
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}

function PeriodCard({
  lang, start, end, pay, cycleLabel, existing, busyKey, cardKey, onCreate, onOpen, accentClass
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
  accentClass: string;
}) {
  const isExisting = !!existing;
  const isPaid = existing?.status === "paid";
  const isFinalized = existing?.status === "finalized";
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
    : `bg-white border-slate-200 ${accentClass}`;

  return (
    <div className={`rounded-lg border p-3 transition ${cardBgCls}`}>
      <div className="text-xs text-slate-500">{cycleLabel}</div>
      <div className="font-medium text-slate-800 mt-0.5 leading-tight">
        {formatMonthDay(start, lang)} – {formatMonthDay(end, lang)}
      </div>
      <div className="text-xs text-slate-500 mt-1">
        {t(lang, "admin.persona.payroll.col.payDate")}:{" "}
        <span className="font-medium text-slate-700">{formatLongDate(pay, lang)}</span>
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
          <button
            type="button"
            onClick={() => onOpen(existing!.id)}
            className="w-full py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700"
          >
            {t(lang, "admin.persona.payroll.hub.openPeriod")} →
          </button>
        ) : (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => onCreate("auto")}
              disabled={busyAuto || busyManual}
              className="w-full py-1.5 rounded-md bg-brand hover:opacity-90 text-white text-xs font-bold disabled:opacity-50"
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
