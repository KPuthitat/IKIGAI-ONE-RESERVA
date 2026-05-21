"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Readiness report form — used by /staff/persona/shift/readiness-1130
// and /staff/persona/shift/readiness-1600. ALL form content is driven
// by what admin has configured at /admin/persona/checklist?type=
// readiness_1130|readiness_1600. Each item is one of three kinds:
//
//   • checkbox — yes/no tick ("✓ พร้อม")
//   • text     — free-form text input (admin's prompt → staff types)
//   • choice   — radio with admin-defined options (e.g. "ขายได้ปกติ"
//                / "ห้ามขาย" for the alcohol prompt)
//
// The 4 legacy fields (team comms / 2× menus / alcohol radio) were
// removed in 2026-05-21 — the migration seeds equivalent admin items
// per branch so existing branches see the same form they always have,
// but admin can now edit/reorder/add/delete freely. Branches with zero
// admin items render a placeholder telling staff to ask admin to set
// up the checklist.
//
// Reporter + date + branch are read-only display chips at the top —
// auto-filled from session/server so staff don't retype each time.

type ReportType = "readiness_1130" | "readiness_1600";

export type ReadinessChecklistItem = {
  id: number;
  label: string;
  kind: "checkbox" | "text" | "choice";
  /** Only meaningful for kind === 'choice'. ≥ 2 entries guaranteed by
   *  the admin API. */
  options?: string[];
};

