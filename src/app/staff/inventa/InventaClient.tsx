"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import {
  PICK_FREQ_META, GRID_ROWS, GRID_COLS, binCode, unitCostFrom,
  isLowStock, type PickFreq, type ItemType, type InventaSupplier
} from "@/lib/inventa";

type Item = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  cgd_code: string | null;
  category: string | null;
  item_type: ItemType;
  unit: string | null;
  unit_cost: number;
  last_purchase_price: number | null;
  last_purchase_units: number | null;
  price_opd: number | null;
  price_ipd: number | null;
  price_uc: number | null;
  supplier_id: number | null;
  supplier_name: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  safety_stock: number;
  current_qty: number;
};

export default function InventaClient({
  items, suppliers
}: { items: Item[]; suppliers: InventaSupplier[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [freqFilter, setFreqFilter] = useState<PickFreq | "">("");
  const [edit, setEdit] = useState<Item | null>(null);
  const [adding, setAdding] = useState<Partial<Item> | null>(null);
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanCam, setScanCam] = useState(false);
  const scanRef = useRef<HTMLInputElement>(null);

  const refresh = () => startTransition(() => router.refresh());

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return items.filter((i) => {
      if (freqFilter && i.pick_freq !== freqFilter) return false;
      if (!term) return true;
      return [
        i.name, i.generic_name, i.item_code, i.barcode, i.category,
        binCode(i.grid_row, i.grid_col, i.pick_freq)
      ].some((v) => (v ?? "").toLowerCase().includes(term));
    });
  }, [items, q, freqFilter]);

  // Scan: USB scanners type the code then send Enter. Look it up — a
  // hit opens the edit modal (adjust qty/details); a miss opens the
  // add modal pre-filled with the scanned barcode.
  async function onScan(code: string) {
    const barcode = code.trim();
    if (!barcode) return;
    setScanBusy(true);
    try {
      const res = await fetch(
        apiUrl(`/api/inventa/items?barcode=${encodeURIComponent(barcode)}`)
      );
      const j = await res.json().catch(() => ({}));
      if (j?.item) setEdit(j.item as Item);
      else setAdding({ barcode });
    } finally {
      setScanBusy(false);
      if (scanRef.current) scanRef.current.value = "";
    }
  }

  return (
    <>
      <div className="card space-y-3">
        {/* Scan + actions */}
        <div className="flex flex-wrap gap-2 items-center">
          <input
            ref={scanRef}
            className="input flex-1 min-w-[200px]"
            placeholder="สแกน / พิมพ์บาร์โค้ด แล้วกด Enter"
            disabled={scanBusy}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onScan((e.target as HTMLInputElement).value);
              }
            }}
          />
          <button type="button"
            onClick={() => setScanCam(true)}
            className="text-sm px-4 py-2 rounded-lg border border-brand text-brand font-bold hover:bg-rose-50">
            สแกนกล้อง
          </button>
          <button type="button"
            onClick={() => setAdding({})}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold hover:opacity-90">
            + เพิ่มยา/อุปกรณ์
          </button>
          <button type="button"
            onClick={() => setShowSuppliers(true)}
            className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            จัดการผู้สั่ง ({suppliers.length})
          </button>
          <Link href="/staff/inventa/grid"
            className="text-sm px-4 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            ผังกริด
          </Link>
          <Link href="/staff/inventa/count"
            className="text-sm px-4 py-2 rounded-lg border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-bold">
            เช็คสต๊อกรายสัปดาห์
          </Link>
        </div>

        {/* Search + colour filter */}
        <div className="flex flex-wrap gap-2 items-center">
          <input className="input flex-1 min-w-[160px]" value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา ชื่อ / ชื่อสามัญ / รหัส / ตำแหน่ง (เช่น D4R)" />
          <div className="flex gap-1">
            {(["", "R", "Y", "G"] as const).map((f) => (
              <button key={f || "all"} type="button"
                onClick={() => setFreqFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-md border ${
                  freqFilter === f
                    ? "bg-brand text-white border-brand font-bold"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
                {f === "" ? "ทั้งหมด" : PICK_FREQ_META[f].short}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3">ตำแหน่ง</th>
              <th className="py-2 pr-3">ชื่อ</th>
              <th className="py-2 pr-3">หมวด</th>
              <th className="py-2 pr-3">ผู้สั่ง</th>
              <th className="py-2 pr-3">หน่วย</th>
              <th className="py-2 pr-3 text-right">ทุน/หน่วย</th>
              <th className="py-2 pr-3 text-right">คงเหลือ</th>
              <th className="py-2 pr-3 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const low = isLowStock(i.current_qty, i.safety_stock);
              const fm = i.pick_freq ? PICK_FREQ_META[i.pick_freq] : null;
              return (
                <tr key={i.id}
                  className={`border-b last:border-0 ${low ? "bg-rose-50/50" : "hover:bg-slate-50"}`}>
                  <td className="py-2 pr-3">
                    <span className={`inline-block text-xs font-bold px-2 py-0.5 rounded ${
                      fm?.chip ?? "bg-slate-100 text-slate-500"}`}>
                      {binCode(i.grid_row, i.grid_col, i.pick_freq) || "—"}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{i.name}</div>
                    {i.generic_name && (
                      <div className="text-xs text-slate-400">{i.generic_name}</div>
                    )}
                    {i.item_code && (
                      <div className="text-[10px] text-slate-400">{i.item_code}</div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.category ?? "—"}</td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.supplier_name ?? "—"}</td>
                  <td className="py-2 pr-3 text-slate-600 text-xs">{i.unit ?? "—"}</td>
                  <td className="py-2 pr-3 text-right text-slate-700">
                    {i.unit_cost ? i.unit_cost.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "—"}
                  </td>
                  <td className={`py-2 pr-3 text-right font-bold ${low ? "text-rose-600" : "text-slate-800"}`}>
                    {i.current_qty}
                    {low && <span className="ml-1 text-[10px] font-normal">(ต่ำ)</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button type="button" onClick={() => setEdit(i)}
                      className="text-xs text-brand hover:underline">แก้ไข</button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="py-6 text-center text-slate-400 text-sm">
                ไม่พบรายการ — สแกนบาร์โค้ดหรือกด "เพิ่มยา/อุปกรณ์"
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {scanCam && (
        <BarcodeScanner
          title="สแกน QR / บาร์โค้ด เพื่อค้นหายา"
          onResult={(code) => onScan(code)}
          onClose={() => setScanCam(false)}
        />
      )}

      {(edit || adding) && (
        <ItemModal
          item={edit}
          seed={adding ?? undefined}
          suppliers={suppliers}
          onClose={() => { setEdit(null); setAdding(null); }}
          onSaved={() => { setEdit(null); setAdding(null); refresh(); }}
        />
      )}

      {showSuppliers && (
        <SuppliersModal
          suppliers={suppliers}
          onClose={() => setShowSuppliers(false)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

// ── Item add/edit modal ────────────────────────────────────────────
function ItemModal({
  item, seed, suppliers, onClose, onSaved
}: {
  item: Item | null;
  seed?: Partial<Item>;
  suppliers: InventaSupplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const base: Partial<Item> = item ?? seed ?? {};
  const [f, setF] = useState({
    item_code: base.item_code ?? "",
    barcode: base.barcode ?? "",
    name: base.name ?? "",
    generic_name: base.generic_name ?? "",
    cgd_code: base.cgd_code ?? "",
    category: base.category ?? "",
    item_type: (base.item_type ?? "drug") as ItemType,
    unit: base.unit ?? "",
    purchase_price: base.last_purchase_price != null ? String(base.last_purchase_price) : "",
    purchase_units: base.last_purchase_units != null ? String(base.last_purchase_units) : "",
    price_opd: base.price_opd != null ? String(base.price_opd) : "",
    supplier_id: base.supplier_id != null ? String(base.supplier_id) : "",
    grid_row: base.grid_row ?? "",
    grid_col: base.grid_col != null ? String(base.grid_col) : "",
    pick_freq: (base.pick_freq ?? "") as PickFreq | "",
    safety_stock: base.safety_stock != null ? String(base.safety_stock) : "50",
    current_qty: base.current_qty != null ? String(base.current_qty) : "0"
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Cast the spread result back to the state shape — a computed-key
  // assignment of a string into the union-typed (ItemType / PickFreq)
  // slots would otherwise widen and fail the build.
  const up = (k: keyof typeof f, v: string) =>
    setF((p) => ({ ...p, [k]: v }) as typeof p);

  const unitCost = unitCostFrom(
    Number(f.purchase_price) || 0, Number(f.purchase_units) || 0
  );
  const preview = binCode(
    f.grid_row || null,
    f.grid_col ? Number(f.grid_col) : null,
    (f.pick_freq || null) as PickFreq | null
  );

  async function save() {
    setErr(null);
    if (!f.name.trim()) { setErr("กรอกชื่อ"); return; }
    setBusy(true);
    try {
      const body = {
        item_code: f.item_code.trim() || null,
        barcode: f.barcode.trim() || null,
        name: f.name.trim(),
        generic_name: f.generic_name.trim() || null,
        cgd_code: f.cgd_code.trim() || null,
        category: f.category.trim() || null,
        item_type: f.item_type,
        unit: f.unit.trim() || null,
        last_purchase_price: f.purchase_price ? Number(f.purchase_price) : null,
        last_purchase_units: f.purchase_units ? Number(f.purchase_units) : null,
        price_opd: f.price_opd ? Number(f.price_opd) : null,
        supplier_id: f.supplier_id ? Number(f.supplier_id) : null,
        grid_row: f.grid_row || null,
        grid_col: f.grid_col ? Number(f.grid_col) : null,
        pick_freq: f.pick_freq || null,
        safety_stock: Number(f.safety_stock) || 0,
        current_qty: Number(f.current_qty) || 0
      };
      const res = item
        ? await fetch(apiUrl(`/api/inventa/items/${item.id}`), {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body) })
        : await fetch(apiUrl("/api/inventa/items"), {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error ?? "เกิดข้อผิดพลาด"); return; }
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!item) return;
    if (!confirm(`ลบ "${item.name}" ออกจากคลัง?`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/items/${item.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setErr(j?.error ?? "ลบไม่สำเร็จ"); return; }
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">
          {item ? "แก้ไขรายการ" : "เพิ่มยา/อุปกรณ์"}
        </h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">ประเภท *</label>
            <select className="input" value={f.item_type}
              onChange={(e) => up("item_type", e.target.value)}>
              <option value="drug">ยา</option>
              <option value="equipment">อุปกรณ์</option>
            </select>
          </div>
          <div>
            <label className="label">บาร์โค้ด</label>
            <input className="input" value={f.barcode}
              onChange={(e) => up("barcode", e.target.value)} />
          </div>
          <div className="col-span-2">
            <label className="label">ชื่อสินค้า *</label>
            <input className="input" value={f.name}
              onChange={(e) => up("name", e.target.value)} />
          </div>
          <div>
            <label className="label">ชื่อสามัญ</label>
            <input className="input" value={f.generic_name}
              onChange={(e) => up("generic_name", e.target.value)} />
          </div>
          <div>
            <label className="label">หมวดหมู่</label>
            <input className="input" value={f.category}
              onChange={(e) => up("category", e.target.value)}
              placeholder="เช่น General Drugs / NSAIDs" />
          </div>
          <div>
            <label className="label">รหัสสินค้า</label>
            <input className="input" value={f.item_code}
              onChange={(e) => up("item_code", e.target.value)}
              placeholder="เช่น IKGPH/A0001" />
          </div>
          <div>
            <label className="label">รหัสกรมบัญชีกลาง</label>
            <input className="input" value={f.cgd_code}
              onChange={(e) => up("cgd_code", e.target.value)} />
          </div>
        </div>

        {/* Location + colour */}
        <div className="border-t border-slate-200 pt-3">
          <div className="text-xs font-bold text-slate-700 mb-2">
            ตำแหน่งในคลัง (Grid)
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">แถว (A–E)</label>
              <select className="input" value={f.grid_row}
                onChange={(e) => up("grid_row", e.target.value)}>
                <option value="">—</option>
                {GRID_ROWS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div>
              <label className="label">คอลัมน์ (1–6)</label>
              <select className="input" value={f.grid_col}
                onChange={(e) => up("grid_col", e.target.value)}>
                <option value="">—</option>
                {GRID_COLS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">สีหยิบใช้</label>
              <select className="input" value={f.pick_freq}
                onChange={(e) => up("pick_freq", e.target.value)}>
                <option value="">—</option>
                <option value="R">R · นานๆ หยิบที</option>
                <option value="Y">Y · ปานกลาง</option>
                <option value="G">G · หยิบบ่อย</option>
              </select>
            </div>
          </div>
          {preview && (
            <p className="text-xs text-slate-500 mt-2">
              รหัสตำแหน่ง: <span className="font-bold text-brand">{preview}</span>
            </p>
          )}
        </div>

        {/* Cost (per smallest unit, derived from a purchase line) */}
        <div className="border-t border-slate-200 pt-3">
          <div className="text-xs font-bold text-slate-700 mb-2">
            ราคาทุน (ต่อหน่วยเล็กสุด)
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label">หน่วยเล็กสุด</label>
              <input className="input" value={f.unit}
                onChange={(e) => up("unit", e.target.value)}
                placeholder="เช่น เม็ด / ขวด" />
            </div>
            <div>
              <label className="label">ราคาซื้อรวม (บาท)</label>
              <input className="input" type="number" min="0" step="0.01"
                value={f.purchase_price}
                onChange={(e) => up("purchase_price", e.target.value)}
                placeholder="500" />
            </div>
            <div>
              <label className="label">ได้กี่หน่วยเล็กสุด</label>
              <input className="input" type="number" min="0" step="1"
                value={f.purchase_units}
                onChange={(e) => up("purchase_units", e.target.value)}
                placeholder="500" />
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            = ทุน <span className="font-bold text-brand">
              {unitCost.toLocaleString(undefined, { maximumFractionDigits: 4 })}
            </span> บาท / {f.unit || "หน่วย"}
            <span className="text-slate-400"> (เช่น 500 บาท ÷ 500 เม็ด = 1 บาท/เม็ด)</span>
          </p>
        </div>

        {/* Stock + supplier */}
        <div className="grid grid-cols-2 gap-3 border-t border-slate-200 pt-3">
          <div>
            <label className="label">คงเหลือปัจจุบัน</label>
            <input className="input" type="number" min="0" value={f.current_qty}
              onChange={(e) => up("current_qty", e.target.value)} />
          </div>
          <div>
            <label className="label">จุดสั่งซื้อ (safety stock)</label>
            <input className="input" type="number" min="0" value={f.safety_stock}
              onChange={(e) => up("safety_stock", e.target.value)} />
            <p className="text-[10px] text-slate-400 mt-1">ค่าเริ่มต้น 50 — ต่ำกว่านี้ถือว่าต้องสั่ง</p>
          </div>
          <div>
            <label className="label">ผู้สั่ง (บริษัท)</label>
            <select className="input" value={f.supplier_id}
              onChange={(e) => up("supplier_id", e.target.value)}>
              <option value="">—</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">ราคาขาย OPD (อ้างอิง)</label>
            <input className="input" type="number" min="0" step="0.01"
              value={f.price_opd}
              onChange={(e) => up("price_opd", e.target.value)} />
          </div>
        </div>

        {err && <div className="text-rose-600 text-sm">✗ {err}</div>}

        <div className="flex gap-2 pt-1">
          {item && (
            <button type="button" onClick={del} disabled={busy}
              className="px-4 py-2.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm">
              ลบ
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
            ยกเลิก
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            {busy ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Suppliers manager ──────────────────────────────────────────────
function SuppliersModal({
  suppliers, onClose, onChanged
}: {
  suppliers: InventaSupplier[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [cycle, setCycle] = useState("");
  const [lead, setLead] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/suppliers"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          order_cycle: cycle.trim() || null,
          lead_time: lead.trim() || null
        })
      });
      if (res.ok) {
        setName(""); setCycle(""); setLead("");
        onChanged();
      }
    } finally { setBusy(false); }
  }

  async function del(id: number, nm: string) {
    if (!confirm(`ลบผู้สั่ง "${nm}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/suppliers/${id}`), { method: "DELETE" });
      if (res.ok) onChanged();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">จัดการผู้สั่ง (บริษัท)</h3>
        <p className="text-xs text-slate-500">
          แต่ละบริษัทมีรอบสั่ง/รอบส่งต่างกัน — บันทึกไว้เพื่อวางแผนสั่งซื้อ
        </p>

        <div className="space-y-2 border border-slate-200 rounded-lg p-3">
          <input className="input" value={name} placeholder="ชื่อบริษัท *"
            onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <input className="input text-sm" value={cycle}
              placeholder="รอบสั่ง เช่น ทุกอังคาร"
              onChange={(e) => setCycle(e.target.value)} />
            <input className="input text-sm" value={lead}
              placeholder="รอบส่ง เช่น 2-3 วัน"
              onChange={(e) => setLead(e.target.value)} />
          </div>
          <button type="button" onClick={add} disabled={busy || !name.trim()}
            className="w-full py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
            + เพิ่มผู้สั่ง
          </button>
        </div>

        <div className="divide-y divide-slate-100">
          {suppliers.map((s) => (
            <div key={s.id} className="py-2 flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-slate-800 text-sm">{s.name}</div>
                <div className="text-xs text-slate-500">
                  {s.order_cycle ? `สั่ง: ${s.order_cycle}` : ""}
                  {s.lead_time ? ` · ส่ง: ${s.lead_time}` : ""}
                </div>
              </div>
              <button type="button" onClick={() => del(s.id, s.name)}
                className="text-xs text-rose-600 hover:underline">ลบ</button>
            </div>
          ))}
          {suppliers.length === 0 && (
            <div className="py-4 text-center text-slate-400 text-sm">ยังไม่มีผู้สั่ง</div>
          )}
        </div>

        <button type="button" onClick={onClose}
          className="w-full py-2.5 rounded-lg bg-slate-100 text-slate-700 text-sm font-medium">
          ปิด
        </button>
      </div>
    </div>
  );
}
