"use client";

// Collapsible "จัดการโต๊ะ" panel shown above the timetable. Replaces
// table editing on the (hidden) spatial floor-plan page: add a table,
// rename, change seats, move zone, or remove (soft-delete, guarded
// against live bookings). All ops hit /api/admin/reserva/tables and
// router.refresh() to re-pull the grid.

import { Fragment, useState } from "react";
import { useRouter } from "next/navigation";
import type { Branch, TableRow, Zone } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";

type Props = { branch: Branch; tables: TableRow[]; zones: Zone[] };

export default function TableManager({ branch, tables, zones }: Props) {
  const router = useRouter();
  const { t } = useLang();
  const { confirm, ConfirmDialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // New-table form state
  const [nLabel, setNLabel] = useState("");
  const [nCap, setNCap] = useState("2");
  const [nZone, setNZone] = useState<string>("");

  function errText(code: string, count?: number): string {
    if (code === "label_taken") return t("admin.reserva.tableMgr.errLabelTaken");
    if (code === "has_live_bookings") {
      return t("admin.reserva.tableMgr.errLive", { n: count ?? 0 });
    }
    return t("admin.reserva.tableMgr.errGeneric");
  }

  async function call(method: string, url: string, body?: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(url), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: errText(j.error, j.count) });
        return false;
      }
      setMsg({ kind: "ok", text: t("admin.reserva.tableMgr.saved") });
      router.refresh();
      return true;
    } catch {
      setMsg({ kind: "err", text: t("admin.reserva.tableMgr.errGeneric") });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addTable() {
    const cap = Number(nCap);
    if (!nLabel.trim() || !Number.isInteger(cap) || cap < 1) return;
    const ok = await call("POST", "/api/admin/reserva/tables", {
      branch_id: branch.id,
      label: nLabel.trim(),
      capacity: cap,
      zone_id: nZone ? Number(nZone) : null
    });
    if (ok) { setNLabel(""); setNCap("2"); setNZone(""); }
  }

  // Order tables by zone (display_order) then their in-zone sort_order, so the
  // list mirrors physical adjacency. Tag each with whether it can move up/down
  // within its zone (edges can't) to enable/disable the ↑/↓ reorder buttons.
  const zoneOrder = new Map(zones.map((z) => [z.id, z.display_order]));
  const ordered = [...tables].sort((a, b) => {
    const za = a.zone_id == null ? Infinity : (zoneOrder.get(a.zone_id) ?? 9999);
    const zb = b.zone_id == null ? Infinity : (zoneOrder.get(b.zone_id) ?? 9999);
    if (za !== zb) return za - zb;
    const zid = (a.zone_id ?? 0) - (b.zone_id ?? 0);
    if (zid !== 0) return zid;
    return (a.sort_order - b.sort_order) || a.label.localeCompare(b.label, undefined, { numeric: true });
  });
  const posInfo = new Map<number, { canUp: boolean; canDown: boolean }>();
  {
    const groups = new Map<string, TableRow[]>();
    for (const tbl of ordered) {
      const k = tbl.zone_id == null ? "none" : String(tbl.zone_id);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(tbl);
    }
    for (const arr of groups.values()) {
      arr.forEach((tbl, i) => posInfo.set(tbl.id, { canUp: i > 0, canDown: i < arr.length - 1 }));
    }
  }

  return (
    <div className="card !p-0 overflow-hidden">
      {ConfirmDialog}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        <span>{t("admin.reserva.tableMgr.title")}</span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200 p-4 space-y-3">
          {msg && (
            <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </div>
          )}

          {/* Existing tables — grouped by zone and shown in the order that
              defines adjacency (which tables can be pushed together). */}
          <div className="space-y-2">
            {tables.length === 0 && (
              <p className="text-sm text-slate-400">{t("admin.reserva.tableMgr.empty")}</p>
            )}
            {tables.length > 0 && (
              <p className="text-xs text-slate-400">{t("admin.reserva.tableMgr.orderHint")}</p>
            )}
            {ordered.map((tbl, i) => {
              const prev = ordered[i - 1];
              const showHeader = i === 0 || (prev.zone_id ?? null) !== (tbl.zone_id ?? null);
              const zoneName = tbl.zone_id == null
                ? t("admin.reserva.tableMgr.noZone")
                : (zones.find((z) => z.id === tbl.zone_id)?.name ?? "");
              const pos = posInfo.get(tbl.id) ?? { canUp: false, canDown: false };
              return (
              <Fragment key={tbl.id}>
                {showHeader && (
                  <div className="text-xs font-semibold text-slate-500 pt-1">{zoneName}</div>
                )}
                <TableEditRow
                  table={tbl}
                  zones={zones}
                  busy={busy}
                  canUp={pos.canUp}
                  canDown={pos.canDown}
                  onMove={(dir) =>
                    call("PATCH", "/api/admin/reserva/tables", { id: tbl.id, move: dir })
                  }
                  onSave={(label, capacity, zoneId, mergeable) =>
                    call("PATCH", "/api/admin/reserva/tables", {
                      id: tbl.id, label, capacity, zone_id: zoneId, mergeable
                    })
                  }
                  onDelete={async () => {
                  const ok = await confirm({
                    title: "ยืนยันการลบ",
                    body: t("admin.reserva.tableMgr.deleteConfirm", { label: tbl.label }),
                    confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger"
                  });
                  if (ok === null) return;
                  void call("DELETE", `/api/admin/reserva/tables?id=${tbl.id}`);
                }}
                />
              </Fragment>
              );
            })}
          </div>

          {/* Add new */}
          <div className="border-t border-slate-200 pt-3 flex flex-wrap items-end gap-2">
            <div>
              <label className="label">{t("admin.reserva.tableMgr.label")}</label>
              <input className="input w-28" value={nLabel} maxLength={20}
                onChange={(e) => setNLabel(e.target.value)} placeholder="A1" />
            </div>
            <div>
              <label className="label">{t("admin.reserva.tableMgr.capacity")}</label>
              <input className="input w-20" type="number" min={1} max={50}
                value={nCap} onChange={(e) => setNCap(e.target.value)} />
            </div>
            <div>
              <label className="label">{t("admin.reserva.tableMgr.zone")}</label>
              <select className="input w-40" value={nZone}
                onChange={(e) => setNZone(e.target.value)}>
                <option value="">{t("admin.reserva.tableMgr.noZone")}</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>{z.name}</option>
                ))}
              </select>
            </div>
            <button type="button" onClick={addTable}
              disabled={busy || !nLabel.trim()}
              className="btn-primary text-sm disabled:opacity-50">
              + {t("admin.reserva.tableMgr.add")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TableEditRow({
  table, zones, busy, canUp, canDown, onMove, onSave, onDelete
}: {
  table: TableRow;
  zones: Zone[];
  busy: boolean;
  canUp: boolean;
  canDown: boolean;
  onMove: (dir: "up" | "down") => void;
  onSave: (label: string, capacity: number, zoneId: number | null, mergeable: 0 | 1) => void;
  onDelete: () => void;
}) {
  const { t } = useLang();
  const [label, setLabel] = useState(table.label);
  const [cap, setCap] = useState(String(table.capacity));
  const [zone, setZone] = useState<string>(table.zone_id ? String(table.zone_id) : "");
  const [merge, setMerge] = useState<boolean>(table.mergeable !== 0);
  const dirty =
    label.trim() !== table.label ||
    Number(cap) !== table.capacity ||
    (zone ? Number(zone) : null) !== (table.zone_id ?? null) ||
    merge !== (table.mergeable !== 0);

  return (
    <div className="flex flex-wrap items-end gap-2 border border-slate-100 rounded-lg p-2">
      {/* ↑/↓ reorder — swaps in-zone order, which defines adjacency. */}
      <div className="flex flex-col gap-0.5">
        <button type="button" onClick={() => onMove("up")} disabled={busy || !canUp}
          title={t("admin.reserva.tableMgr.moveUp")}
          className="px-2 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30 text-xs leading-none">▲</button>
        <button type="button" onClick={() => onMove("down")} disabled={busy || !canDown}
          title={t("admin.reserva.tableMgr.moveDown")}
          className="px-2 py-0.5 rounded border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-30 text-xs leading-none">▼</button>
      </div>
      <div>
        <label className="label">{t("admin.reserva.tableMgr.label")}</label>
        <input className="input w-28" value={label} maxLength={20}
          onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <label className="label">{t("admin.reserva.tableMgr.capacity")}</label>
        <input className="input w-20" type="number" min={1} max={50}
          value={cap} onChange={(e) => setCap(e.target.value)} />
      </div>
      <div>
        <label className="label">{t("admin.reserva.tableMgr.zone")}</label>
        <select className="input w-40" value={zone}
          onChange={(e) => setZone(e.target.value)}>
          <option value="">{t("admin.reserva.tableMgr.noZone")}</option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>{z.name}</option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-1.5 text-sm text-slate-700 pb-2"
        title={t("admin.reserva.tableMgr.mergeableHint")}>
        <input type="checkbox" className="w-4 h-4" checked={merge}
          onChange={(e) => setMerge(e.target.checked)} />
        {t("admin.reserva.tableMgr.mergeable")}
      </label>
      <button type="button"
        onClick={() => {
          const c = Number(cap);
          if (!label.trim() || !Number.isInteger(c) || c < 1) return;
          onSave(label.trim(), c, zone ? Number(zone) : null, merge ? 1 : 0);
        }}
        disabled={busy || !dirty}
        className="btn-secondary text-sm disabled:opacity-40">
        {t("admin.reserva.tableMgr.save")}
      </button>
      <button type="button" onClick={onDelete} disabled={busy}
        className="text-sm px-3 py-2 rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-40">
        {t("admin.reserva.tableMgr.delete")}
      </button>
    </div>
  );
}
