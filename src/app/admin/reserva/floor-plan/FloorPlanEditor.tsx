"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { TableRow } from "@/lib/db";
import { apiUrl } from "@/lib/url";

const CANVAS_W = 900;
const CANVAS_H = 600;

type Draft = TableRow & { _new?: boolean; _dirty?: boolean; _deleted?: boolean };

export default function FloorPlanEditor({
  branchId, initialTables
}: { branchId: number; initialTables: TableRow[] }) {
  const router = useRouter();
  const [tables, setTables] = useState<Draft[]>(initialTables);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
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
    setTables((prev) => [...prev, {
      id, branch_id: branchId, label: `T${nextLabelN}`, capacity: 2,
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

  function deleteSelected() {
    if (selectedId === null) return;
    if (!confirm("ลบโต๊ะนี้? (ถ้าเคยมีการจองที่ผูกกับโต๊ะนี้จะไม่หาย แค่หลุดความสัมพันธ์)")) return;
    setTables((prev) => prev.map((t) =>
      t.id === selectedId ? { ...t, _deleted: true, _dirty: true } : t
    ));
    setSelectedId(null);
  }

  async function save() {
    setSaving(true);
    const payload = tables.map((t) => ({
      id: t._new ? null : t.id,
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
      alert(j.error || "บันทึกไม่สำเร็จ");
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

  return (
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

          {tables.filter((t) => !t._deleted).map((t) => {
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
                >{t.capacity} ที่</text>
              </g>
            );
          })}
        </svg>
      </div>

      <aside className="space-y-3">
        <div className="card">
          <button onClick={addTable} className="btn-primary w-full">+ เพิ่มโต๊ะ</button>
          <button
            onClick={save}
            disabled={saving || !tables.some((t) => t._dirty)}
            className="btn-success w-full mt-2"
          >{saving ? "กำลังบันทึก..." : "บันทึกผัง"}</button>
        </div>

        {selected ? (
          <div className="card space-y-3">
            <h3 className="font-semibold">แก้ไขโต๊ะ</h3>
            <div>
              <label className="label">ชื่อ/หมายเลข</label>
              <input
                className="input" value={selected.label}
                onChange={(e) => updateSelected({ label: e.target.value })}
              />
            </div>
            <div>
              <label className="label">จำนวนที่นั่ง</label>
              <input
                type="number" min={1} max={20} className="input"
                value={selected.capacity}
                onChange={(e) => updateSelected({ capacity: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">รูปร่าง</label>
              <select
                className="input" value={selected.shape}
                onChange={(e) => updateSelected({ shape: e.target.value as "rect" | "round" })}
              >
                <option value="rect">สี่เหลี่ยม</option>
                <option value="round">วงกลม</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">กว้าง</label>
                <input
                  type="number" min={40} max={300} step={10} className="input"
                  value={selected.width}
                  onChange={(e) => updateSelected({ width: Number(e.target.value) })}
                />
              </div>
              <div>
                <label className="label">สูง</label>
                <input
                  type="number" min={40} max={300} step={10} className="input"
                  value={selected.height}
                  onChange={(e) => updateSelected({ height: Number(e.target.value) })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox" checked={selected.active === 1}
                onChange={(e) => updateSelected({ active: e.target.checked ? 1 : 0 })}
              />
              <span className="text-sm">ใช้งาน (เปิดให้จอง)</span>
            </label>
            <button onClick={deleteSelected} className="btn-danger w-full">ลบโต๊ะนี้</button>
          </div>
        ) : (
          <div className="card text-sm text-slate-500">
            คลิกที่โต๊ะเพื่อแก้ไข หรือกด <b>+ เพิ่มโต๊ะ</b>
          </div>
        )}
      </aside>
    </div>
  );
}
