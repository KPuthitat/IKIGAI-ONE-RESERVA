"use client";

// Collapsible "จัดการโต๊ะ" panel shown above the timetable. Replaces
// table editing on the (hidden) spatial floor-plan page: add a table,
// rename, change seats, move zone, or remove (soft-delete, guarded
// against live bookings). All ops hit /api/admin/reserva/tables and
// router.refresh() to re-pull the grid.

import { useState } from "react";
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

  return (
    <div className="card !p-0 overflow-hidden">
      {ConfirmDialog}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
      >
        <span>⚙ {t("admin.reserva.tableMgr.title")}</span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-200 p-4 space-y-3">
          {msg && (
            <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
            </div>
          )}

          {/* Existing tables */}
          <div className="space-y-2">
            {tables.length === 0 && (
              <p className="text-sm text-slate-400">{t("admin.reserva.tableMgr.empty")}</p>
            )}
            {tables.map((tbl) => (
              <TableEditRow
                key={tbl.id}
                table={tbl}
                zones={zones}
                busy={busy}
                onSave={(label, capacity, zoneId) =>
                  call("PATCH", "/api/admin/reserva/tables", {
                    id: tbl.id, label, capacity, zone_id: zoneId
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
            ))}
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
  table, zones, busy, onSave, onDelete
}: {
  table: TableRow;
  zones: Zone[];
  busy: boolean;
  onSave: (label: string, capacity: number, zoneId: number | null) => void;
  onDelete: () => void;
}) {
  const { t } = useLang();
  const [label, setLabel] = useState(table.label);
  const [cap, setCap] = useState(String(table.capacity));
  const [zone, setZone] = useState<string>(table.zone_id ? String(table.zone_id) : "");
  const dirty =
    label.trim() !== table.label ||
    Number(cap) !== table.capacity ||
    (zone ? Number(zone) : null) !== (table.zone_id ?? null);

  return (
    <div className="flex flex-wrap items-end gap-2 border border-slate-100 rounded-lg p-2">
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
      <button type="button"
        onClick={() => {
          const c = Number(cap);
          if (!label.trim() || !Number.isInteger(c) || c < 1) return;
          onSave(label.trim(), c, zone ? Number(zone) : null);
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
