"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Per-branch INVENTA label print size (owner 2026-06-08). The labels page
// sizes each printed sticker + the @page rule to these mm values. Default
// 80×50 mm (common thermal sticker).
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

  // Scaled preview (cap the longest side so big sizes don't overflow).
  const scale = valid ? Math.min(2.6, 130 / Math.max(wn, hn)) : 0;

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">ขนาดฉลากพิมพ์ (QR + บาร์โค้ด)</h2>
        <p className="text-xs text-slate-500 mt-1">
          กำหนดขนาดสติกเกอร์ที่จะสั่งพิมพ์จากหน้า <b>สร้างคิวอาร์โค้ด</b> ·
          ค่าเริ่มต้น <b>80 × 50 mm</b> (ปรับให้ตรงกับสติกเกอร์/เครื่องพิมพ์ของคุณ)
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
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
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <div className="border-2 border-dashed border-slate-300 rounded bg-slate-50 flex items-center justify-center text-slate-400"
              style={{ width: `${wn * scale}px`, height: `${hn * scale}px` }}>
              {wn}×{hn}
            </div>
            <span>ตัวอย่างสัดส่วน</span>
          </div>
        )}
      </div>
      {msg && <p className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
      <button type="button" onClick={save} disabled={busy || pristine || !valid}
        className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
        {busy ? "กำลังบันทึก…" : "บันทึก"}
      </button>
    </div>
  );
}
