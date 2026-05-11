"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Shared "click off the items + add notes for skipped ones" UI used
// by readiness 11:30, readiness 16:00, and (effectively) shift_open
// + shift_close — although the latter two need extra cash fields and
// stay in their own form components.
//
// This thin runner handles the checklist portion only: state, the
// per-row "+ เพิ่มหมายเหตุ" toggle, and the validate-on-submit rule
// (every unchecked item must carry a non-empty note before the form
// can submit).
//
// Caller passes:
//   - `type` so the API knows which daily-report bucket to write to
//   - `branchId` for branch validation server-side
//   - `checklistItems` rendered from admin's per-branch list
//   - `extraSummary` (optional) — additional fields to render above
//     the checklist, e.g. nothing for readiness, or a money field
//     for shift_close. We keep this simple: callers wrap us if they
//     need extra fields. So this component is checklist-only.
//   - `successCopy` — title + body shown on the "submitted" screen.

type ChecklistItem = { id: number; label: string };
type ReportType = "readiness_1130" | "readiness_1600";

export default function ChecklistRunner({
  type, branchId, branchName, checklistItems, successCopy, submitLabel
}: {
  type: ReportType;
  branchId: number;
  branchName: string;
  checklistItems: ChecklistItem[];
  successCopy: { title: string; body: string };
  /** Submit button label — e.g. "ส่งรายงาน" for readiness reports,
   *  "ส่ง Check list" for shift-open / shift-close. Passed by the
   *  page so the same runner works for any report type. */
  submitLabel: string;
}) {
  const router = useRouter();
  const { t } = useLang();

  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, false]))
  );
  const [notes, setNotes] = useState<Record<number, string>>(() =>
    Object.fromEntries(checklistItems.map((it) => [it.id, ""]))
  );
  const [openNotes, setOpenNotes] = useState<Record<number, boolean>>({});
  const [errorIds, setErrorIds] = useState<Record<number, boolean>>({});

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  function toggleAll(value: boolean) {
    setChecked(Object.fromEntries(checklistItems.map((it) => [it.id, value])));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    // Same validation as ShiftOpenForm: every unticked row must have
    // a note. Open the note inputs for offending rows + show banner.
    const missingNoteIds = checklistItems
      .filter((it) => !checked[it.id] && !((notes[it.id] || "").trim()))
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
      const checklistPayload = checklistItems.map((it) => {
        const note = (notes[it.id] || "").trim();
        return {
          label: it.label,
          checked: !!checked[it.id],
          note: note ? note : null
        };
      });
      const res = await fetch(apiUrl("/api/persona/daily-report"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          branch_id: branchId,
          data: { checklist: checklistPayload }
        })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 409 && j.error === "already_submitted") {
        // Someone else just submitted between page load and submit —
        // refresh so the locked view picks up.
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
          {successCopy.title}
        </h2>
        <p className="text-sm text-slate-600">
          {successCopy.body}
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
      <div className="card">
        <div className="text-sm text-slate-600">
          <span className="text-xs text-slate-400 tracking-[0.5px] uppercase mr-2">
            {t("staff.persona.shift.open.field.branch")}
          </span>
          <span className="font-bold text-slate-800">{branchName}</span>
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
              const note = notes[it.id] || "";
              const hasNote = note.trim().length > 0;
              const isOpen = !!openNotes[it.id];
              const hasError = !!errorIds[it.id];
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
                  className={`rounded-xl border-[1.5px] transition ${containerCls}`}
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
                    <span className="text-sm flex-1">{it.label}</span>
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
        {busy ? t("staff.persona.shift.open.submitting") : submitLabel}
      </button>
    </form>
  );
}
