"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { ShiftChecklistItem } from "@/lib/db";

// Editor for the global shift_open checklist items.
// Inline edit + reorder via up/down buttons + soft (active 0/1) and
// hard (DELETE) removals. Each row mutates immediately to the API so
// admin doesn't have to remember to "save".

export default function ChecklistEditor({
  initialItems
}: {
  initialItems: ShiftChecklistItem[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [items, setItems] = useState<ShiftChecklistItem[]>(initialItems);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [busyAdd, setBusyAdd] = useState(false);

  async function patchItem(id: number, patch: Partial<ShiftChecklistItem>) {
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
    const trimmed = newLabel.trim();
    if (!trimmed) return;
    setBusyAdd(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/checklist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shift_open", label: trimmed })
      });
      if (!res.ok) throw new Error("add failed");
      setNewLabel("");
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
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder={t("admin.persona.checklist.addPlaceholder")}
            maxLength={200}
          />
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
      </form>
    </div>
  );
}

function ChecklistRow({
  item, isFirst, isLast, busy,
  onPatchLabel, onToggleActive, onMoveUp, onMoveDown, onDelete, t
}: {
  item: ShiftChecklistItem;
  isFirst: boolean;
  isLast: boolean;
  busy: boolean;
  onPatchLabel: (label: string) => Promise<void>;
  onToggleActive: () => Promise<void>;
  onMoveUp: () => Promise<void>;
  onMoveDown: () => Promise<void>;
  onDelete: () => Promise<void>;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.label);

  async function save() {
    if (draft.trim() && draft !== item.label) {
      await onPatchLabel(draft.trim());
    }
    setEditing(false);
  }

  return (
    <div className={`flex items-center gap-2 p-2.5 rounded-lg border ${
      item.active ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50 opacity-70"
    }`}>
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
  );
}
