"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { formatBkkDateTime } from "@/lib/time";

type DailyRow = {
  id: number;
  date: string;
  amount: number;
  enteredByName: string;
  enteredAt: string;
  updatedByName: string | null;
  updatedAt: string | null;
};

export default function ServiceChargeClient({
  month, dailyRows, daysInMonth
}: {
  month: string;          // YYYY-MM
  dailyRows: DailyRow[];
  daysInMonth: number;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [draftAmount, setDraftAmount] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Build a complete date->row map so the table can render missing
  // days as placeholders. We don't show future days (no point editing
  // them yet); past + today only.
  const byDate = useMemo(() => {
    const m = new Map<string, DailyRow>();
    for (const r of dailyRows) m.set(r.date, r);
    return m;
  }, [dailyRows]);

  // Bangkok "today" used as the upper bound for the rendered ledger.
  const todayBkk = useMemo(() => {
    return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }, []);

  const allDates = useMemo(() => {
    const out: string[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      if (date > todayBkk) break; // don't list future days
      out.push(date);
    }
    return out;
  }, [month, daysInMonth, todayBkk]);

  async function save(date: string) {
    setErr(null);
    const amount = Number(draftAmount.trim().replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount < 0) {
      setErr(t("admin.persona.svc.amountInvalid"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/service-charge/daily"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, amount_baht: amount })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error || t("common.error"));
        return;
      }
      setEditingDate(null);
      setDraftAmount("");
      startTransition(() => router.refresh());
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2 className="font-bold text-slate-800 text-sm mb-3">
        {t("admin.persona.svc.dailyTitle")}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.5px] text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-2">{t("admin.persona.svc.col.date")}</th>
              <th className="py-2 pr-2 text-right">{t("admin.persona.svc.col.amount")}</th>
              <th className="py-2 pr-2">{t("admin.persona.svc.col.enteredBy")}</th>
              <th className="py-2 pr-2">{t("admin.persona.svc.col.lastEdit")}</th>
              <th className="py-2 pr-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {allDates.map((date) => {
              const row = byDate.get(date);
              const isEditing = editingDate === date;
              return (
                <tr key={date} className="border-b border-slate-100 last:border-b-0">
                  <td className="py-2 pr-2 font-mono text-xs">{date}</td>
                  <td className="py-2 pr-2 text-right font-mono">
                    {isEditing ? (
                      <input
                        type="number" inputMode="decimal" min={0} step="0.01"
                        autoFocus
                        className="input w-32 text-right text-sm"
                        value={draftAmount}
                        onChange={(e) => setDraftAmount(e.target.value)}
                      />
                    ) : row ? (
                      row.amount.toFixed(2)
                    ) : (
                      <span className="text-slate-400 italic">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-xs text-slate-600">
                    {row ? row.enteredByName : <span className="text-slate-400 italic">{t("admin.persona.svc.notEntered")}</span>}
                  </td>
                  <td className="py-2 pr-2 text-[11px] text-slate-500">
                    {row?.updatedByName ? (
                      <>
                        {row.updatedByName}
                        <span className="text-slate-400 ml-1">
                          · {row.updatedAt ? formatBkkDateTime(row.updatedAt) : ""}
                        </span>
                      </>
                    ) : row ? (
                      <span className="text-slate-400">{t("admin.persona.svc.noEdits")}</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-2 text-right whitespace-nowrap">
                    {isEditing ? (
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => save(date)}
                          className="text-xs px-2 py-0.5 rounded bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50"
                        >
                          {busy ? "…" : t("common.save")}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => { setEditingDate(null); setErr(null); }}
                          className="text-xs px-2 py-0.5 rounded border border-slate-300 text-slate-600 hover:bg-slate-50"
                        >
                          {t("common.cancel")}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingDate(date);
                          setDraftAmount(row ? String(row.amount) : "");
                          setErr(null);
                        }}
                        className="text-xs text-brand hover:underline"
                      >
                        {row ? t("admin.persona.svc.edit") : t("admin.persona.svc.enter")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {err && (
        <div className="mt-2 text-xs text-rose-600 text-right">
          ✗ {err}
        </div>
      )}
      <p className="text-[10px] text-slate-400 mt-2">
        {t("admin.persona.svc.dailyHint")}
      </p>
    </div>
  );
}
