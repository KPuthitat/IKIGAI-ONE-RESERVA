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
  kind: "checkbox" | "text" | "choice" | "amount";
  /** Only meaningful for kind === 'choice'. ≥ 2 entries guaranteed by
   *  the admin API. */
  options?: string[];
  /** When set, this row is a child of another item. The form renders
   *  it indented under its parent. null = top-level row. */
  parent_id?: number | null;
  /** Marks the amount row to be featured at the top of the LINE Flex
   *  card. Multiple rows can carry this — they stack by display order
   *  on the card, with the first one rendered biggest. */
  is_headline?: boolean;
  /** Optional small-text help shown below the label. */
  description?: string | null;
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

  // Group items into parent → children for rendering. Submit order is
  // still flat (parents-then-children); the LINE Flex renderer reads
  // is_child to indent. Server query already orders by display_order.
  const topLevel = items.filter((it) => !it.parent_id);
  const childrenByParent = new Map<number, ReadinessChecklistItem[]>();
  for (const it of items) {
    if (it.parent_id) {
      if (!childrenByParent.has(it.parent_id)) childrenByParent.set(it.parent_id, []);
      childrenByParent.get(it.parent_id)!.push(it);
    }
  }

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
      // Build the checklist payload, flattening parents+children in
      // display order. Each child row carries is_child=true so the
      // downstream LINE Flex renderer indents it under its parent.
      const checklistPayload: Array<{
        label: string;
        kind: "checkbox" | "text" | "choice" | "amount";
        checked: boolean;
        note: string | null;
        is_child?: boolean;
        is_headline?: boolean;
        description?: string | null;
      }> = [];
      const buildEntry = (it: ReadinessChecklistItem, isChild: boolean) => {
        const headlineFlag = it.kind === "amount" && it.is_headline
          ? { is_headline: true }
          : {};
        const descriptionPart = it.description?.trim()
          ? { description: it.description.trim() }
          : {};
        if (it.kind === "text" || it.kind === "amount") {
          const value = (textValues[it.id] || "").trim();
          // For amount: normalise to 2 decimal places + comma grouping
          // so the LINE card renders a clean Thai-style number.
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
        return {
          label: it.label,
          kind: "checkbox" as const,
          checked: !!checked[it.id],
          note: null,
          ...(isChild ? { is_child: true } : {}),
          ...descriptionPart
        };
      };
      for (const parent of topLevel) {
        checklistPayload.push(buildEntry(parent, false));
        const kids = childrenByParent.get(parent.id) ?? [];
        for (const k of kids) checklistPayload.push(buildEntry(k, true));
      }

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
          {topLevel.map((parent) => {
            const kids = childrenByParent.get(parent.id) ?? [];
            return (
              <div key={parent.id} className="space-y-2">
                {renderReadinessItem(parent, false, {
                  checked, setChecked, textValues, setTextValues, choices, setChoices, t
                })}
                {kids.length > 0 && (
                  <div className="ml-4 pl-3 border-l-2 border-slate-200 space-y-2">
                    {kids.map((kid) => renderReadinessItem(kid, true, {
                      checked, setChecked, textValues, setTextValues, choices, setChoices, t
                    }))}
                  </div>
                )}
              </div>
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

/** Normalise a free-form baht amount string to "12,345.67" with
 *  thousand-separators and exactly 2 decimal places. Returns "" when
 *  the input doesn't parse to a valid non-negative number — caller
 *  decides whether to send empty / drop the field in that case. */
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

// Render one checklist item — extracted so the same code handles
// both top-level rows and indented children. `isChild` only affects
// font size + a slightly tighter padding so children read as visually
// subordinate; the input mechanics are identical.
function renderReadinessItem(
  it: ReadinessChecklistItem,
  isChild: boolean,
  ctx: {
    checked: Record<number, boolean>;
    setChecked: React.Dispatch<React.SetStateAction<Record<number, boolean>>>;
    textValues: Record<number, string>;
    setTextValues: React.Dispatch<React.SetStateAction<Record<number, string>>>;
    choices: Record<number, string | null>;
    setChoices: React.Dispatch<React.SetStateAction<Record<number, string | null>>>;
    t: (k: string, vars?: Record<string, string | number>) => string;
  }
) {
  const labelSize = isChild ? "text-xs" : "text-sm";
  const labelClass = `block ${labelSize} font-bold text-slate-800`;
  const pad = isChild ? "p-2" : "p-3";

  if (it.kind === "text") {
    const value = ctx.textValues[it.id] || "";
    const filled = value.trim().length > 0;
    return (
      <div
        key={it.id}
        className={`rounded-xl border-[1.5px] transition ${pad} ${
          filled
            ? "border-emerald-300 bg-emerald-50"
            : "border-slate-200 hover:border-slate-300"
        }`}
      >
        <label className={`${labelClass} ${it.description ? "" : "mb-1.5"}`}>{it.label}</label>
        {it.description && (
          <p className="text-[10px] text-slate-500 mb-1.5 mt-0.5 whitespace-pre-wrap">
            {it.description}
          </p>
        )}
        <textarea
          className="input text-sm"
          rows={isChild ? 2 : 3}
          maxLength={2000}
          value={value}
          placeholder={ctx.t("staff.persona.readiness.textValuePlaceholder")}
          onChange={(e) =>
            ctx.setTextValues((prev) => ({ ...prev, [it.id]: e.target.value }))
          }
        />
      </div>
    );
  }
  if (it.kind === "amount") {
    const value = ctx.textValues[it.id] || "";
    const filled = value.trim().length > 0;
    return (
      <div
        key={it.id}
        className={`rounded-xl border-[1.5px] transition ${pad} ${
          filled
            ? "border-emerald-300 bg-emerald-50"
            : "border-slate-200 hover:border-slate-300"
        }`}
      >
        <label className={`${labelClass} ${it.description ? "" : "mb-1.5"}`}>{it.label}</label>
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
            className="input text-sm flex-1 font-mono"
            placeholder="0.00"
            value={value}
            onChange={(e) =>
              ctx.setTextValues((prev) => ({ ...prev, [it.id]: e.target.value }))
            }
            onBlur={() => {
              // Snap to 2 decimal places on blur — sticky if the staff
              // typed e.g. "1234" we save "1234.00" so the LINE card
              // and downstream rendering have a normalised value.
              const trimmed = value.trim();
              if (!trimmed) return;
              const n = Number(trimmed.replace(/,/g, ""));
              if (Number.isFinite(n) && n >= 0) {
                ctx.setTextValues((prev) => ({
                  ...prev,
                  [it.id]: n.toFixed(2)
                }));
              }
            }}
          />
          <span className="text-sm font-bold text-slate-600 select-none">฿</span>
        </div>
      </div>
    );
  }
  if (it.kind === "choice") {
    const sel = ctx.choices[it.id];
    const opts = it.options ?? [];
    return (
      <div
        key={it.id}
        className={`rounded-xl border-[1.5px] transition ${pad} ${
          sel ? "border-emerald-300 bg-emerald-50" : "border-slate-200"
        }`}
      >
        <div className={`${labelClass} ${it.description ? "" : "mb-2"}`}>{it.label}</div>
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
                onClick={() =>
                  ctx.setChoices((prev) => ({ ...prev, [it.id]: opt }))
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
  const isChecked = !!ctx.checked[it.id];
  return (
    <label
      key={it.id}
      className={`flex items-start gap-3 ${pad} rounded-xl border-[1.5px] transition cursor-pointer ${
        isChecked
          ? "border-emerald-300 bg-emerald-50"
          : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <input
        type="checkbox"
        className="w-5 h-5 flex-shrink-0 mt-0.5"
        checked={isChecked}
        onChange={(e) =>
          ctx.setChecked((prev) => ({ ...prev, [it.id]: e.target.checked }))
        }
      />
      <div className="flex-1 min-w-0">
        <div className={`${labelSize} font-bold text-slate-800`}>
          {it.label}
        </div>
        {it.description && (
          <p className="text-[10px] text-slate-500 mt-0.5 whitespace-pre-wrap">
            {it.description}
          </p>
        )}
      </div>
      <span
        className={`text-xs font-bold mt-0.5 ${
          isChecked ? "text-emerald-700" : "text-slate-400"
        }`}
      >
        {isChecked ? "✓" : "—"}
      </span>
    </label>
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
