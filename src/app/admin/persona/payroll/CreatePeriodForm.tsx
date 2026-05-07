"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";

type Defaults = { start: string; end: string; pay: string };

export default function CreatePeriodForm({
  lang, weekDefaults, monthDefaults
}: {
  lang: Lang;
  weekDefaults: Defaults;
  monthDefaults: Defaults;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [cycle, setCycle] = useState<"weekly" | "monthly">("weekly");
  const [start, setStart] = useState(weekDefaults.start);
  const [end, setEnd] = useState(weekDefaults.end);
  const [pay, setPay] = useState(weekDefaults.pay);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function switchCycle(c: "weekly" | "monthly"): void {
    setCycle(c);
    if (c === "weekly") {
      setStart(weekDefaults.start);
      setEnd(weekDefaults.end);
      setPay(weekDefaults.pay);
    } else {
      setStart(monthDefaults.start);
      setEnd(monthDefaults.end);
      setPay(monthDefaults.pay);
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/payroll/periods"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cycle, period_start: start, period_end: end, pay_date: pay
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
        setErr(t(lang, errKey as any));
      }
    } catch {
      setErr(t(lang, "common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card border-l-4 border-brand bg-rose-50/30">
      <h2 className="font-bold text-slate-800 mb-3">
        {t(lang, "admin.persona.payroll.hub.createPeriod")}
      </h2>

      {/* Cycle toggle */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <button type="button"
          onClick={() => switchCycle("weekly")}
          className={`px-3 py-2 rounded-lg border text-sm font-medium transition ${
            cycle === "weekly"
              ? "border-brand bg-white text-brand ring-1 ring-brand/30"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}>
          {t(lang, "admin.persona.payroll.hub.weeklyTitle")}
          <div className="text-xs font-normal text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.hub.weeklyDesc")}
          </div>
        </button>
        <button type="button"
          onClick={() => switchCycle("monthly")}
          className={`px-3 py-2 rounded-lg border text-sm font-medium transition ${
            cycle === "monthly"
              ? "border-brand bg-white text-brand ring-1 ring-brand/30"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}>
          {t(lang, "admin.persona.payroll.hub.monthlyTitle")}
          <div className="text-xs font-normal text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.hub.monthlyDesc")}
          </div>
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.periodStart")}</label>
          <input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.periodEnd")}</label>
          <input type="date" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.field.payDate")}</label>
          <input type="date" className="input" value={pay} onChange={(e) => setPay(e.target.value)} />
        </div>
      </div>

      {err && <div className="text-rose-600 text-sm mt-2">✗ {err}</div>}

      <div className="flex justify-end mt-3">
        <button type="button" onClick={submit} disabled={busy}
          className="btn-primary text-sm">
          {busy ? t(lang, "common.submitting") : t(lang, "admin.persona.payroll.hub.computeBtn")}
        </button>
      </div>
    </div>
  );
}
