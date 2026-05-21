"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import Switch from "@/app/components/Switch";
import type { RosterPosition } from "@/lib/db";

export default function PositionsClient({ positions }: { positions: RosterPosition[] }) {
  const router = useRouter();
  const { t } = useLang();
  const [pending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function save(body: Record<string, unknown>, method: "POST" | "PATCH") {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/roster/position"), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error ?? t("common.error"));
        return false;
      }
      return true;
    } catch {
      setErr(t("common.error"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    if (!confirm(t("admin.persona.roster.positions.confirmDelete"))) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/roster/position?id=${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error ?? t("common.error")); return; }
      refresh();
    } finally {
      setBusy(false);
    }
  }

  // Toggle the position's active flag — drives whether it appears as
  // a row in the monthly roster grid. Flipping OFF doesn't delete
  // anything; flipping back ON restores the row.
  async function toggleActive(id: number, active: boolean) {
    setBusy(true); setErr(null);
    try {
      const ok = await save({ id, active }, "PATCH");
      if (ok) refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-bold text-slate-800 text-sm">
          {t("admin.persona.roster.positions.listTitle")} ({positions.length})
        </h2>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-xs px-3 py-1.5 rounded border border-brand text-brand hover:bg-rose-50 font-bold"
          >
            + {t("admin.persona.roster.positions.add")}
          </button>
        )}
      </div>

      {err && <div className="text-xs text-rose-600">✗ {err}</div>}

      <div className="space-y-2">
        {creating && (
          <PositionRow
            key="new"
            position={null}
            onCancel={() => setCreating(false)}
            onSave={async (body) => {
              if (await save(body, "POST")) {
                setCreating(false);
                refresh();
              }
            }}
            busy={busy}
            t={t}
          />
        )}
        {positions.map((p) => (
          <PositionRow
            key={p.id}
            position={p}
            editing={editingId === p.id}
            onStartEdit={() => setEditingId(p.id)}
            onCancel={() => setEditingId(null)}
            onDelete={() => remove(p.id)}
            onToggleActive={(active) => toggleActive(p.id, active)}
            onSave={async (body) => {
              if (await save({ id: p.id, ...body }, "PATCH")) {
                setEditingId(null);
                refresh();
              }
            }}
            busy={busy}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function PositionRow({
  position, editing, onStartEdit, onCancel, onDelete, onToggleActive, onSave, busy, t
}: {
  position: RosterPosition | null;
  editing?: boolean;
  onStartEdit?: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  onToggleActive?: (active: boolean) => void;
  onSave: (body: Record<string, unknown>) => void;
  busy: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  const isNew = position === null;
  const isEditing = isNew || editing;
  const [title, setTitle] = useState(position?.title ?? "");
  const [desc, setDesc] = useState(position?.description ?? "");
  const [order, setOrder] = useState<number>(position?.display_order ?? 99);

  if (!isEditing && position) {
    const active = position.active === 1;
    return (
      <div className={`border border-slate-200 rounded-lg p-3 flex items-start gap-3 transition ${
        active ? "" : "bg-slate-50/60 opacity-70"
      }`}>
        <div className="text-xs font-mono text-slate-400 w-6 text-right pt-0.5">
          {position.display_order}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-slate-800 text-sm">{position.title}</span>
            {!active && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 font-medium">
                {t("admin.persona.roster.positions.hiddenFromGrid")}
              </span>
            )}
          </div>
          {position.description && (
            <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-wrap">
              {position.description}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-3">
          {/* Show-in-schedule switch — flipping OFF hides the position
              from the monthly roster grid without deleting it. */}
          <label className="flex items-center gap-1.5 cursor-pointer"
            title={t("admin.persona.roster.positions.showOnGridHint")}>
            <Switch
              checked={active}
              accent="emerald"
              disabled={busy}
              onChange={(v) => onToggleActive?.(v)}
            />
            <span className="text-[10px] text-slate-500 select-none">
              {t("admin.persona.roster.positions.showOnGrid")}
            </span>
          </label>
          <button type="button" onClick={onStartEdit}
            className="text-xs text-brand hover:underline">
            {t("common.edit")}
          </button>
          <button type="button" onClick={onDelete}
            className="text-xs text-rose-500 hover:underline">
            {t("common.delete")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-[1.5px] border-brand/50 bg-rose-50/30 rounded-lg p-4 space-y-3">
      {/* Title — the primary field, given its own row + a label so
          it's obvious what you're typing. text-lg + py-2.5 makes the
          input chunky enough to read at a glance. */}
      <div>
        <label className="label">
          {t("admin.persona.roster.positions.titleLabel")}
        </label>
        <input
          className="input w-full text-lg font-bold py-2.5"
          placeholder={t("admin.persona.roster.positions.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={60}
          autoFocus
        />
      </div>

      {/* Description */}
      <div>
        <label className="label">
          {t("admin.persona.roster.positions.descLabel")}
        </label>
        <textarea className="input text-sm" rows={3}
          placeholder={t("admin.persona.roster.positions.descPlaceholder")}
          value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={1000} />
        <p className="text-[10px] text-slate-500 mt-1">
          {t("admin.persona.roster.positions.descHint")}
        </p>
      </div>

      {/* Display order — small inline field, less prominent. */}
      <div className="flex items-end gap-3 flex-wrap pt-1">
        <div>
          <label className="label">
            {t("admin.persona.roster.positions.orderLabel")}
          </label>
          <input type="number" className="input w-20 text-sm"
            value={order} onChange={(e) => setOrder(Number(e.target.value) || 0)} />
        </div>
        <div className="flex-1 flex gap-2 justify-end min-w-[160px]">
          <button type="button" disabled={busy} onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-slate-300 text-slate-600 text-sm">
            {t("common.cancel")}
          </button>
          <button type="button" disabled={busy || !title.trim()}
            onClick={() => onSave({ title, description: desc || null, display_order: order })}
            className="px-5 py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {busy ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
