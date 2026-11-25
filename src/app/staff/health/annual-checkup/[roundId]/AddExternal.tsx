"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// "เพิ่มผู้รับการตรวจภายนอก": a person of a paying company with no account. Never mixed with staff. ID: only the last 4 characters.
export default function AddExternal({ roundId, payers }: { roundId: number; payers: Array<{ id: number; name: string }> }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [v, setV] = useState({ payerId: payers[0]?.id ?? 0, title: "", firstName: "", lastName: "", dob: "", phone: "", idLast4: "", code: "", pdpa: false });
  const set = (k: keyof typeof v, x: string | number | boolean) => setV((o) => ({ ...o, [k]: x }));
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/annual-checkup/external/add"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        roundId, payerId: Number(v.payerId), title: v.title || null, firstName: v.firstName.trim(), lastName: v.lastName.trim(), dob: v.dob || null, phone: v.phone || null,
        idLast4: v.idLast4 || null, sponsorEmployeeCode: v.code || null, pdpa: v.pdpa
      }) });
      const j = await r.json();
      if (!j.ok) { setMsg({ ok: false, text: j.message ?? j.error }); return; }
      setMsg({ ok: true, text: j.created ? `เพิ่มแล้ว${j.examCode ? ` · รหัสตรวจ ${j.examCode}` : ""} · ${j.ordersAdded} รายการตรวจ` : "มีคนนี้ในรอบแล้ว (ชื่อและบริษัทตรงกัน) ไม่เพิ่มซ้ำ" });
      if (j.created) { setV((o) => ({ ...o, title: "", firstName: "", lastName: "", dob: "", phone: "", idLast4: "", code: "", pdpa: false })); router.refresh(); }
    } catch { setMsg({ ok: false, text: "เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง" }); }
    finally { setBusy(false); }
  };
  if (payers.length === 0) return null;
  return (
    <div className="card space-y-3">
      <button type="button" className="btn-secondary text-sm min-h-[44px] px-4" onClick={() => setOpen(!open)}>{open ? "ปิด" : "เพิ่มผู้รับการตรวจภายนอก"}</button>
      {open && (
        <div className="grid gap-3 sm:grid-cols-2 text-sm">
          <label className="block sm:col-span-2"><span className="label">บริษัทผู้จ่าย</span>
            <select className="input w-full min-h-[44px]" value={v.payerId} onChange={(e) => set("payerId", Number(e.target.value))}>{payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="block"><span className="label">คำนำหน้า</span><input className="input w-full min-h-[44px]" value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="นาย / นาง / นางสาว" /></label>
          <label className="block"><span className="label">วันเกิด</span><input type="date" className="input w-full min-h-[44px]" value={v.dob} onChange={(e) => set("dob", e.target.value)} /></label>
          <label className="block"><span className="label">ชื่อ</span><input className="input w-full min-h-[44px]" value={v.firstName} onChange={(e) => set("firstName", e.target.value)} /></label>
          <label className="block"><span className="label">นามสกุล</span><input className="input w-full min-h-[44px]" value={v.lastName} onChange={(e) => set("lastName", e.target.value)} /></label>
          <label className="block"><span className="label">เบอร์โทร</span><input className="input w-full min-h-[44px]" inputMode="tel" value={v.phone} onChange={(e) => set("phone", e.target.value)} /></label>
          <label className="block"><span className="label">เลขบัตร 4 ตัวท้าย (ใช้ยืนยันตัวตนตอนเปิดผล)</span><input className="input w-full min-h-[44px]" maxLength={4} value={v.idLast4} onChange={(e) => set("idLast4", e.target.value)} /></label>
          <label className="block sm:col-span-2"><span className="label">รหัสพนักงานที่บริษัท (ถ้ามี)</span><input className="input w-full min-h-[44px]" value={v.code} onChange={(e) => set("code", e.target.value)} /></label>
          <label className="flex items-center gap-2 sm:col-span-2 min-h-[44px]"><input type="checkbox" checked={v.pdpa} onChange={(e) => set("pdpa", e.target.checked)} /><span>ผู้รับการตรวจรับทราบประกาศการคุ้มครองข้อมูลส่วนบุคคลแล้ว</span></label>
          <div className="sm:col-span-2"><button type="button" className="btn-primary min-h-[44px] px-4" disabled={busy || !v.firstName.trim()} onClick={save}>{busy ? "กำลังบันทึก…" : "บันทึก"}</button></div>
          <p className="text-xs text-slate-500 sm:col-span-2">ไม่สร้างบัญชีผู้ใช้ ไม่ปนกับรายชื่อพนักงาน ผลตรวจส่งให้ผู้รับการตรวจเท่านั้น บริษัทเห็นเฉพาะสรุปสถานะ เว้นแต่ผู้รับการตรวจยินยอม</p>
        </div>
      )}
      {msg && <div className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</div>}
    </div>
  );
}
