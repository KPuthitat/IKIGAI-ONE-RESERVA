"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// The branch is pinned to whichever branch the staff selected at
// /staff/branch-picker (session activeBranchId). To swap branches
// mid-day, staff uses the topbar "เปลี่ยน" link — this form just
// trusts the server-supplied branch and submits to it.
//
// Each checklist row has THREE effective states:
//   - checked (✓)              → done
//   - unchecked + note         → skipped on purpose, with reason
//   - unchecked + no note      → not done (red flag for admin)
// The submit payload carries `{label, checked, note}` per row, and
// the LINE Flex card renders all three states distinctly so admin
// can read why something was skipped without chasing the staff.

type ChecklistItem = {
  id: number;
  label: string;
  kind: "checkbox" | "text" | "choice" | "amount" | "section";
  /** Only meaningful when kind === 'choice'. ≥ 2 entries guaranteed
   *  by the admin API. */
  options?: string[];
  /** When set, this row is a child of another item. The form renders
   *  it indented under its parent. null = top-level row. */
  parent_id?: number | null;
  /** Marks the amount row to be featured at the top of the LINE Flex
   *  card. Multiple rows can carry this. */
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

export default function ShiftOpenForm({
  branchId, branchName, openerName, today, yesterdayClosingHint, checklistItems,
  requireYesterdayClosing = true,
  requireMorningOpening = true,
  previousData = null
}: {
  branchId: number;
  branchName: string;
  openerName: string;
  today: string;
  yesterdayClosingHint: number | null;
  checklistItems: ChecklistItem[];
  /** Per-branch toggles for the mandatory financial fields at the
   *  top of the form. Both default ON; admin can flip per branch
   *  via /admin/persona/settings if the branch doesn't need a
   *  given amount (e.g. cashless-only branch). */
  requireYesterdayClosing?: boolean;
  requireMorningOpening?: boolean;
  /** Most recent superseded report's parsed `data` JSON, if any.
   *  Passed in when admin previously granted an unlock so the form
   *  re-renders pre-filled with what the staff typed before. */
  previousData?: Record<string, unknown> | null;
}) {
  const router = useRouter();
  const { t } = useLang();

  // Pre-fill seed — see ShiftCloseForm for the same pattern. Build a
  // label-indexed lookup once at mount so the four useState lazy
  // initializers can each pull from it without re-iterating.
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

  // Date is derived server-side (always today). Opener is the logged-in
  // user. Both are read-only on the form so staff can't backdate or
  // file on someone else's behalf — server enforces too as defense.
  // yesterdayAmount prefills from previousData first, then the daily
  // hint (which reads yesterday's closing), then empty.
  const [yesterdayAmount, setYesterdayAmount] = useState<string>(() => {
    const v = previousData?.yesterday_closing_amount;
    if (typeof v === "number") return String(v);
    return yesterdayClosingHint != null ? String(yesterdayClosingHint) : "";
  });
  const [morningAmount, setMorningAmount] = useState<string>(() => {
    const v = previousData?.morning_drawer_amount;
    return typeof v === "number" ? String(v) : "";
  });
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? prev.checked
        : false;
      return [it.id, restored];
    }))
  );
  // For text-input items, the entered value lives in `textValues`. We
  // mirror it into the same payload shape as a checkbox+note row by
  // treating non-empty text as `checked=true` and shoving the value
  // into the note field, so the existing LINE Flex renderer renders
  // text answers without any code change downstream.
  const [textValues, setTextValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      let restored = "";
      if (prev && (it.kind === "text" || it.kind === "amount")) {
        restored = prev.note ?? "";
        // See ShiftCloseForm prefill-bug-fix note: amount items are
        // saved with comma grouping but <input type="number"> can't
        // display them. Strip on the way back into the input.
        if (it.kind === "amount") {
          restored = restored.replace(/,/g, "");
        }
      }
      return [it.id, restored];
    }))
  );
  // For choice items, the picked option (or null until staff picks).
  const [choices, setChoices] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      const restored = prev && it.kind === "choice"
        ? (prev.note ?? null)
        : null;
      return [it.id, restored];
    }))
  );
  // Per-item note text. An empty string is the same as "no note" — only
  // non-empty strings turn the row into the "skipped-with-note" state.
  const [notes, setNotes] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => {
      const prev = prevByLabel.get(it.label);
      const restored = prev && (it.kind === "checkbox" || !it.kind)
        ? (prev.note ?? "")
        : "";
      return [it.id, restored];
    }))
  );
  // Which item ids have their note textarea expanded right now. Toggled
  // by clicking the small "หมายเหตุ" button on the row, or auto-opened
  // when submit catches an unticked-without-note item.
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  // Which item ids failed the "must-have-note-when-unchecked" rule on
  // the last submit attempt. Their note inputs render with a red ring
  // and the row gets a red error border.
  const [errorIds, setErrorIds] = useState<Record<number, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function toggleAll(value: boolean) {
    // "Mark all done" only applies to checkbox items — text inputs
    // and choice radios need their value picked by hand.
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
    // Validate. For text items: the typed value cannot be empty (treat
    // it as a required field; admins typically use text rows for things
    // like cash counts where blank is wrong). For choice items: an
    // option must be picked. For checkbox items: same rule as before —
    // either ticked, or carrying a note explaining the skip.
    const missingNoteIds = checklistItems
      .filter((it) => {
        // 'section' rows are non-interactive headers — staff has no
        // input to fill, so they never count as missing.
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
    setErrorIds({});
    setBusy(true);
    try {
      const yesterdayParsed = parseAmount(yesterdayAmount);
      const morningParsed = parseAmount(morningAmount);
      // Flatten parents-then-children so the LINE Flex renders the
      // hierarchy in order. is_child=true on child rows tells the
      // renderer to indent them under their parent.
      const buildEntry = (it: ChecklistItem, isChild: boolean) => {
        const headlineFlag = it.kind === "amount" && it.is_headline
          ? { is_headline: true }
          : {};
        const descriptionPart = it.description?.trim()
          ? { description: it.description.trim() }
          : {};
        // 'section' header — no value to gather, but we still ship it
        // in the payload so the LINE Flex renders the group title in
        // the same place it appears in the staff form.
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
          // Send null instead of empty string so the API/Flex layer
          // doesn't have to treat "" specially.
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
          type: "shift_open",
          branch_id: branchId,
          data: {
            yesterday_closing_amount: yesterdayParsed,
            morning_drawer_amount: morningParsed,
            checklist: checklistPayload
          }
        })
      });
      const j = await res.json().catch(() => ({}));
      // Server returns 409 when someone else just submitted the same
      // report between page load and submit. Refresh so the locked
      // view picks up. (The error code was renamed `already_opened` →
      // `already_submitted` when the endpoint generalized to all 4
      // daily-report types.)
      if (res.status === 409 && j.error === "already_submitted") {
        router.refresh();
        return;
      }
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
    const allChecked = checklistItems.every((it) => {
      if (it.kind === "text" || it.kind === "amount") {
        return (textValues[it.id] || "").trim().length > 0;
      }
      if (it.kind === "choice") return !!choices[it.id];
      return checked[it.id];
    });
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
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={today} readOnly />
          </div>
          <div>
            <label className="label">{t("staff.persona.shift.open.field.opener")}</label>
            <input type="text" className="input bg-slate-50 text-slate-500"
              value={openerName} readOnly />
          </div>
        </div>

        {/* Yesterday-closing / morning-opening — required-by-default
            per-branch toggles (2026-05-25). Admin can flip off when
            irrelevant (e.g. cashless-only branch). */}
        {requireYesterdayClosing && (
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
        )}

        {requireMorningOpening && (
          <div>
            <label className="label">{t("staff.persona.shift.open.field.morningDrawer")} *</label>
            <input type="number" inputMode="decimal" min={0} step="0.01"
              required
              className="input"
              value={morningAmount}
              placeholder="0.00"
              onChange={(e) => setMorningAmount(e.target.value)} />
          </div>
        )}
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
            {/* Order checklist items so each parent is immediately
                followed by its children, regardless of how display_order
                interleaves across groups. Children are visually
                indented via an extra ml-4 class on the wrapper. */}
            {(() => {
              const ordered: Array<{ item: ChecklistItem; isChild: boolean }> = [];
              const parents = checklistItems.filter((it) => !it.parent_id);
              for (const p of parents) {
                ordered.push({ item: p, isChild: false });
                for (const c of checklistItems.filter((c) => c.parent_id === p.id)) {
                  ordered.push({ item: c, isChild: true });
                }
              }
              return ordered.map(({ item: it, isChild }) => {
              const hasError = !!errorIds[it.id];
              // Each branch builds an inner JSX element; we wrap once
              // at the end with the indent classes when isChild is set.
              // That keeps the per-kind classNames simple.
              let inner: React.ReactNode = null;
              if (it.kind === "section") {
                // Non-interactive group header. No box / no border /
                // no controls — just a small caps title that breaks
                // the list into sections.
                inner = (
                  <div className="pt-3 pb-1">
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
              } else if (it.kind === "choice") {
                const sel = choices[it.id];
                const opts = it.options ?? [];
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : sel
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200";
                inner = (
                  <div className={`rounded-xl border-[1.5px] transition p-3 ${cls}`}>
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
              } else if (it.kind === "text") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                inner = (
                  <div className={`rounded-xl border-[1.5px] transition p-3 ${cls}`}>
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
              } else if (it.kind === "amount") {
                const value = textValues[it.id] || "";
                const filled = value.trim().length > 0;
                const cls = hasError
                  ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                  : filled
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300";
                inner = (
                  <div className={`rounded-xl border-[1.5px] transition p-3 ${cls}`}>
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
              } else {
              const isChecked = !!checked[it.id];
              const note = notes[it.id] || "";
              const hasNote = note.trim().length > 0;
              const isOpen = !!openNotes[it.id];
              // Visual state: red when error (unchecked + no note flagged
              // by submit validation), emerald when done, amber when
              // skipped-with-note, slate by default. The note state visually
              // overrides "undone" so staff can see at a glance which rows
              // have an explanation.
              const containerCls = hasError
                ? "border-rose-400 bg-rose-50 ring-2 ring-rose-200"
                : isChecked
                  ? "border-emerald-300 bg-emerald-50"
                  : hasNote
                    ? "border-amber-300 bg-amber-50"
                    : "border-slate-200 hover:border-slate-300";
              inner = (
                <div className={`rounded-xl border-[1.5px] transition ${containerCls}`}>
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
                        // Tick clears the "missing note" error since
                        // a checked item doesn't need one.
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
                      {isChecked ? "✓" : hasNote ? "" : "✗"}
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
                        ? `${t("staff.persona.shift.open.noteExists")}`
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
                          // Typing into a previously-flagged note clears
                          // the row's error state right away.
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
              }
              return (
                <div
                  key={it.id}
                  className={isChild ? "ml-4 pl-3 border-l-2 border-slate-200" : ""}
                >
                  {inner}
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
          : t("staff.persona.shift.open.submit")}
      </button>
    </form>
  );
}
