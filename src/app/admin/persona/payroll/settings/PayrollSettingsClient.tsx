"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { fmtMoney } from "@/lib/format";

export type PayrollSettings = {
  ot_mode: "flat" | "legal";
  ot_flat_per_15min: number;
  break_threshold_minutes: number;
  break_deduction_minutes: number;
  long_shift_threshold_minutes: number;
  long_shift_break_minutes: number;
  sso_rate: number;
  sso_cap: number;
  pt_default_hourly_rate: number;
  wht_rate: number;
};

export default function PayrollSettingsClient({
  initial, lang
}: { initial: PayrollSettings; lang: Lang }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [otMode, setOtMode] = useState<"flat" | "legal">(initial.ot_mode);
  const [otFlat, setOtFlat] = useState(String(initial.ot_flat_per_15min));
  const [breakThr, setBreakThr] = useState(String(initial.break_threshold_minutes));
  const [breakDed, setBreakDed] = useState(String(initial.break_deduction_minutes));
  const [longThr, setLongThr] = useState(String(initial.long_shift_threshold_minutes));
  const [longDed, setLongDed] = useState(String(initial.long_shift_break_minutes));
  const [ssoRatePct, setSsoRatePct] = useState(String(initial.sso_rate * 100));
  const [ssoCap, setSsoCap] = useState(String(initial.sso_cap));
  const [ptDefault, setPtDefault] = useState(String(initial.pt_default_hourly_rate));
  const [whtRatePct, setWhtRatePct] = useState(String(initial.wht_rate * 100));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/payroll/settings"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ot_mode: otMode,
          ot_flat_per_15min: Number(otFlat),
          break_threshold_minutes: Number(breakThr),
          break_deduction_minutes: Number(breakDed),
          long_shift_threshold_minutes: Number(longThr),
          long_shift_break_minutes: Number(longDed),
          sso_rate: Number(ssoRatePct) / 100,
          sso_cap: Number(ssoCap),
          pt_default_hourly_rate: Number(ptDefault),
          wht_rate: Number(whtRatePct) / 100
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t(lang, "common.saved") });
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
      }
    } catch {
      setMsg({ kind: "err", text: t(lang, "common.error") });
    } finally {
      setBusy(false);
    }
  }

  const otFlatPerHour = Number(otFlat) * 4 || 0;

  return (
    <div className="space-y-4">
      {/* OT mode */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.persona.payroll.settings.otTitle")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.settings.otDesc")}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className={`border rounded-lg p-3 cursor-pointer transition ${
            otMode === "flat"
              ? "border-brand bg-rose-50/40 ring-1 ring-brand/30"
              : "border-slate-200 hover:bg-slate-50"
          }`}>
            <div className="flex items-center gap-2 mb-1">
              <input type="radio" name="ot_mode" checked={otMode === "flat"}
                onChange={() => setOtMode("flat")} />
              <span className="font-medium text-slate-800">
                {t(lang, "admin.persona.payroll.settings.otFlatTitle")}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.settings.otFlatDesc")}
            </p>
          </label>
          <label className={`border rounded-lg p-3 cursor-pointer transition ${
            otMode === "legal"
              ? "border-brand bg-rose-50/40 ring-1 ring-brand/30"
              : "border-slate-200 hover:bg-slate-50"
          }`}>
            <div className="flex items-center gap-2 mb-1">
              <input type="radio" name="ot_mode" checked={otMode === "legal"}
                onChange={() => setOtMode("legal")} />
              <span className="font-medium text-slate-800">
                {t(lang, "admin.persona.payroll.settings.otLegalTitle")}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {t(lang, "admin.persona.payroll.settings.otLegalDesc")}
            </p>
          </label>
        </div>

        {otMode === "flat" && (
          <div className="bg-slate-50 rounded-lg p-3 space-y-2">
            <label className="block">
              <span className="label">{t(lang, "admin.persona.payroll.settings.otFlatRate")}</span>
              <div className="flex items-center gap-2 mt-1">
                <input type="number" step="0.01" min="0" inputMode="decimal"
                  className="input max-w-[120px]"
                  value={otFlat} onChange={(e) => setOtFlat(e.target.value)} />
                <span className="text-sm text-slate-500">
                  {t(lang, "admin.persona.payroll.settings.bahtPer15min")}
                </span>
              </div>
            </label>
            <p className="text-xs text-emerald-700">
              ≈ {fmtMoney(otFlatPerHour)} {t(lang, "admin.persona.employees.bahtPerHour")}
            </p>
          </div>
        )}
      </div>

      {/* Break deduction */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.persona.payroll.settings.breakTitle")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.settings.breakDesc")}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">
              {t(lang, "admin.persona.payroll.settings.breakRule1Threshold")}
            </label>
            <div className="flex items-center gap-2">
              <input type="number" step="15" min="0" className="input max-w-[100px]"
                value={breakThr} onChange={(e) => setBreakThr(e.target.value)} />
              <span className="text-sm text-slate-500">
                {t(lang, "admin.persona.payroll.settings.minutes")}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              ({(Number(breakThr) / 60).toFixed(1)} {t(lang, "admin.persona.payroll.settings.hours")})
            </p>
          </div>
          <div>
            <label className="label">
              {t(lang, "admin.persona.payroll.settings.breakRule1Deduct")}
            </label>
            <div className="flex items-center gap-2">
              <input type="number" step="5" min="0" className="input max-w-[100px]"
                value={breakDed} onChange={(e) => setBreakDed(e.target.value)} />
              <span className="text-sm text-slate-500">
                {t(lang, "admin.persona.payroll.settings.minutes")}
              </span>
            </div>
          </div>
          <div>
            <label className="label">
              {t(lang, "admin.persona.payroll.settings.breakRule2Threshold")}
            </label>
            <div className="flex items-center gap-2">
              <input type="number" step="15" min="0" className="input max-w-[100px]"
                value={longThr} onChange={(e) => setLongThr(e.target.value)} />
              <span className="text-sm text-slate-500">
                {t(lang, "admin.persona.payroll.settings.minutes")}
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              ({(Number(longThr) / 60).toFixed(1)} {t(lang, "admin.persona.payroll.settings.hours")})
            </p>
          </div>
          <div>
            <label className="label">
              {t(lang, "admin.persona.payroll.settings.breakRule2Deduct")}
            </label>
            <div className="flex items-center gap-2">
              <input type="number" step="5" min="0" className="input max-w-[100px]"
                value={longDed} onChange={(e) => setLongDed(e.target.value)} />
              <span className="text-sm text-slate-500">
                {t(lang, "admin.persona.payroll.settings.minutes")}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* SSO */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.persona.payroll.settings.ssoTitle")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.settings.ssoDesc")}
          </p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.settings.ssoRate")}</label>
            <div className="flex items-center gap-2">
              <input type="number" step="0.1" min="0" max="100" className="input max-w-[100px]"
                value={ssoRatePct} onChange={(e) => setSsoRatePct(e.target.value)} />
              <span className="text-sm text-slate-500">%</span>
            </div>
          </div>
          <div>
            <label className="label">{t(lang, "admin.persona.payroll.settings.ssoCap")}</label>
            <div className="flex items-center gap-2">
              <input type="number" step="0.01" min="0" inputMode="decimal"
                className="input max-w-[120px]"
                value={ssoCap} onChange={(e) => setSsoCap(e.target.value)} />
              <span className="text-sm text-slate-500">บาท / เดือน</span>
            </div>
          </div>
        </div>
      </div>

      {/* WHT (out-of-system) */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.persona.payroll.settings.whtTitle")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.settings.whtDesc")}
          </p>
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.settings.whtRate")}</label>
          <div className="flex items-center gap-2">
            <input type="number" step="0.1" min="0" max="100" className="input max-w-[100px]"
              value={whtRatePct} onChange={(e) => setWhtRatePct(e.target.value)} />
            <span className="text-sm text-slate-500">%</span>
          </div>
        </div>
      </div>

      {/* PT default rate */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-semibold text-slate-800">
            {t(lang, "admin.persona.payroll.settings.ptDefaultTitle")}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {t(lang, "admin.persona.payroll.settings.ptDefaultDesc")}
          </p>
        </div>
        <div>
          <label className="label">{t(lang, "admin.persona.payroll.settings.ptDefaultRate")}</label>
          <div className="flex items-center gap-2">
            <input type="number" step="0.01" min="0" inputMode="decimal"
              className="input max-w-[120px]"
              value={ptDefault} onChange={(e) => setPtDefault(e.target.value)} />
            <span className="text-sm text-slate-500">
              {t(lang, "admin.persona.employees.bahtPerHour")}
            </span>
          </div>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center justify-between gap-3">
        {msg && (
          <span className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
            {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
          </span>
        )}
        <button type="button" onClick={save} disabled={busy}
          className="btn-primary text-sm ml-auto">
          {busy ? t(lang, "common.submitting") : t(lang, "common.save")}
        </button>
      </div>
    </div>
  );
}
