"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

// One row per (cycle, period_start, period_end) that already exists in DB
export type ExistingPeriod = {
  id: number;
  cycle: "weekly" | "monthly";
  period_start: string;
  period_end: string;
  pay_date: string;
  status: "draft" | "finalized" | "cancelled";
  total_gross: number | null;
  total_net: number | null;
  line_count: number;
};

type SuggestedPeriod = {
  start: string;
  end: string;
  pay: string;
  cycle: "weekly" | "monthly";
};

function formatBkkDate(d: string, lang: Lang): string {
  if (!d) return "";
  if (lang === "th") {
    const [y, m, dd] = d.split("-");
    return `${dd}/${m}/${String(Number(y) + 543).slice(2)}`;
  }
  return d;
}

function formatShort(d: string, lang: Lang): string {
  if (!d) return "";
  const [y, m, dd] = d.split("-");
  if (lang === "th") {
    const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
                    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
    return `${Number(dd)} ${months[Number(m) - 1]}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1]} ${Number(dd)}`;
}

// Compute weekly periods whose pay_date falls inside the given calendar month.
// (Pay date determines which month the period belongs to — for tax docs.)
function weeklyPeriodsInPayMonth(yearMonth: string): SuggestedPeriod[] {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const periods: SuggestedPeriod[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCDay() === 1) {
      // This Monday is a pay-date for the previous Mon–Sun period.
      const sunday = new Date(dt.getTime() - 86400000);
      const monday = new Date(sunday.getTime() - 6 * 86400000);
      periods.push({
        cycle: "weekly",
        start: monday.toISOString().slice(0, 10),
        end: sunday.toISOString().slice(0, 10),
        pay: dt.toISOString().slice(0, 10)
      });
    }
  }
  return periods;
}

function monthlyPeriodFor(yearMonth: string): SuggestedPeriod {
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
  return {
    cycle: "monthly",
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

  // Build a lookup map for existing periods by (cycle|start|end)
  const existingByKey = useMemo(() => {
    const m = new Map<string, ExistingPeriod>();
    for (const p of existing) m.set(`${p.cycle}|${p.period_start}|${p.period_end}`, p);
    return m;
  }, [existing]);

  const weeklyPeriods = useMemo(() => weeklyPeriodsInPayMonth(month), [month]);
  const monthlyPeriod = useMemo(() => monthlyPeriodFor(month), [month]);

  async function createPeriod(p: SuggestedPeriod): Promise<void> {
    const key = `${p.cycle}|${p.start}|${p.end}`;
    setBusyKey(key);
    setErrMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/payroll/periods"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycle: p.cycle,
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

  const monthlyExisting = existingByKey.get(`monthly|${monthlyPeriod.start}|${monthlyPeriod.end}`);

  return (
    <div className="card border-l-4 border-brand bg-rose-50/30 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="font-bold text-slate-800">
          {t(lang, "admin.persona.payroll.hub.payPeriods")}
        </h2>
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

      {/* Weekly periods (Part-time + Full-time-weekly) */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">
          {t(lang, "admin.persona.payroll.hub.weeklyHeader")}
          <span className="text-xs font-normal text-slate-500 ml-2">
            {t(lang, "admin.persona.payroll.hub.weeklyHeaderDesc")}
          </span>
        </h3>
        {weeklyPeriods.length === 0 ? (
          <p className="text-xs text-slate-500 italic">
            {t(lang, "admin.persona.payroll.hub.noMondays")}
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {weeklyPeriods.map((p) => {
              const key = `${p.cycle}|${p.start}|${p.end}`;
              const ex = existingByKey.get(key);
              return (
                <PeriodCard
                  key={key}
                  lang={lang}
                  cycle="weekly"
                  start={p.start}
                  end={p.end}
                  pay={p.pay}
                  existing={ex}
                  busy={busyKey === key}
                  onCreate={() => createPeriod(p)}
                  onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Monthly period (Full-time-monthly) */}
      <div>
        <h3 className="text-sm font-semibold text-slate-700 mb-2">
          {t(lang, "admin.persona.payroll.hub.monthlyHeader")}
          <span className="text-xs font-normal text-slate-500 ml-2">
            {t(lang, "admin.persona.payroll.hub.monthlyHeaderDesc")}
          </span>
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <PeriodCard
            lang={lang}
            cycle="monthly"
            start={monthlyPeriod.start}
            end={monthlyPeriod.end}
            pay={monthlyPeriod.pay}
            existing={monthlyExisting}
            busy={busyKey === `monthly|${monthlyPeriod.start}|${monthlyPeriod.end}`}
            onCreate={() => createPeriod(monthlyPeriod)}
            onOpen={(id) => startTransition(() => router.push(`/admin/persona/payroll/${id}`))}
          />
        </div>
      </div>
    </div>
  );

  // Helper component (closure over translation)
  function PeriodCard({
    lang, cycle, start, end, pay, existing, busy, onCreate, onOpen
  }: {
    lang: Lang;
    cycle: "weekly" | "monthly";
    start: string;
    end: string;
    pay: string;
    existing: ExistingPeriod | undefined;
    busy: boolean;
    onCreate: () => void;
    onOpen: (id: number) => void;
  }) {
    const isExisting = !!existing;
    const isFinalized = existing?.status === "finalized";

    return (
      <div className={`rounded-lg border p-3 transition ${
        isFinalized
          ? "bg-emerald-50/60 border-emerald-200"
          : isExisting
          ? "bg-amber-50/60 border-amber-200"
          : "bg-white border-slate-200 hover:border-brand/50"
      }`}>
        <div className="text-xs text-slate-500">
          {cycle === "weekly"
            ? t(lang, "admin.persona.payroll.hub.weeklyShort")
            : t(lang, "admin.persona.payroll.hub.monthlyShort")}
        </div>
        <div className="font-medium text-slate-800 mt-0.5">
          {formatShort(start, lang)} – {formatShort(end, lang)}
        </div>
        <div className="text-xs text-slate-500 mt-1">
          {t(lang, "admin.persona.payroll.col.payDate")}:{" "}
          <span className="font-medium text-slate-700">{formatBkkDate(pay, lang)}</span>
        </div>
        {isExisting && (
          <div className="text-xs mt-2">
            <span className={`inline-block px-1.5 py-0.5 rounded font-medium ${
              isFinalized ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
            }`}>
              {isFinalized
                ? t(lang, "admin.persona.payroll.status.finalized")
                : t(lang, "admin.persona.payroll.status.draft")}
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
            <button
              type="button"
              onClick={onCreate}
              disabled={busy}
              className="w-full py-1.5 rounded-md bg-brand hover:opacity-90 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy ? "…" : t(lang, "admin.persona.payroll.hub.createComputeBtn")}
            </button>
          )}
        </div>
      </div>
    );
  }
}
