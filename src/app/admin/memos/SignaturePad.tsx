"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/url";

// Draw a signature with a finger or mouse; it is saved once to the person's profile (PNG) and used every time they sign a memo.
export default function SignaturePad({ current, onSaved, onClose }: { current: string | null; onSaved: () => void; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const c = ref.current!, ctx = c.getContext("2d")!;
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    c.width = c.clientWidth * ratio; c.height = c.clientHeight * ratio;
    ctx.scale(ratio, ratio); ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
  }, []);
  const pos = (e: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { drawing.current = true; ref.current!.setPointerCapture(e.pointerId); const ctx = ref.current!.getContext("2d")!; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.01, p.y + 0.01); ctx.stroke(); setEmpty(false); };
  const move = (e: React.PointerEvent) => { if (!drawing.current) return; const ctx = ref.current!.getContext("2d")!; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const up = () => { drawing.current = false; };
  const clear = () => { const c = ref.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); setEmpty(true); };

  async function save() {
    setBusy(true); setErr(null);
    try {
      const image = ref.current!.toDataURL("image/png");
      const r = await fetch(apiUrl("/api/admin/memos/signature"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setErr(j.message ?? "บันทึกลายเซ็นไม่สำเร็จ"); return; }
      onSaved();
    } catch { setErr("เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง"); } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-3" role="dialog" aria-modal="true" aria-label="ตั้งลายเซ็น">
      <div className="w-full max-w-lg bg-white rounded-2xl p-4 space-y-3 shadow-xl">
        <div className="font-bold text-slate-800">ลายเซ็นของฉัน</div>
        <p className="text-sm text-slate-600">วาดลายเซ็นในกรอบด้านล่าง ระบบเก็บไว้ในโปรไฟล์ของท่านและใช้ทุกครั้งที่ลงลายมือชื่อใน Memo (ทุกครั้งต้องยืนยันด้วย PIN) วาดใหม่เมื่อไรก็ได้</p>
        {current && <div className="text-xs text-slate-500">ลายเซ็นปัจจุบัน: {/* eslint-disable-next-line @next/next/no-img-element */}<img src={current} alt="ลายเซ็นปัจจุบัน" className="inline-block h-10 align-middle border border-slate-200 rounded bg-white ml-1" /></div>}
        <canvas ref={ref} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} className="w-full h-44 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 touch-none" aria-label="พื้นที่วาดลายเซ็น" />
        {err && <div role="alert" className="text-sm text-rose-700">{err}</div>}
        <div className="flex flex-wrap gap-2 justify-end">
          <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={clear}>ล้าง</button>
          <button type="button" className="btn-secondary min-h-[44px] px-4" onClick={onClose}>ปิด</button>
          <button type="button" className="btn-primary min-h-[44px] px-5" disabled={busy || empty} onClick={save}>{busy ? "กำลังบันทึก…" : "บันทึกลายเซ็น"}</button>
        </div>
      </div>
    </div>
  );
}
