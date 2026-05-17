"use client";

import { useMemo, useState } from "react";
import {
  PICK_FREQ_META, GRID_ROWS, GRID_COLS, binCode, isLowStock,
  type PickFreq
} from "@/lib/inventa";

// Standalone visual shelf map (A1–E6) — a *locate* tool: find where a
// medicine physically lives. Read-only on purpose (editing happens in
// the คลังยา table). Rows A–E top→bottom × columns 1–6 left→right,
// matching the real shelves.
export type GridItem = {
  id: number;
  name: string;
  generic_name: string | null;
  item_code: string | null;
  barcode: string | null;
  category: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  current_qty: number;
  safety_stock: number;
};

export default function StockGrid({ items }: { items: GridItem[] }) {
  const [q, setQ] = useState("");
  const [freq, setFreq] = useState<PickFreq | "">("");
  const [cell, setCell] = useState<{ row: string; col: number } | null>(null);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (freq && i.pick_freq !== freq) return false;
      if (!term) return true;
      return [
        i.name, i.generic_name, i.item_code, i.barcode, i.category,
        binCode(i.grid_row, i.grid_col, i.pick_freq)
      ].some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [items, q, freq]);

  const byCell = new Map<string, GridItem[]>();
  let unassigned = 0;
  for (const i of filtered) {
    if (i.grid_row && i.grid_col) {
      const k = `${i.grid_row}|${i.grid_col}`;
      const arr = byCell.get(k);
      if (arr) arr.push(i);
      else byCell.set(k, [i]);
    } else {
      unassigned += 1;
    }
  }

  const cellItems = cell
    ? items.filter((i) => i.grid_row === cell.row && i.grid_col === cell.col)
    : [];

  return (
    <>
      <div className="card space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <input className="input flex-1 min-w-[180px]" value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหายาเพื่อหาตำแหน่ง (ชื่อ / รหัส / D4R)" />
          <div className="flex gap-1">
            {(["", "R", "Y", "G"] as const).map((f) => (
              <button key={f || "all"} type="button"
                onClick={() => setFreq(f)}
                className={`text-xs px-3 py-1.5 rounded-md border ${
                  freq === f
                    ? "bg-brand text-white border-brand font-bold"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {f === "" ? "ทั้งหมด" : PICK_FREQ_META[f].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card space-y-2 overflow-x-auto">
        <div className="min-w-[560px]">
          {GRID_ROWS.map((r) => (
            <div key={r} className="grid grid-cols-6 gap-1.5 mb-1.5">
              {GRID_COLS.map((c) => {
                const list = byCell.get(`${r}|${c}`) ?? [];
                const low = list.some((i) => isLowStock(i.current_qty, i.safety_stock));
                const cnt = (f: PickFreq) => list.filter((i) => i.pick_freq === f).length;
                return (
                  <button key={c} type="button"
                    onClick={() => setCell({ row: r, col: c })}
                    className={`text-left rounded-lg border p-2 min-h-[64px] transition ${
                      list.length === 0
                        ? "border-slate-200 bg-slate-50/60 hover:bg-slate-100"
                        : low
                          ? "border-rose-300 bg-rose-50 hover:bg-rose-100 ring-1 ring-rose-300"
                          : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700">{r}{c}</span>
                      {list.length > 0 && (
                        <span className="text-[10px] text-slate-500">{list.length} ตัว</span>
                      )}
                    </div>
                    <div className="flex gap-1 mt-1.5">
                      {(["R", "Y", "G"] as PickFreq[]).map((f) =>
                        cnt(f) > 0 ? (
                          <span key={f}
                            className={`text-[10px] px-1.5 rounded ${PICK_FREQ_META[f].chip}`}>
                            {f}{cnt(f)}
                          </span>
                        ) : null
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {unassigned > 0 && (
          <p className="text-xs text-amber-700">
            มี {unassigned} รายการยังไม่ระบุตำแหน่ง — ไปกำหนดช่องที่เมนู "คลังยา/อุปกรณ์"
          </p>
        )}
      </div>

      {cell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setCell(null)}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-slate-800 text-lg">
              ช่อง <span className="text-brand">{cell.row}{cell.col}</span>
              <span className="ml-2 text-sm font-normal text-slate-500">
                {cellItems.length} รายการ
              </span>
            </h3>
            <div className="divide-y divide-slate-100">
              {cellItems.map((i) => {
                const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
                return (
                  <div key={i.id} className="py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          fm?.chip ?? "bg-slate-100 text-slate-500"}`}>
                          {binCode(i.grid_row, i.grid_col, i.pick_freq)}
                        </span>
                        <span className="font-medium text-slate-800 truncate">{i.name}</span>
                      </div>
                      {i.generic_name && (
                        <div className="text-xs text-slate-400">{i.generic_name}</div>
                      )}
                    </div>
                    <span className="text-sm font-bold text-slate-700 flex-shrink-0">
                      {i.current_qty}
                    </span>
                  </div>
                );
              })}
              {cellItems.length === 0 && (
                <div className="py-6 text-center text-slate-400 text-sm">
                  ช่องนี้ยังไม่มีรายการ
                </div>
              )}
            </div>
            <button type="button" onClick={() => setCell(null)}
              className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium">
              ปิด
            </button>
          </div>
        </div>
      )}
    </>
  );
}
