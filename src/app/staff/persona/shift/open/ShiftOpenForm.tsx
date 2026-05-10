"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// The branch is pinned to whichever branch the staff selected at
// /staff/branch-picker (session activeBranchId). To swap branches
// mid-day, staff uses the topbar "เปลี่ยน" link — this form just
// trusts the server-supplied branch and submits to it.

type ChecklistItem = { id: number; label: string };

export default function ShiftOpenForm({
  branchId, branchName, openerName, today, yesterdayClosingHint, checklistItems
}: {
  branchId: number;
  branchName: string;
  openerName: string;
  today: string;
  yesterdayClosingHint: number | null;
  checklistItems: ChecklistItem[];
}) {
  const router = useRouter();
  const { t } = useLang();

  const [reportDate, setReportDate] = useState(today);
  const [yesterdayAmount, setYesterdayAmount] = useState<string>(
    yesterdayClosingHint != null ? String(yesterdayClosingHint) : ""
  );
  const [morningAmount, setMorningAmount] = useState<string>("");
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, false]))
  );

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function toggleAll(value: boolean) {
    setChecked(Object.fromEntries(checklistItems.map((it) => [it.id, value])));
  }

  function parseAmount(s: string): number | null {
    const trimmed = s.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed.replace(/,/g, ""));
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      const yesterdayParsed = parseAmount(yesterdayAmount);
      const morningParsed = parseAmount(morningAmount);
      const checklistPayload = checklistItems.map((it) => ({
        label: it.label,
        checked: !!checked[it.id]
      }));

      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "shift_open",
          report_date: reportDate,
          branch_id: branchId,
          data: {
            yesterday_closing_amount: yesterdayParsed,
            morning_drawer_amount: morningParsed,
            checklist: checklistPayload
          }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: t("common.error") });
        return;
      }
      setMsg({ kind: "ok", text: t("staff.persona.shift.open.savedOk") });
      setDone(true);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const allChecked = checklistItems.every((it) => checked[it.id]);
    return (
      <div className="card text-center space-y-3">
        <div className="text-5xl">{allChecked ? "✓" : "⚠"}</div>
        <h2 className="text-xl font-bold text-slate-800">
          {t("staff.persona.shift.open.done.title")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.shift.open.done.body", { branch: branchName })}
        </p>
        {!allChecked && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
            {t("staff.persona.shift.open.done.partialWarning")}
          </div>
        )}
        <button type="button" onClick={() => router.push("/staff/persona")}
          className="btn-secondary w-full">
          {t("common.back")}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="card space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("staff.persona.shift.open.field.date")}</label>
            <input type="date" className="input"
              value={reportDate} max={today}
              onChange={(e) => setReportDate(e.target.value)} />
          </div>
          <div>
            <label className="label">{t("staff.persona.shift.open.field.opener")}</label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={openerName} readOnly />
          </div>
        </div>

        <div>
          <label className="label">
            {t("staff.persona.shift.open.field.yesterdayClosing")}
            {yesterdayClosingHint != null && (
              <span className="ml-2 text-[10px] text-emerald-700 font-medium">
                · {t("staff.persona.shift.open.prefilled")}
              </span>
            )}
          </label>
          <input type="number" inputMode="decimal" min={0} step="0.01"
            className="input"
            value={yesterdayAmount}
            placeholder="0.00"
            onChange={(e) => setYesterdayAmount(e.target.value)} />
        </div>

        <div>
          <label className="label">{t("staff.persona.shift.open.field.morningDrawer")} *</label>
          <input type="number" inputMode="decimal" min={0} step="0.01"
            required
            className="input"
            value={morningAmount}
            placeholder="0.00"
            onChange={(e) => setMorningAmount(e.target.value)} />
        </div>
      </div>

      {checklistItems.length > 0 ? (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shift.open.checklistTitle")}
            </h2>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => toggleAll(true)}
                className="px-2.5 py-1 text-xs rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50">
                {t("staff.persona.shift.open.checkAll")}
              </button>
              <button type="button" onClick={() => toggleAll(false)}
                className="px-2.5 py-1 text-xs rounded border border-slate-300 text-slate-600 hover:bg-slate-50">
                {t("staff.persona.shift.open.uncheckAll")}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            {checklistItems.map((it) => {
              const isChecked = !!checked[it.id];
              return (
                <label
                  key={it.id}
                  className={`flex items-center gap-3 p-3 rounded-xl border-[1.5px] cursor-pointer transition ${
                    isChecked
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="w-5 h-5"
                    checked={isChecked}
                    onChange={(e) => setChecked((prev) => ({
                      ...prev,
                      [it.id]: e.target.checked
                    }))}
                  />
                  <span className="text-sm flex-1">{it.label}</span>
                  <span className={`text-xs font-bold ${isChecked ? "text-emerald-700" : "text-slate-400"}`}>
                    {isChecked ? "✓" : "✗"}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-xs text-slate-400">
            {t("staff.persona.shift.open.checklistHint")}
          </p>
        </div>
      ) : (
        <div className="card text-xs text-slate-500 text-center">
          {t("staff.persona.shift.open.checklistEmptyForBranch")}
        </div>
      )}

      {msg && (
        <div className={`text-sm text-center ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <button type="submit" disabled={busy}
        className="btn-primary w-full text-base py-3.5">
        {busy
          ? t("staff.persona.shift.open.submitting")
          : t("staff.persona.shift.open.submit")}
      </button>
    </form>
  );
}
