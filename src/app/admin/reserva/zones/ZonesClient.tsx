"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import Switch from "@/app/components/Switch";
import { useConfirm } from "@/app/components/useConfirm";

type ZoneRow = {
  id: number;
  branch_id: number;
  name: string;
  description: string | null;
  display_order: number;
  active: number;
  table_count: number;
};

export default function ZonesClient({
  lang, zones, unassignedCount
}: {
  lang: Lang;
  zones: ZoneRow[];
  unassignedCount: number;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<ZoneRow | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function deleteZone(zone: ZoneRow): Promise<void> {
    const body = zone.table_count > 0
      ? t(lang, "admin.reserva.zones.confirmDeleteWithTables", { count: String(zone.table_count) })
      : t(lang, "admin.reserva.zones.confirmDelete", { name: zone.name });
    const ok = await confirm({ title: "ยืนยันการลบ", body, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/reserva/zones/${zone.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t(lang, "common.deleted") });
        startTransition(() => router.refresh());
      } else {
        setMsg({ kind: "err", text: j?.error ?? t(lang, "common.error") });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {ConfirmDialog}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          {t(lang, "admin.reserva.zones.intro")}
        </p>
        <button type="button" onClick={() => setEditing("new")} className="btn-primary text-sm shrink-0">
          + {t(lang, "admin.reserva.zones.addBtn")}
        </button>
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      {zones.length === 0 ? (
        <div className="card text-sm text-slate-500 text-center py-8">
          {t(lang, "admin.reserva.zones.empty")}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="py-2 px-3 w-12">#</th>
                <th className="py-2 px-3">{t(lang, "admin.reserva.zones.col.name")}</th>
                <th className="py-2 px-3">{t(lang, "admin.reserva.zones.col.description")}</th>
                <th className="py-2 px-3 text-right">{t(lang, "admin.reserva.zones.col.tables")}</th>
                <th className="py-2 px-3">{t(lang, "admin.reserva.zones.col.status")}</th>
                <th className="py-2 px-3 w-24"></th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="py-2 px-3 text-slate-400">{z.display_order}</td>
                  <td className="py-2 px-3 font-medium text-slate-800">{z.name}</td>
                  <td className="py-2 px-3 text-slate-600">{z.description ?? "—"}</td>
                  <td className="py-2 px-3 text-right text-slate-600">{z.table_count}</td>
                  <td className="py-2 px-3">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      z.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-500"
                    }`}>
                      {z.active ? t(lang, "admin.reserva.zones.active") : t(lang, "admin.reserva.zones.inactive")}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-right space-x-2 whitespace-nowrap">
                    <button type="button" onClick={() => setEditing(z)} disabled={busy}
                      className="text-xs text-brand hover:underline">
                      {t(lang, "common.edit")}
                    </button>
                    <button type="button" onClick={() => deleteZone(z)} disabled={busy}
                      className="text-xs text-rose-600 hover:underline">
                      {t(lang, "common.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unassignedCount > 0 && (
        <div className="card border-l-4 border-amber-300 bg-amber-50/40 text-sm">
          <div className="font-medium text-slate-800">
            {t(lang, "admin.reserva.zones.unassigned.title", { count: String(unassignedCount) })}
          </div>
          <p className="text-xs text-slate-600 mt-1">
            {t(lang, "admin.reserva.zones.unassigned.desc")}
          </p>
        </div>
      )}

      {editing && (
        <ZoneFormModal
          lang={lang}
          zone={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setMsg({ kind: "ok", text: t(lang, "common.saved") });
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function ZoneFormModal({
  lang, zone, onClose, onSaved
}: {
  lang: Lang;
  zone: ZoneRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = zone === null;
  const [name, setName] = useState(zone?.name ?? "");
  const [description, setDescription] = useState(zone?.description ?? "");
  const [displayOrder, setDisplayOrder] = useState(String(zone?.display_order ?? 100));
  const [active, setActive] = useState(zone?.active === 0 ? false : true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      const url = isNew
        ? "/api/admin/reserva/zones"
        : `/api/admin/reserva/zones/${zone!.id}`;
      const res = await fetch(apiUrl(url), {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          display_order: Number(displayOrder) || 100,
          active: active ? 1 : 0
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        onSaved();
      } else {
        setErr(j?.error ?? t(lang, "common.error"));
      }
    } catch {
      setErr(t(lang, "common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-slate-800 text-lg">
          {isNew ? t(lang, "admin.reserva.zones.modalAddTitle") : t(lang, "admin.reserva.zones.modalEditTitle")}
        </h3>

        <div>
          <label className="label">{t(lang, "admin.reserva.zones.col.name")} *</label>
          <input className="input" value={name} maxLength={50}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(lang, "admin.reserva.zones.namePlaceholder")} />
        </div>

        <div>
          <label className="label">{t(lang, "admin.reserva.zones.col.description")}</label>
          <input className="input" value={description} maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(lang, "admin.reserva.zones.descPlaceholder")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t(lang, "admin.reserva.zones.displayOrder")}</label>
            <input type="number" className="input" value={displayOrder} min={1} max={9999}
              onChange={(e) => setDisplayOrder(e.target.value)} />
            <p className="text-xs text-slate-500 mt-1">{t(lang, "admin.reserva.zones.displayOrderHint")}</p>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <Switch checked={active} onChange={setActive} accent="emerald" />
              {t(lang, "admin.reserva.zones.activeLabel")}
            </label>
          </div>
        </div>

        {err && <p className="text-rose-600 text-sm">✗ {err}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            {t(lang, "common.cancel")}
          </button>
          <button type="button" onClick={save} disabled={busy || !name.trim()}
            className="flex-1 py-2.5 rounded-full bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
            {busy ? "…" : t(lang, "common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
