"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Post-shift checklist (เช็คลิสต์หลังเลิกงาน). Mirrors ShiftOpenForm
// without the "yesterday's closing" prefill — the closing-drawer
// amount the staff types here becomes the next day's "ยอดเงินปิดกะ
// เมื่อวาน" prefill on the pre-shift form.

type ChecklistItem = {
  id: number;
  label: string;
  kind: "checkbox" | "text" | "choice" | "amount" | "section";
  options?: string[];
  /** When set, child of another item — rendered indented. */
  parent_id?: number | null;
  /** Marks the amount row featured at top of the LINE Flex card. */
  is_headline?: boolean;
  /** Optional small-text help shown below the label. */
  description?: string | null;
};

/** Normalise a baht amount to "12,345.67". Returns "" when invalid. */
function formatBahtAmount(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const n = Number(trimmed.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return "";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export default function ShiftCloseForm({
  branchId, branchName, closerName, checklistItems,
  requireServiceCharge = false,
  requireTodayClosing = true,
  requireDailyRevenue = true,
  previousData = null
}: {
  branchId: number;
  branchName: string;
  closerName: string;
  checklistItems: ChecklistItem[];
  /** When the branch admin has flipped require_service_charge ON,
   *  the staff form shows a mandatory "ยอดเซอร์วิสชาร์จวันนี้"
   *  field at the top. */
  requireServiceCharge?: boolean;
  /** When the branch admin has flipped require_today_closing ON
   *  (default), the staff form shows "ยอดเงินปิดกะวันนี้" as a
   *  mandatory top-level amount field — was removed 2026-05-23
   *  and brought back as a per-branch toggle 2026-05-25 per
   *  owner direction. The data lands in
   *  daily_reports.data.closing_drawer_amount for downstream
   *  reports / payroll reconciliation. */
  requireTodayClosing?: boolean;
  /** When the branch admin has flipped require_daily_revenue ON
   *  (default true 2026-05-28), the staff form shows an optional
   *  "ยอดขายวันนี้" field. Feeds branch_daily_revenue (ASCENDA COL %
   *  + sales growth) AND appears as a headline figure on the
   *  shift-close LINE Flex report. Optional — admin can backfill via
   *  /admin/ascenda/revenue if staff don't have the number at close. */
  requireDailyRevenue?: boolean;
  /** Most recent superseded report's parsed `data` JSON, if any.
   *  Passed in when admin previously granted an unlock so the form
   *  re-renders pre-filled with what the staff typed before. */
  previousData?: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const { t } = useLang();

  // Pre-fill seed — when previousData carries a prior submission's
  // checklist, build per-id lookup maps once for the initial state.
  // Falls back to empty objects so the form behaves identically
  // when there's no prior submission (the common case).
  const prevByLabel = (() => {
    const m = new Map<string, {
      checked: boolean;
      note: string | null;
      kind?: string;
    }>();
    const arr = (previousData?.checklist ?? []) as Array<{
      label: string;
      checked: boolean;
      note?: string | null;
      kind?: string;
    }>;
    for (const it of arr) {
      m.set(it.label, {
        checked: !!it.checked,
        note: it.note ?? null,
        kind: it.kind
      });
    }
    return m;
  })();

  // Today's closing drawer amount — shown when requireTodayClosing
  // is on (default true). Persists into daily_reports.data.closing_
  // drawer_amount, surfaced on the LINE Flex card + admin reports.
  const [closingAmount, setClosingAmount] = useState<string>(() => {
    const v = previousData?.closing_drawer_amount;
    return typeof v === "number" ? String(v) : "";
  });

  // Service Charge collected from POS today. Only shown + required
  // when requireServiceCharge prop is true. Persisted into
  // daily_service_charge via the daily-report API. Pre-fills from
  // previousData.service_charge_amount if it's a number; otherwise
  // empty so the user can leave-blank-then-fill flow works.
  const [svcAmount, setSvcAmount] = useState<string>(() => {
    const v = previousData?.service_charge_amount;
    return typeof v === "number" ? String(v) : "";
  });
  // 2026-05-27: ASCENDA daily revenue (ยอดขายวันนี้). Optional —
  // staff can skip; admin backfills via /admin/ascenda/revenue.
  // Lands in branch_daily_revenue (NOT in daily_reports.data) so the
  // ASCENDA COL/sales-growth calculators have a clean source.
  const [dailyRevenue, setDailyRevenue] = useState<string>("");
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      // Only restore the checked bool for checkbox-kind rows —
      // text/choice/amount don't really have a meaningful "checked"
      // state visible to the user.
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? prev.checked
        : false;
      return [it.id, restored];
    }))
  );
  const [notes, setNotes] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      // Restore the note for checkbox rows (skip-with-reason text).
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? (prev.note ?? "")
        : "";
      return [it.id, restored];
    }))
  );
  // See ShiftOpenForm for the rationale — text items keep their value
  // here and we mirror them into the (checked, note) payload at submit
  // so downstream renderers (LINE Flex, audit) don't need to know about
  // kinds.
  const [textValues, setTextValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      let restored = "";
      if (prev && (it.kind === "text" || it.kind === "amount")) {
        restored = prev.note ?? "";
        // PREFILL BUG FIX (2026-05): amount items were saved with
        // Thai-style comma grouping ("1,000.00") by formatBahtAmount.
        // The amount renderer uses <input type="number"> which
        // refuses formatted strings and silently shows empty → admin
        // approved the unlock but staff still saw blank amount fields.
        // Strip commas on the way back into the input.
        if (it.kind === "amount") {
          restored = restored.replace(/,/g, "");
        }
      }
      return [it.id, restored];
    }))
  );
  // Choice items: the staff's picked option (or null until picked).
  const [choices, setChoices] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      const restored = prev && it.kind === "choice"
        ? (prev.note ?? null)
        : null;
      return [it.id, restored];
    }))
  );
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<number, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function toggleAll(value: boolean) {
    setChecked((prev) => ({
      ...prev,
      ...Object.fromEntries(
        checklistItems
          .filter((it) => it.kind === "checkbox" || !it.kind)
          .map((it) => [it.id, value])
      )
    }));
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
    const missingNoteIds = checklistItems
      .filter((it) => {
        // 'section' = non-interactive header, never counted as missing.
        if (it.kind === "section") return false;
        if (it.kind === "text" || it.kind === "amount") {
          return !((textValues[it.id] || "").trim());
        }
        if (it.kind === "choice") return !choices[it.id];
        return !checked[it.id] && !((notes[it.id] || "").trim());
      })
      .map((it) => it.id);
    if (missingNoteIds.length > 0) {
      setErrorIds(Object.fromEntries(missingNoteIds.map((id) => [id, true])));
      setOpenNotes((prev) => ({
        ...prev,
        ...Object.fromEntries(missingNoteIds.map((id) => [id, true]))
      }));
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.open.requireNoteForUnchecked", {
          n: String(missingNoteIds.length)
        })
      });
      return;
    }
    // Service charge — only validate when admin requires it. Empty
    // when required = block submit with friendly message.
    if (requireTodayClosing && parseAmount(closingAmount) == null) {
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.close.field.closingAmountRequired")
      });
      setBusy(false);
      return;
    }
    if (requireServiceCharge && parseAmount(svcAmount) == null) {
      setMsg({
        kind: "err",
        text: t("staff.persona.shift.close.svcRequired")
      });
      return;
    }

    setErrorIds({});
    setBusy(true);
    try {
      // closing_drawer_amount — back as a top-level required field
      // (2026-05-25). Null when the toggle is off so existing flow
      // for branches that opt out still works.
      const closingParsed = requireTodayClosing ? parseAmount(closingAmount) : null;
      const svcParsed = parseAmount(svcAmount);
      // Flatten parents-then-children; mark child rows with is_child=true
      // so the LINE Flex renderer indents them under their parent.
      const buildEntry = (it: ChecklistItem, isChild: boolean) => {
        const headlineFlag = it.kind === "amount" && it.is_headline
          ? { is_headline: true }
          : {};
        const descriptionPart = it.description?.trim()
          ? { description: it.description.trim() }
          : {};
        // 'section' header — non-interactive but shipped in payload so
        // the LINE Flex renders the group title inline.
        if (it.kind === "section") {
          return {
            label: it.label,
            kind: "section" as const,
            checked: false,
            note: null,
            ...(isChild ? { is_child: true } : {}),
            ...descriptionPart
          };
        }
        if (it.kind === "text" || it.kind === "amount") {
          const value = (textValues[it.id] || "").trim();
          const formatted = it.kind === "amount" && value
            ? formatBahtAmount(value)
            : value;
          return {
            label: it.label,
            kind: it.kind,
            checked: !!value,
            note: formatted || null,
            ...(isChild ? { is_child: true } : {}),
            ...headlineFlag,
            ...descriptionPart
          };
        }
        if (it.kind === "choice") {
          const sel = choices[it.id];
          return {
            label: it.label,
            kind: "choice" as const,
            checked: !!sel,
            note: sel ?? null,
            ...(isChild ? { is_child: true } : {}),
            ...descriptionPart
          };
        }
        const note = (notes[it.id] || "").trim();
        return {
          label: it.label,
          kind: "checkbox" as const,
          checked: !!checked[it.id],
          note: note ? note : null,
          ...(isChild ? { is_child: true } : {}),
          ...descriptionPart
        };
      };
      const topLevelItems = checklistItems.filter((it) => !it.parent_id);
      const checklistPayload: Array<ReturnType<typeof buildEntry>> = [];
      for (const parent of topLevelItems) {
        checklistPayload.push(buildEntry(parent, false));
        for (const k of checklistItems.filter((c) => c.parent_id === parent.id)) {
          checklistPayload.push(buildEntry(k, true));
        }
      }

      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "shift_close",
          branch_id: branchId,
          data: {
            closing_drawer_amount: closingParsed,
            // Send SVC only when staff actually filled it. null on the
            // server means "don't touch daily_service_charge"; an
            // explicit 0 means "we collected nothing today" and is
            // recorded for transparency.
            service_charge_amount: svcParsed,
            // ASCENDA daily revenue — same null-vs-0 contract as SVC.
            // null = staff skipped, admin backfills; 0 = explicitly
            // zero (closed for renovation etc.).
            daily_revenue: parseAmount(dailyRevenue),
            checklist: checklistPayload
          }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.error === "already_submitted") {
        router.refresh();
        return;
      }
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: t("common.error") });
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card text-center space-y-3">
        <div className="text-5xl">✓</div>
        <h2 className="text-xl font-bold text-slate-800">
          {t("staff.persona.shiftReport.submitted.title")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.shiftReport.submitted.body", {
            type: t("staff.persona.shiftReport.typeLabel.shiftClose"),
            branch: branchName
          })}
        </p>
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
            <label className="label">{t("staff.persona.shift.open.field.opener")}</label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={closerName} readOnly />
          </div>
          <div>
            <label className="label">
              {t("staff.persona.shift.open.field.branch")}
            </label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={branchName} readOnly />
          </div>
        </div>

        {/* Closing-drawer field removed 2026-05-23 — admins now own
            the checklist schema entirely (they can add a kind=amount
            row for closing-drawer with their preferred label). The
            duplicate top-level + checklist version was confusing. */}

        {/* Today's closing drawer — required-by-default per-branch
            toggle (2026-05-25). Sits above the SVC field because
            it's the most-used metric for end-of-day reconciliation. */}
        {requireTodayClosing && (
          <div>
            <label className="label">{t("staff.persona.shift.close.field.closingAmount")} *</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              required
              className="input"
              value={closingAmount}
              placeholder="0.00"
              onChange={(e) => setClosingAmount(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("staff.persona.shift.close.field.closingAmountHint")}
            </p>
          </div>
        )}

        {/* Service Charge — only when branch admin has flipped the
            require_service_charge toggle on. Feeds the staff-share
            calculator at /admin/persona/service-charge. */}
        {requireServiceCharge && (
          <div>
            <label className="label">{t("staff.persona.shift.close.field.svcAmount")} *</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              required
              className="input"
              value={svcAmount}
              placeholder="0.00"
              onChange={(e) => setSvcAmount(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("staff.persona.shift.close.field.svcAmountHint")}
            </p>
          </div>
        )}

        {/* ASCENDA daily revenue — per-branch toggle (2026-05-28).
            Optional when shown. Feeds the COL % + sales-growth %
            auto-calculators AND appears as a headline figure on the
            LINE Flex report. Staff can skip; admin backfills via
            /admin/ascenda/revenue. */}
        {requireDailyRevenue && (
          <div>
            <label className="label">ยอดขายวันนี้ (บาท)</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              className="input"
              value={dailyRevenue}
              placeholder="0.00 (ไม่บังคับ)"
              onChange={(e) => setDailyRevenue(e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">
              ใช้คำนวณ KPI ASCENDA (COL % และยอดขายโต) · เว้นว่างได้ถ้ายังไม่ทราบ
            </p>
          </div>
        )}
      </div>

      {checklistItems.length > 0 ? (
        <div className="card space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shift.close.checklistTitle")}
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
            {/* Reorder so each parent is immediately followed by its
                children. Display-order alone may interleave across
                parent groups since children get their own
                display_order scoped to their parent. */}
            {(() => {
              const ordered: ChecklistItem[] = [];
              for (const p of checklistItems.filter((it) => !it.parent_id)) {
                ordered.push(p);
                for (const c of checklistItems.filter((c) => c.parent_id === p.id)) {
                  ordered.push(c);
                }
              }
              return ordered.map((it) => {
              const hasError = !!errorIds[it.id];
              const isChild = !!it.parent_id;
              const indentCls = isChild ? "ml-4 pl-3 border-l-2 border-slate-200" : "";
              if (it.kind === "section") {
                return (
                  <div key={it.id} className={`${indentCls} pt-3 pb-1`}>
                    <div className="text-[11px] font-bold tracking-wider text-slate-500 uppercase">
                      {it.label}
                    </div>
                    {it.description?.trim() && (
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {it.description.trim()}
                      </div>
                    )}
                  </div>
                );
              }
              if (it.kind === "choice") {
                const sel = choices[it.id];
                const opts = it.options ?? [];
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : sel
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200";
                return (
                  <div key={it.id} className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}>
                    <div className={`block text-sm font-bold text-slate-800 ${it.description ? "" : "mb-2"}`}>
                      {it.label}
                    </div>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-2 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      {opts.map((opt) => {
                        const picked = sel === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              setChoices((prev) => ({ ...prev, [it.id]: opt }));
                              if (hasError) {
                                setErrorIds((prev) => {
                                  const next = { ...prev };
                                  delete next[it.id];
                                  return next;
                                });
                              }
                            }}
                            className={`flex-1 min-w-[100px] py-2.5 px-3 rounded-lg text-sm font-bold transition-all border-2 ${
                              picked
                                ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                                : "border-slate-200 text-slate-500 hover:border-slate-300"
                            }`}
                          >
                            {picked ? "● " : ""}{opt}
                          </button>
                        );
                      })}
                    </div>
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1.5">
                        {t("staff.persona.shift.open.choiceRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              if (it.kind === "text") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                return (
                  <div
                    key={it.id}
                    className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}
                  >
                    <label className={`block text-sm font-medium text-slate-700 ${it.description ? "" : "mb-1.5"}`}>
                      {it.label}
                    </label>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-1.5 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <input
                      type="text"
                      className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                      maxLength={500}
                      value={value}
                      placeholder={t("staff.persona.shift.open.textValuePlaceholder")}
                      onChange={(e) => {
                        setTextValues((prev) => ({
                          ...prev,
                          [it.id]: e.target.value
                        }));
                        if (e.target.value.trim() && hasError) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1">
                        {t("staff.persona.shift.open.textValueRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              if (it.kind === "amount") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                return (
                  <div
                    key={it.id}
                    className={`${indentCls} rounded-xl border-[1.5px] transition p-3 ${cls}`}
                  >
                    <label className={`block text-sm font-medium text-slate-700 ${it.description ? "" : "mb-1.5"}`}>
                      {it.label}
                    </label>
                    {it.description && (
                      <p className="text-[10px] text-slate-500 mb-1.5 mt-0.5 whitespace-pre-wrap">
                        {it.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0"
                        className={`input text-sm flex-1 font-mono ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                        placeholder="0.00"
                        value={value}
                        onChange={(e) => {
                          setTextValues((prev) => ({ ...prev, [it.id]: e.target.value }));
                          if (e.target.value.trim() && hasError) {
                            setErrorIds((prev) => {
                              const next = { ...prev };
                              delete next[it.id];
                              return next;
                            });
                          }
                        }}
                        onBlur={() => {
                          const trimmed = value.trim();
                          if (!trimmed) return;
                          const n = Number(trimmed.replace(/,/g, ""));
                          if (Number.isFinite(n) && n >= 0) {
                            setTextValues((prev) => ({
                              ...prev,
                              [it.id]: n.toFixed(2)
                            }));
                          }
                        }}
                      />
                      <span className="text-sm font-bold text-slate-600 select-none">฿</span>
                    </div>
                    {hasError && (
                      <p className="text-[10px] text-rose-600 font-medium mt-1">
                        {t("staff.persona.shift.open.textValueRequired")}
                      </p>
                    )}
                  </div>
                );
              }
              const isChecked = !!checked[it.id];
              const note = notes[it.id] || "";
              const hasNote = note.trim().length > 0;
              const isOpen = !!openNotes[it.id];
              const containerCls = hasError
                ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                : isChecked
                  ? "border-emerald-300 bg-emerald-50"
                  : hasNote
                    ? "border-amber-300 bg-amber-50"
                    : "border-slate-200 hover:border-slate-300";
              return (
                <div
                  key={it.id}
                  className={`${indentCls} rounded-xl border-[1.5px] transition ${containerCls}`}
                >
                  <label className="flex items-center gap-3 p-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-5 h-5 flex-shrink-0"
                      checked={isChecked}
                      onChange={(e) => {
                        setChecked((prev) => ({
                          ...prev,
                          [it.id]: e.target.checked
                        }));
                        if (e.target.checked) {
                          setErrorIds((prev) => {
                            const next = { ...prev };
                            delete next[it.id];
                            return next;
                          });
                        }
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm">{it.label}</span>
                      {it.description && (
                        <p className="text-[10px] text-slate-500 mt-0.5 whitespace-pre-wrap">
                          {it.description}
                        </p>
                      )}
                    </div>
                    <span className={`text-xs font-bold ${
                      isChecked ? "text-emerald-700"
                        : hasNote ? "text-amber-700"
                        : "text-slate-400"
                    }`}>
                      {isChecked ? "✓" : hasNote ? "📝" : "✗"}
                    </span>
                  </label>

                  <div className="px-3 pb-2.5 -mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenNotes((prev) => ({
                        ...prev,
                        [it.id]: !prev[it.id]
                      }))}
                      className={`text-[11px] font-medium tracking-[0.5px] ${
                        hasNote ? "text-amber-700" : "text-slate-400 hover:text-brand"
                      }`}
                    >
                      {hasNote
                        ? `📝 ${t("staff.persona.shift.open.noteExists")}`
                        : `+ ${t("staff.persona.shift.open.addNote")}`}
                    </button>
                    {hasNote && !isOpen && (
                      <span className="text-[11px] text-amber-700/80 truncate flex-1">
                        — {note.trim()}
                      </span>
                    )}
                  </div>

                  {isOpen && (
                    <div className="px-3 pb-3">
                      <textarea
                        className={`input text-sm ${hasError ? "border-rose-400 focus:border-rose-500" : ""}`}
                        rows={2}
                        maxLength={500}
                        placeholder={t("staff.persona.shift.open.notePlaceholder")}
                        value={note}
                        onChange={(e) => {
                          setNotes((prev) => ({
                            ...prev,
                            [it.id]: e.target.value
                          }));
                          if (e.target.value.trim() && hasError) {
                            setErrorIds((prev) => {
                              const next = { ...prev };
                              delete next[it.id];
                              return next;
                            });
                          }
                        }}
                      />
                      <p className={`text-[10px] mt-1 ${
                        hasError ? "text-rose-600 font-medium" : "text-slate-400"
                      }`}>
                        {hasError
                          ? t("staff.persona.shift.open.requireNoteRowHint")
                          : t("staff.persona.shift.open.noteHint")}
                      </p>
                    </div>
                  )}
                </div>
              );
              });
            })()}
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
          : t("staff.persona.shift.close.submit")}
      </button>
    </form>
  );
}
