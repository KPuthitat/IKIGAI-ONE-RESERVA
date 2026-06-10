"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Per-branch INVENTA label print size (owner 2026-06-08). The labels page
// sizes each printed sticker + the @page rule to these mm values. Default
// 80×50 mm (common thermal sticker).
//
// N2 (owner 2026-06-10): the card is collapsible (matches the rest of the
// settings page) and shows a LIVE representative label preview — sample
// content (QR + name + bin + ราคาทุน/ราคาขาย) scaled to the chosen mm so
// the owner can see whether everything fits before printing.
export default function LabelSizeForm({
  widthMm, heightMm
}: { widthMm: number; heightMm: number }) {
  const router = useRouter();
  const [w, setW] = useState(String(widthMm));
  const [h, setH] = useState(String(heightMm));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const wn = Number(w), hn = Number(h);
  const valid = Number.isInteger(wn) && Number.isInteger(hn) &&
    wn >= 20 && wn <= 200 && hn >= 20 && hn <= 200;
  const pristine = wn === widthMm && hn === heightMm;

  async function save() {
    if (!valid) { setMsg({ kind: "err", text: "ขนาดต้องเป็น 20–200 mm" }); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/inventa/settings/label-size"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width_mm: wn, height_mm: hn })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: "บันทึกไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <details className="card !p-0 overflow-hidden group" open>
      <summary className="cursor-pointer list-none select-none flex items-center justify-between px-4 py-3 hover:bg-slate-50">
        <span className="font-bold text-slate-800">
          ขนาดฉลากพิมพ์ (QR + บาร์โค้ด)
          <span className="ml-2 text-xs font-normal text-slate-400">{widthMm}×{heightMm} mm</span>
        </span>
        <span className="text-slate-400 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-4 pt-2 space-y-3 border-t border-slate-100">
        <p className="text-xs text-slate-500">
          กำหนดขนาดสติกเกอร์ที่จะสั่งพิมพ์จากหน้า <b>สร้างคิวอาร์โค้ด</b> ·
          ค่าเริ่มต้น <b>80 × 50 mm</b> (ปรับให้ตรงกับสติกเกอร์/เครื่องพิมพ์ของคุณ)
        </p>
        <div className="flex flex-wrap items-start gap-5">
          <div className="flex items-end gap-2">
            <div>
              <label className="label">กว้าง (mm)</label>
              <input className="input text-sm !w-24" inputMode="numeric" value={w}
                onChange={(e) => { setW(e.target.value.replace(/[^\d]/g, "")); setMsg(null); }} />
            </div>
            <span className="text-slate-400 pb-2">×</span>
            <div>
              <label className="label">สูง (mm)</label>
              <input className="input text-sm !w-24" inputMode="numeric" value={h}
                onChange={(e) => { setH(e.target.value.replace(/[^\d]/g, "")); setMsg(null); }} />
            </div>
          </div>
          {valid && (
            <div className="space-y-1">
              <div className="text-[11px] text-slate-400">ตัวอย่างฉลาก (สด)</div>
              <LabelPreview wn={wn} hn={hn} />
              <div className="text-[10px] text-slate-400 text-center">{wn} × {hn} mm</div>
            </div>
          )}
        </div>
        {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
        <button type="button" onClick={save} disabled={busy || pristine || !valid}
          className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </details>
  );
}

// Representative sticker mockup, scaled from mm → px. Not the exact print
// layout (that lives in the labels page) — just enough sample content to
// judge whether name + QR + prices fit at the chosen size.
function LabelPreview({ wn, hn }: { wn: number; hn: number }) {
  // Fit the preview inside roughly a 300×210 px box.
  const scale = Math.min(3.4, 300 / wn, 210 / hn);
  const px = (mm: number) => Math.round(mm * scale);
  const W = px(wn), H = px(hn);
  // QR square ~ 78% of the shorter side, capped so very tall/wide
  // stickers still leave room for text.
  const qr = Math.min(Math.round(Math.min(wn, hn) * 0.62 * scale), Math.round(H * 0.7));

  return (
    <div
      className="border border-slate-400 bg-white shadow-sm flex flex-col overflow-hidden"
      style={{ width: W, height: H, padding: Math.max(3, px(2)) }}
    >
      <div className="flex items-stretch gap-1.5 flex-1 min-h-0">
        {/* QR placeholder — a small checker so it reads as a code */}
        <div
          className="flex-shrink-0 border border-slate-300"
          style={{
            width: qr, height: qr,
            backgroundImage: "repeating-conic-gradient(#1e293b 0 25%, #ffffff 0 50%)",
            backgroundSize: "6px 6px"
          }}
          aria-hidden
        />
        <div className="flex-1 min-w-0 flex flex-col justify-between leading-tight">
          <div className="min-w-0">
            <div className="font-bold text-slate-800 truncate" style={{ fontSize: 10 }}>
              พาราเซตามอล 500mg
            </div>
            <div className="text-slate-400 truncate" style={{ fontSize: 8 }}>
              MED-001 · <span className="font-bold text-slate-600">D4R</span>
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-emerald-700 font-semibold truncate" style={{ fontSize: 9 }}>
              ทุน ฿2.50/เม็ด
            </div>
            <div className="text-amber-700 font-semibold truncate" style={{ fontSize: 9 }}>
              ขาย ฿5.00/เม็ด
            </div>
          </div>
        </div>
      </div>
      {/* Barcode strip across the bottom */}
      <div
        className="border-t border-slate-200 mt-1"
        style={{
          height: Math.max(8, px(6)),
          backgroundImage: "repeating-linear-gradient(90deg,#0f172a 0 1px,#ffffff 1px 3px)"
        }}
        aria-hidden
      />
    </div>
  );
}
