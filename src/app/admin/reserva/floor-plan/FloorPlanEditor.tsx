"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TableRow, Zone } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";
import Switch from "@/app/components/Switch";

const CANVAS_W = 900;
const CANVAS_H = 600;

type Draft = TableRow & { _new?: boolean; _dirty?: boolean; _deleted?: boolean };

// Zone-tab filter values: a real zone id (number), null = "ไม่ระบุโซน"
// (tables with zone_id = NULL), or "all" = show every table on the canvas.
type ZoneFilter = number | null | "all";

export default function FloorPlanEditor({
  branchId, initialTables, zones
}: { branchId: number; initialTables: TableRow[]; zones: Zone[] }) {
  const router = useRouter();
  const { t } = useLang();
  const { confirm, alert, ConfirmDialog } = useConfirm();
  const [tables, setTables] = useState<Draft[]>(initialTables);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Initial zone tab — start on the first zone if any exist, else "all"
  const [zoneFilter, setZoneFilter] = useState<ZoneFilter>(
    zones.length > 0 ? zones[0].id : "all"
  );
  const dragRef = useRef<{ id: number; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const tempIdRef = useRef(-1);

  const selected = tables.find((t) => t.id === selectedId && !t._deleted);

  function svgPoint(e: React.PointerEvent | PointerEvent) {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM()!.inverse();
    return pt.matrixTransform(ctm);
  }

  function startDrag(e: React.PointerEvent, t: Draft) {
    if (t._deleted) return;
    setSelectedId(t.id);
    const p = svgPoint(e);
    dragRef.current = { id: t.id, offsetX: p.x - t.x, offsetY: p.y - t.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const p = svgPoint(e);
    const { id, offsetX, offsetY } = dragRef.current;
    setTables((prev) =>
      prev.map((t) => t.id === id
        ? { ...t, x: Math.max(0, Math.min(CANVAS_W - t.width, p.x - offsetX)),
                  y: Math.max(0, Math.min(CANVAS_H - t.height, p.y - offsetY)),
                  _dirty: true }
        : t)
    );
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      try { (e.target as Element).releasePointerCapture(e.pointerId); } catch {}
    }
    dragRef.current = null;
  }

  function addTable() {
    const id = tempIdRef.current--;
    const nextLabelN = tables.filter((t) => !t._deleted).length + 1;
    // New tables join the currently-active zone tab, so creating one while
    // looking at "ชั้น 2" automatically slots into ชั้น 2.
    const zoneId = typeof zoneFilter === "number" ? zoneFilter : null;
    setTables((prev) => [...prev, {
      id, branch_id: branchId, zone_id: zoneId,
      label: `T${nextLabelN}`, capacity: 2,
      shape: "rect", x: 40, y: 40, width: 90, height: 90, active: 1,
      _new: true, _dirty: true
    }]);
    setSelectedId(id);
  }

  function updateSelected(patch: Partial<Draft>) {
    if (selectedId === null) return;
    setTables((prev) => prev.map((t) =>
      t.id === selectedId ? { ...t, ...patch, _dirty: true } : t
    ));
  }

  async function deleteSelected() {
    if (selectedId === null) return;
    const ok = await confirm({
      title: t("admin.floorplan.confirmDeleteTitle"),
      body: <p>{t("admin.floorplan.confirmDelete")}</p>,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (ok === null) return;
    setTables((prev) => prev.map((tab) =>
      tab.id === selectedId ? { ...tab, _deleted: true, _dirty: true } : tab
    ));
    setSelectedId(null);
  }

  async function save() {
    setSaving(true);
    const payload = tables.map((t) => ({
      id: t._new ? null : t.id,
      zone_id: t.zone_id ?? null,
      label: t.label,
      capacity: t.capacity,
      shape: t.shape,
      x: t.x, y: t.y, width: t.width, height: t.height,
      active: t.active,
      _deleted: !!t._deleted
    }));
    const res = await fetch(apiUrl("/api/admin/tables/bulk"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch_id: branchId, tables: payload })
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      await alert({ title: j.error || t("admin.floorplan.saveFailed"), variant: "danger" });
      return;
    }
    router.refresh();
  }

  // Block scroll when dragging on touch
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent) => { if (dragRef.current) e.preventDefault(); };
    el.addEventListener("touchmove", prevent, { passive: false });
    return () => el.removeEventListener("touchmove", prevent);
  }, []);

  // Tables matching the active zone tab (or all). Hidden tables stay in
  // state so save() still sends them; they just don't render on the canvas.
  const visibleTables = tables.filter((t) => {
    if (t._deleted) return false;
    if (zoneFilter === "all") return true;
    if (zoneFilter === null) return t.zone_id == null;
    return t.zone_id === zoneFilter;
  });

  return (
    <div className="space-y-3">
      {/* Zone tabs — quick filter so the canvas isn't cluttered when a
          branch has many zones. Always visible, even when no zones exist
          (then only the 'ทั้งหมด' tab shows). */}
      <div className="card !py-2 flex items-center gap-1 overflow-x-auto">
        <ZoneTab active={zoneFilter === "all"} onClick={() => setZoneFilter("all")}>
          {t("admin.floorplan.zoneTab.all")}
        </ZoneTab>
        {zones.map((z) => {
          const count = tables.filter((tbl) => !tbl._deleted && tbl.zone_id === z.id).length;
          return (
            <ZoneTab key={z.id}
              active={zoneFilter === z.id}
              onClick={() => setZoneFilter(z.id)}
            >
              {z.name} <span className="text-[10px] opacity-60">· {count}</span>
            </ZoneTab>
          );
        })}
        {tables.some((tbl) => !tbl._deleted && tbl.zone_id == null) && (
          <ZoneTab active={zoneFilter === null} onClick={() => setZoneFilter(null)}>
            {t("admin.floorplan.zoneTab.unassigned")}
          </ZoneTab>
        )}
      </div>

    <div className="grid lg:grid-cols-[1fr_280px] gap-3">
      <div className="card overflow-auto">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CANVAS_W} ${CANVAS_H}`}
          width="100%"
          className="border border-slate-200 rounded bg-slate-50 touch-none"
          style={{ maxHeight: "70vh" }}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={(e) => { if (e.target === svgRef.current) setSelectedId(null); }}
        >
          {/* grid */}
          <defs>
            <pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse">
              <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#e2e8f0" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width={CANVAS_W} height={CANVAS_H} fill="url(#grid)" />

          {visibleTables.map((t) => {
            const isSel = t.id === selectedId;
            const fill = t.active ? (isSel ? "#0f766e" : "#14b8a6") : "#94a3b8";
            return (
              <g
                key={t.id}
                onPointerDown={(e) => startDrag(e, t)}
                style={{ cursor: "move" }}
              >
                {t.shape === "round" ? (
                  <ellipse
                    cx={t.x + t.width / 2}
                    cy={t.y + t.height / 2}
                    rx={t.width / 2}
                    ry={t.height / 2}
                    fill={fill}
                    stroke={isSel ? "#0f172a" : "#0f766e"}
                    strokeWidth={isSel ? 3 : 1}
                  />
                ) : (
                  <rect
                    x={t.x} y={t.y} width={t.width} height={t.height}
                    rx={8} fill={fill}
                    stroke={isSel ? "#0f172a" : "#0f766e"}
                    strokeWidth={isSel ? 3 : 1}
                  />
                )}
                <text
                  x={t.x + t.width / 2} y={t.y + t.height / 2 - 4}
                  textAnchor="middle" fill="white" fontSize="14" fontWeight="bold"
                  pointerEvents="none"
                >{t.label}</text>
                <text
                  x={t.x + t.width / 2} y={t.y + t.height / 2 + 14}
                  textAnchor="middle" fill="white" fontSize="11"
                  pointerEvents="none"
                >{t.capacity}</text>
              </g>
            );
          })}
        </svg>
      </div>

      <aside className="space-y-3">
        <div className="card">
          <button onClick={addTable} className="btn-primary w-full">{t("admin.floorplan.addTable")}</button>
          <button
            onClick={save}
            disabled={saving || !tables.some((tbl) => tbl._dirty)}
            className="btn-success w-full mt-2"
          >{saving ? t("admin.settings.saving") : t("admin.floorplan.savePlan")}</button>
        </div>

        {selected ? (
          <div className="card space-y-3">
            <h3 className="font-semibold">{t("admin.floorplan.editTable")}</h3>
            <div>
              <label className="label">{t("admin.floorplan.field.label")}</label>
              <input
                className="input" value={selected.label}
                onChange={(e) => updateSelected({ label: e.target.value })}
              />
            </div>
            <div>
              <label className="label">{t("admin.floorplan.field.zone")}</label>
              <select
                className="input"
                value={selected.zone_id == null ? "" : String(selected.zone_id)}
                onChange={(e) => updateSelected({
                  zone_id: e.target.value === "" ? null : Number(e.target.value)
                })}
              >
                <option value="">— {t("admin.floorplan.zoneNone")} —</option>
                {zones.map((z) => (
                  <option key={z.id} value={String(z.id)}>{z.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t("admin.floorplan.field.capacity")}</label>
              <input
                type="number" min={1} max={20} className="input"
                value={selected.capacity}
                onChange={(e) => updateSelected({ capacity: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">{t("admin.floorplan.field.shape")}</label>
              <select
                className="input" value={selected.shape}
                onChange={(e) => updateSelected({ shape: e.target.value as "rect" | "round" })}
              >
                <option value="rect">{t("admin.floorplan.shape.rect")}</option>
                <option value="round">{t("admin.floorplan.shape.round")}</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">{t("admin.floorplan.field.width")}</label>
                <input
                  type="number" min={40} max={300} step={10} className="input"
                  value={selected.width}
                  onChange={(e) => updateSelected({ width: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="label">{t("admin.floorplan.field.height")}</label>
                <input
                  type="number" min={40} max={300} step={10} className="input"
                  value={selected.height}
                  onChange={(e) => updateSelected({ height: Number(e.target.value) })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2">
              <Switch
                checked={selected.active === 1}
                accent="emerald"
                onChange={(v) => updateSelected({ active: v ? 1 : 0 })}
              />
              <span className="text-sm">{t("admin.floorplan.active")}</span>
            </label>
            <button onClick={deleteSelected} className="btn-danger w-full">{t("admin.floorplan.deleteTable")}</button>
          </div>
        ) : (
          <div className="card text-sm text-slate-500">
            {t("admin.floorplan.tip")}
          </div>
        )}
      </aside>
      {ConfirmDialog}
    </div>
    </div>
  );
}

function ZoneTab({
  active, onClick, children
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${
        active
          ? "bg-brand text-white"
          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
