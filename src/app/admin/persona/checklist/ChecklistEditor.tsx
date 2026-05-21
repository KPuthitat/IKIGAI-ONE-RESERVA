"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { ShiftChecklistItem } from "@/lib/db";
import { parseChecklistOptions } from "@/lib/db";

// Editor for a per-branch checklist. The same UI handles all 4
// daily-report types: shift_open, shift_close, readiness_1130,
// readiness_1600. The page passes the active `type` so new items
// land in the correct list.
//
// Inline edit + reorder via up/down buttons + soft (active 0/1) and
// hard (DELETE) removals. Each row mutates immediately to the API so
// admin doesn't have to remember to "save".

type ChecklistType = "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600";

export default function ChecklistEditor({
  initialItems, branchId, type
}: {
  initialItems: ShiftChecklistItem[];
  /** Branch the editor is currently scoped to. Sent on POST so new
   *  items are created inside this branch's list. PATCH/DELETE don't
   *  need it because the API guards by item id → item.branch_id. */
  branchId: number;
  /** Which checklist type this editor is editing — sent on POST so
   *  new items land in the right list. */
  type: ChecklistType;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [items, setItems] = useState<ShiftChecklistItem[]>(initialItems);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<"checkbox" | "text" | "choice">("checkbox");
  // Buffered options for the "add new item" form. Only meaningful when
  // newKind === 'choice'. Min 2 entries enforced by the API and the
  // disabled-when-< 2 state on the Submit button.
  const [newOptions, setNewOptions] = useState<string[]>(["", ""]);
  const [busyAdd, setBusyAdd] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  async function patchItem(
    id: number,
    patch: Partial<ShiftChecklistItem> & { options?: string[] }
  ) {
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/checklist/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      });
      if (!res.ok) throw new Error("patch failed");
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function deleteItem(id: number) {
    if (!confirm(t("admin.persona.checklist.confirmDelete"))) return;
    setBusyId(id);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/checklist/${id}`), {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("delete failed");
      setItems((prev) => prev.filter((it) => it.id !== id));
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setAddErr(null);
    const trimmed = newLabel.trim();
    if (!trimmed) return;

    // Choice items need ≥ 2 non-empty option strings. Filter blanks
    // before sending so admin can leave trailing empties without
    // tripping the API's min-length check.
    let payloadOptions: string[] | undefined;
    if (newKind === "choice") {
      payloadOptions = newOptions.map((o) => o.trim()).filter((o) => o.length > 0);
      if (payloadOptions.length < 2) {
        setAddErr(t("admin.persona.checklist.kind.choiceMinOptions"));
        return;
      }
    }

    setBusyAdd(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/checklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          label: trimmed,
          branch_id: branchId,
          kind: newKind,
          ...(payloadOptions ? { options: payloadOptions } : {})
        })
      });
      if (!res.ok) throw new Error("add failed");
      setNewLabel("");
      setNewKind("checkbox");
      setNewOptions(["", ""]);
      router.refresh();
    } finally {
      setBusyAdd(false);
    }
  }

  async function move(id: number, direction: -1 | 1) {
    // Swap display_order with the neighbor in the given direction.
    const idx = items.findIndex((it) => it.id === id);
    if (idx < 0) return;
    const target = idx + direction;
    if (target < 0 || target >= items.length) return;
    const a = items[idx];
    const b = items[target];
    setBusyId(id);
    try {
      await Promise.all([
        fetch(apiUrl(`/api/admin/persona/checklist/${a.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_order: b.display_order })
        }),
        fetch(apiUrl(`/api/admin/persona/checklist/${b.id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_order: a.display_order })
        })
      ]);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.checklist.listTitle")}
        </h2>
        {items.length === 0 ? (
          <div className="text-sm text-slate-500 text-center py-6">
            {t("admin.persona.checklist.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((it, i) => (
              <ChecklistRow
                key={it.id}
                item={it}
                isFirst={i === 0}
                isLast={i === items.length - 1}
                busy={busyId === it.id}
                onPatchLabel={(label) => patchItem(it.id, { label })}
                onPatchKind={(kind) => {
                  // When admin switches kind TO 'choice', seed two
                  // blank options so they immediately see the editor
                  // rather than a confused empty pill row.
                  if (kind === "choice") {
                    return patchItem(it.id, { kind, options: ["", ""] });
                  }
                  return patchItem(it.id, { kind });
                }}
                onPatchOptions={(opts) => patchItem(it.id, { options: opts })}
                onToggleActive={() =>
                  patchItem(it.id, { active: it.active ? 0 : 1 })}
                onMoveUp={() => move(it.id, -1)}
                onMoveDown={() => move(it.id, 1)}
                onDelete={() => deleteItem(it.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </div>

      <form onSubmit={addItem} className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.checklist.addTitle")}
        </h2>
        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            className="input flex-1 min-w-[180px]"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("admin.persona.checklist.addPlaceholder")}
            maxLength={200}
          />
          <select
            className="input text-sm"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as "checkbox" | "text" | "choice")}
          >
            <option value="checkbox">{t("admin.persona.checklist.kind.checkbox")}</option>
            <option value="text">{t("admin.persona.checklist.kind.text")}</option>
            <option value="choice">{t("admin.persona.checklist.kind.choice")}</option>
          </select>
          <button
            type="submit"
            disabled={busyAdd || !newLabel.trim()}
            className="btn-primary text-sm whitespace-nowrap"
          >
            {busyAdd
              ? t("common.submitting")
              : t("admin.persona.checklist.addBtn")}
          </button>
        </div>
        <p className="text-[11px] text-slate-500">
          {t("admin.persona.checklist.kind.hint")}
        </p>
        {newKind === "choice" && (
          <OptionsEditor
            options={newOptions}
            onChange={setNewOptions}
            label={t("admin.persona.checklist.kind.optionsLabel")}
            t={t}
          />
        )}
        {addErr && <div className="text-xs text-rose-600">✗ {addErr}</div>}
      </form>
    </div>
  );
}

function ChecklistRow({
  item, isFirst, isLast, busy,
  onPatchLabel, onPatchKind, onPatchOptions,
  onToggleActive, onMoveUp, onMoveDown, onDelete, t
}: {
  item: ShiftChecklistItem;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onPatchLabel: (label: string) => Promise<void>;
  onPatchKind: (kind: "checkbox" | "text" | "choice") => Promise<void>;
  onPatchOptions: (options: string[]) => Promise<void>;
  onToggleActive: () => Promise<void>;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onDelete: () => Promise<void>;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.label);
  // Local copy of the options array so the editor reflects keystrokes
  // immediately; we PATCH on blur of each input.
  const initialOptions = parseChecklistOptions(item);
  const [optionsDraft, setOptionsDraft] = useState<string[]>(
    initialOptions.length > 0 ? initialOptions : ["", ""]
  );

  async function save() {
    if (draft.trim() && draft !== item.label) {
      await onPatchLabel(draft.trim());
    }
    setEditing(false);
  }

  async function commitOptions(next: string[]) {
    setOptionsDraft(next);
    const cleaned = next.map((o) => o.trim()).filter((o) => o.length > 0);
    if (cleaned.length >= 2) {
      await onPatchOptions(cleaned);
    }
  }

  return (
    <div className={`p-2.5 rounded-lg border ${
      item.active ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
    }`}>
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={busy || isFirst}
            className="text-xs px-2 py-0.5 text-slate-500 hover:text-brand disabled:opacity-30"
            aria-label="Move up"
          >▲</button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={busy || isLast}
            className="text-xs px-2 py-0.5 text-slate-500 hover:text-brand disabled:opacity-30"
            aria-label="Move down"
          >▼</button>
        </div>

        {editing ? (
          <input
            className="input flex-1 text-sm"
            value={draft}
            autoFocus
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); save(); }
              if (e.key === "Escape") { setDraft(item.label); setEditing(false); }
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 text-left text-sm text-slate-800 hover:text-brand truncate"
          >
            {item.label}
            {!item.active && (
              <span className="ml-2 text-[10px] text-slate-400 font-medium">
                · {t("admin.persona.checklist.inactive")}
              </span>
            )}
          </button>
        )}

        <select
          value={item.kind ?? "checkbox"}
          disabled={busy}
          onChange={(e) => onPatchKind(e.target.value as "checkbox" | "text" | "choice")}
          className="text-xs border border-slate-300 rounded px-1.5 py-1 text-slate-700 bg-white"
          title={t("admin.persona.checklist.kind.hint")}
        >
          <option value="checkbox">{t("admin.persona.checklist.kind.checkbox")}</option>
          <option value="text">{t("admin.persona.checklist.kind.text")}</option>
          <option value="choice">{t("admin.persona.checklist.kind.choice")}</option>
        </select>
        <button
          type="button"
          onClick={onToggleActive}
          disabled={busy}
          className={`text-xs px-2 py-1 rounded border ${
            item.active
              ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              : "border-slate-300 text-slate-500 hover:bg-slate-50"
          }`}
        >
          {item.active
            ? t("admin.persona.checklist.activeChip")
            : t("admin.persona.checklist.inactiveChip")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-xs px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50"
          aria-label={t("common.delete")}
        >×</button>
      </div>

      {/* Options editor — only visible for choice rows. Sits below the
          main row so it doesn't crowd the kind / activate / delete
          controls. PATCH happens once admin moves focus away from each
          input, so quick label-then-options edits don't fire N writes. */}
      {item.kind === "choice" && (
        <div className="mt-2 pl-7">
          <OptionsEditor
            options={optionsDraft}
            onChange={commitOptions}
            label={t("admin.persona.checklist.kind.optionsLabel")}
            t={t}
          />
        </div>
      )}
    </div>
  );
}

// Reusable editable list of choice options. Each row is one option
// string; admin types into it, can remove with the × button, and adds
// new blanks via "+". Always renders at least 2 rows so the visual cue
// "choice needs at least two options" is present even before admin
// types anything.
function OptionsEditor({
  options, onChange, label, t
}: {
  options: string[];
  onChange: (next: string[]) => void;
  label: string;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  function setAt(idx: number, value: string) {
    onChange(options.map((o, i) => i === idx ? value : o));
  }
  function removeAt(idx: number) {
    // Keep a minimum of 2 rows visible — clear instead of removing
    // the second-to-last slot.
    if (options.length <= 2) {
      onChange(options.map((o, i) => i === idx ? "" : o));
    } else {
      onChange(options.filter((_, i) => i !== idx));
    }
  }
  function add() {
    onChange([...options, ""]);
  }
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
      <div className="space-y-1">
        {options.map((opt, idx) => (
          <div key={idx} className="flex gap-1.5 items-center">
            <input
              type="text"
              className="input text-sm flex-1"
              value={opt}
              placeholder={t("admin.persona.checklist.kind.optionPlaceholder", { n: idx + 1 })}
              maxLength={100}
              onChange={(e) => setAt(idx, e.target.value)}
            />
            <button
              type="button"
              onClick={() => removeAt(idx)}
              className="text-xs text-rose-600 hover:text-rose-700 px-2 py-1"
              aria-label="Remove option"
            >×</button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={add}
        className="text-[11px] text-brand hover:underline mt-0.5"
      >
        + {t("admin.persona.checklist.kind.addOption")}
      </button>
    </div>
  );
}
