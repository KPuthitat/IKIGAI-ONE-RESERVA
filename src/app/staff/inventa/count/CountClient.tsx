"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import BarcodeScanner from "@/app/components/BarcodeScanner";
import { binCode, PICK_FREQ_META, type PickFreq } from "@/lib/inventa";

export type CountItem = {
  id: number;
  item_code: string | null;
  barcode: string | null;
  name: string;
  generic_name: string | null;
  unit: string | null;
  grid_row: string | null;
  grid_col: number | null;
  pick_freq: PickFreq | null;
  current_qty: number;
  safety_stock: number;
};

export default function CountClient({
  items, session, initialCounted
}: {
  items: CountItem[];
  session: { id: number; count_date: string } | null;
  initialCounted: Record<number, number>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());

  const [counted, setCounted] = useState<Record<number, number>>(initialCounted);
  const [sel, setSel] = useState<CountItem | null>(null);
  const [qty, setQty] = useState("");
  const [scanCam, setScanCam] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const total = items.length;
  const done = Object.keys(counted).length;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((i) => [
      i.name, i.generic_name, i.item_code, i.barcode,
      binCode(i.grid_row, i.grid_col, i.pick_freq)
    ].some((v) => (v ?? "").toLowerCase().includes(term)));
  }, [items, q]);

  function pick(item: CountItem) {
    setSel(item);
    setMsg(null);
    // Don't anchor on the system on-hand — it isn't deducted on use so
    // it won't be accurate. Start blank (or the value already counted
    // this round so it can be corrected).
    setQty(counted[item.id] !== undefined ? String(counted[item.id]) : "");
  }

  function resolveBarcode(code: string) {
    const c = code.trim();
    if (!c) return;
    // Match the scanned value against the box barcode OR the item_code
    // (the QR we print encodes item_code).
    const hit = items.find(
      (i) => (i.barcode ?? "") === c || (i.item_code ?? "") === c
    );
    if (hit) pick(hit);
    else setMsg(`ไม่พบรหัส ${c} ในคลัง — เพิ่มรายการนี้ในเมนูคลังก่อน`);
    if (scanRef.current) scanRef.current.value = "";
  }

  async function startSession() {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/inventa/counts"), { method: "POST" });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  async function saveLine() {
    if (!sel || !session) return;
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 0) { setMsg("กรอกจำนวนเป็นเลขจำนวนเต็ม"); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/inventa/counts/${session.id}/line`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: sel.id, counted_qty: n })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) { setMsg(j?.error ?? "บันทึกไม่สำเร็จ"); return; }
      setCounted((p) => ({ ...p, [sel.id]: n }));
      setSel(null);
      setQty("");
    } finally { setBusy(false); }
  }

  async function submit() {
    if (!session) return;
    if (!confirm(`ส่งบันทึกการนับรอบนี้? (นับแล้ว ${done}/${total} รายการ)`)) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/inventa/counts/${session.id}/submit`), {
        method: "POST"
      });
      if (res.ok) refresh();
    } finally { setBusy(false); }
  }

  if (!session) {
    return (
      <div className="card text-center space-y-3 py-8">
        <p className="text-slate-600">ยังไม่มีรอบนับที่เปิดอยู่</p>
        <button type="button" onClick={startSession} disabled={busy}
          className="px-6 py-2.5 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
          {busy ? "กำลังเปิด..." : "เริ่มรอบนับวันนี้"}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-sm text-slate-600">
            รอบนับวันที่ <span className="font-bold text-slate-800">{session.count_date}</span>
          </div>
          <div className="text-sm">
            นับแล้ว <span className="font-bold text-brand">{done}</span> / {total}
          </div>
        </div>
        <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
          <div className="h-full bg-brand transition-all"
            style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>

        <div className="flex flex-wrap gap-2">
          <input ref={scanRef} className="input flex-1 min-w-[180px]"
            placeholder="สแกน / พิมพ์ รหัส หรือบาร์โค้ด แล้วกด Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                resolveBarcode((e.target as HTMLInputElement).value);
              }
            }} />
          <button type="button" onClick={() => setScanCam(true)}
            className="text-sm px-4 py-2 rounded-lg border border-brand text-brand font-bold hover:bg-rose-50">
            สแกนคิวอาร์โค้ด
          </button>
          <button type="button" onClick={submit} disabled={busy}
            className="text-sm px-4 py-2 rounded-lg bg-brand text-white font-bold disabled:opacity-50">
            ส่งบันทึกการนับ
          </button>
        </div>
        {msg && <div className="text-sm text-rose-600">{msg}</div>}
      </div>

      {sel && (
        <div className="card space-y-3 border-2 border-brand">
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                sel.pick_freq ? PICK_FREQ_META[sel.pick_freq].chip : "bg-slate-100 text-slate-500"}`}>
                {binCode(sel.grid_row, sel.grid_col, sel.pick_freq) || "—"}
              </span>
              <span className="font-bold text-slate-800">{sel.name}</span>
            </div>
            {sel.generic_name && (
              <div className="text-xs text-slate-400 mt-0.5">{sel.generic_name}</div>
            )}
          </div>
          <div>
            <label className="label">จำนวนที่นับได้จริง วันนี้ ({sel.unit ?? "หน่วย"})</label>
            <input className="input text-lg font-bold" type="number" min="0"
              autoFocus value={qty} placeholder="นับแล้วใส่ตัวเลข"
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveLine(); }} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { setSel(null); setQty(""); }}
              disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm">
              ยกเลิก
            </button>
            <button type="button" onClick={saveLine} disabled={busy}
              className="flex-1 py-2.5 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
              {busy ? "กำลังบันทึก..." : "บันทึกจำนวน"}
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-2">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="ค้นหารายการเพื่อนับด้วยมือ (ไม่ต้องสแกน)" />
        <div className="divide-y divide-slate-100 max-h-[50vh] overflow-y-auto">
          {filtered.map((i) => {
            const c = counted[i.id];
            const isDone = c !== undefined;
            return (
              <button key={i.id} type="button" onClick={() => pick(i)}
                className="w-full text-left py-2 flex items-center justify-between gap-2 hover:bg-slate-50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      i.pick_freq ? PICK_FREQ_META[i.pick_freq].chip : "bg-slate-100 text-slate-500"}`}>
                      {binCode(i.grid_row, i.grid_col, i.pick_freq) || "—"}
                    </span>
                    <span className="font-medium text-slate-800 truncate">{i.name}</span>
                  </div>
                </div>
                <div className="flex-shrink-0 text-sm">
                  {isDone
                    ? <span className="text-emerald-600 font-bold">นับแล้ว · {c}</span>
                    : <span className="text-slate-400">ยังไม่นับ</span>}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="py-6 text-center text-slate-400 text-sm">ไม่พบรายการ</div>
          )}
        </div>
      </div>

      {scanCam && (
        <BarcodeScanner
          title="สแกนคิวอาร์โค้ดเพื่อนับ"
          onResult={(code) => resolveBarcode(code)}
          onClose={() => setScanCam(false)}
        />
      )}
    </>
  );
}
