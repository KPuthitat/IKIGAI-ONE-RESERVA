"use client";

import { useState } from "react";
import { post } from "../annual-checkup/shared";

export default function SharePanel({ initial }: { initial: { followup: boolean; values: boolean } }) {
  const [s, setS] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function flip(scope: "followup" | "values") {
    const on = !s[scope];
    setMsg(null);
    const r = await post("me/share", { scope, on });
    if (!r.ok) { setMsg(r.message ?? "บันทึกไม่สำเร็จ"); return; }
    setS({ ...s, [scope]: on });
    setMsg(on ? "บันทึกแล้ว ท่านเปลี่ยนใจได้ทุกเมื่อ" : "ยกเลิกแล้ว ฝ่ายบุคคลจะไม่เห็นอีก");
  }
  return (
    <div className="card p-4 space-y-2">
      <div className="font-semibold text-slate-800">ให้ฝ่ายบุคคลเห็นผลของฉันหรือไม่</div>
      <p className="text-xs text-slate-500">ค่าเริ่มต้นคือไม่ให้เห็น ฝ่ายบุคคลเห็นเพียงจำนวนคนในแต่ละขั้นตอน ท่านเลือกให้เห็นเพิ่มได้ และเปลี่ยนใจได้ทุกเมื่อ ทุกครั้งที่ฝ่ายบุคคลเปิดดูจะแสดงในรายการ "ใครเปิดดูข้อมูลฉัน" ด้านล่าง</p>
      <label className="flex items-start gap-2 min-h-[44px] text-sm"><input type="checkbox" className="mt-1" checked={s.followup} onChange={() => flip("followup")} /> <span>ให้เห็นว่าฉันอยู่ในรายชื่อที่ต้องติดตาม (ชื่อและภาพรวมเท่านั้น ไม่เห็นค่า)</span></label>
      <label className="flex items-start gap-2 min-h-[44px] text-sm"><input type="checkbox" className="mt-1" checked={s.values} onChange={() => flip("values")} /> <span>ให้เปิดดูผลตรวจของฉันได้ (เห็นค่าทั้งหมดในเล่มผล)</span></label>
      {msg && <div role="status" className="text-xs text-emerald-700">{msg}</div>}
    </div>
  );
}