export default function ReadinessForm({
  type,
  branchId,
  branchName,
  reporterName,
  todayDate,
  submitLabel,
  successCopy,
  checklistItems
}: {
  type: ReportType;
  branchId: number;
  branchName: string;
  reporterName: string;
  /** YYYY-MM-DD — already in Bangkok local date from the server. */
  todayDate: string;
  submitLabel: string;
  successCopy: { title: string; body: string };
  /** Admin-configured items. Empty array = admin hasn't set anything
   *  up; the form renders a placeholder pointing them at the setup
   *  page instead of silently submitting an empty report. */
  checklistItems: ReadinessChecklistItem[];
}) {
  const router = useRouter();
  const { t } = useLang();

  const items = checklistItems;

  // One state map per kind. checkbox → tick state; text → typed
  // string; choice → selected option string (null until staff picks).
  const [checked, setChecked] = useState<Record<number, boolean>>(() =>
    Object.fromEntries(items.map((it) => [it.id, false]))
  );
  const [textValues, setTextValues] = useState<Record<number, string>>(() =>
    Object.fromEntries(items.map((it) => [it.id, ""]))
  );
  const [choices, setChoices] = useState<Record<number, string | null>>(() =>
    Object.fromEntries(items.map((it) => [it.id, null]))
  );

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      // Build the checklist payload — text/choice items mirror their
      // value into `note` so the LINE Flex card shows it; checkbox
      // items just carry tick state. Backend stores the array as-is
      // and the Flex renderer treats `note` uniformly across kinds.
      const checklistPayload = items.map((it) => {
        if (it.kind === "text") {
          const value = (textValues[it.id] || "").trim();
          return {
            label: it.label,
            kind: "text" as const,
            checked: !!value,
            note: value || null
          };
        }
        if (it.kind === "choice") {
          const sel = choices[it.id];
          return {
            label: it.label,
            kind: "choice" as const,
            checked: !!sel,
            note: sel ?? null
          };
        }
        return {
          label: it.label,
          kind: "checkbox" as const,
          checked: !!checked[it.id],
          note: null
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
        // Race: someone else submitted between page load + send.
        // Refresh so the locked view picks up.
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
        <h2 className="text-xl font-bold text-slate-800">{successCopy.title}</h2>
        <p className="text-sm text-slate-600">{successCopy.body}</p>
        <button
          type="button"
          onClick={() => router.push("/staff/persona")}
          className="btn-secondary w-full"
        >
          {t("common.back")}
        </button>
      </div>
    );
  }

  // Empty-checklist guard. If admin hasn't configured anything for
  // this branch + type, don't show staff a blank form — they'd submit
  // nothing useful and admin wouldn't get a notification worth reading.
  if (items.length === 0) {
    return (
      <div className="card text-center space-y-3 py-8">
        <div className="text-4xl">⚙</div>
        <h2 className="font-bold text-slate-800">
          {t("staff.persona.readiness.emptyTitle")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.readiness.emptyBody")}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Auto-filled context — date / reporter / branch. */}
      <div className="card">
        <div className="grid sm:grid-cols-2 gap-3">
          <ReadOnlyField
            label={t("staff.persona.readiness.field.date")}
            value={todayDate}
          />
          <ReadOnlyField
            label={t("staff.persona.readiness.field.reporter")}
            value={reporterName}
          />
          <ReadOnlyField
            label={t("staff.persona.readiness.field.branch")}
            value={branchName}
          />
        </div>
      </div>

      <div className="card space-y-3">
        <div className="space-y-3">
          {items.map((it) => {
            if (it.kind === "text") {
              const value = textValues[it.id] || "";
              const filled = value.trim().length > 0;
              return (
                <div
                  key={it.id}
                  className={`rounded-xl border-[1.5px] transition p-3 ${
                    filled
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <label className="block text-sm font-bold text-slate-800 mb-1.5">
                    {it.label}
                  </label>
                  <textarea
                    className="input text-sm"
                    rows={3}
                    maxLength={2000}
                    value={value}
                    placeholder={t("staff.persona.readiness.textValuePlaceholder")}
                    onChange={(e) =>
                      setTextValues((prev) => ({
                        ...prev,
                        [it.id]: e.target.value
                      }))
                    }
                  />
                </div>
              );
            }
            if (it.kind === "choice") {
              const sel = choices[it.id];
              const opts = it.options ?? [];
              return (
                <div
                  key={it.id}
                  className={`rounded-xl border-[1.5px] transition p-3 ${
                    sel
                      ? "border-emerald-300 bg-emerald-50"
                      : "border-slate-200"
                  }`}
                >
                  <div className="block text-sm font-bold text-slate-800 mb-2">
                    {it.label}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {opts.map((opt) => {
                      const picked = sel === opt;
                      return (
                        <button
                          key={opt}
                          type="button"
                          onClick={() =>
                            setChoices((prev) => ({ ...prev, [it.id]: opt }))
                          }
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
                </div>
              );
            }
            const isChecked = !!checked[it.id];
            return (
              <label
                key={it.id}
                className={`flex items-center gap-3 p-3 rounded-xl border-[1.5px] transition cursor-pointer ${
                  isChecked
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <input
                  type="checkbox"
                  className="w-5 h-5 flex-shrink-0"
                  checked={isChecked}
                  onChange={(e) =>
                    setChecked((prev) => ({
                      ...prev,
                      [it.id]: e.target.checked
                    }))
                  }
                />
                <span className="text-sm flex-1 font-bold text-slate-800">{it.label}</span>
                <span
                  className={`text-xs font-bold ${
                    isChecked ? "text-emerald-700" : "text-slate-400"
                  }`}
                >
                  {isChecked ? "✓" : "—"}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {msg && (
        <div
          className={`text-sm text-center ${
            msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
          }`}
        >
          {msg.kind === "ok" ? "✓ " : "✗ "}
          {msg.text}
        </div>
      )}

      <button
        type="submit"
        disabled={busy}
        className="btn-primary w-full text-base py-3.5"
      >
        {busy ? t("staff.persona.shift.open.submitting") : submitLabel}
      </button>
    </form>
  );
}

// Read-only field with label-above-input layout — matches the
// shift-open form's visual pattern so staff has one consistent
// layout for "auto-filled context" across all 4 daily reports.
function ReadOnlyField({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="text"
        className="input bg-slate-50 text-slate-600 cursor-not-allowed"
        value={value}
        disabled
        readOnly
      />
    </div>
  );
}
