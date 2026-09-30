"use client";

import { useState } from "react";

// REPORTA settings — bind the HOD LINE group id the daily/weekly cards push to
// (owner 2026-09-16). The NOKHOOK OS platform OA must be a member of that group.

const DEFAULT_COLOR = "#0e2724";
const PRESETS = ["#0e2724", "#1e3a5f", "#5b21b6", "#9d174d", "#b45309", "#334155", "#166534", "#7c2d12"];

type Hours = { open: string; close: string; breakStart: string | null; breakEnd: string | null; breakWeekdayOnly: boolean };

export default function ReportaSettingsClient({ initialGroupId, initialTarget, initialMerchant, initialColor, initialOpensOn, initialHours }: { initialGroupId: string | null; initialTarget: number | null; initialMerchant: string | null; initialColor: string | null; initialOpensOn: string | null; initialHours: Hours | null }) {
  const [groupId, setGroupId] = useState(initialGroupId ?? "");
  const [target, setTarget] = useState(initialTarget != null ? String(initialTarget) : "");
  const [merchant, setMerchant] = useState(initialMerchant ?? "");
  const [color, setColor] = useState(initialColor ?? DEFAULT_COLOR);
  const [opensOn, setOpensOn] = useState(initialOpensOn ?? "");
  // Open/close come from RESERVA (branches) — read-only here. ANALYTICA only sets
  // the lunch break for the peak-hours chart (owner 2026-09-27).
  const [breakStartT, setBreakStartT] = useState(initialHours?.breakStart ?? "");
  const [breakEndT, setBreakEndT] = useState(initialHours?.breakEnd ?? "");
  const [breakWeekday, setBreakWeekday] = useState(initialHours?.breakWeekdayOnly ?? true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const save = async () => {
    setSaving(true); setMsg(null);
    const t = target.replace(/[, ]/g, "").trim();
    const targetNum = t === "" ? null : Number(t);
    if (targetNum != null && !Number.isFinite(targetNum)) { setMsg({ kind: "err", text: "เป้ายอดต้องเป็นตัวเลข" }); setSaving(false); return; }
    // Break: both ends, or neither.
    if ((breakStartT && !breakEndT) || (!breakStartT && breakEndT)) { setMsg({ kind: "err", text: "กรอกช่วงพักให้ครบทั้งเริ่มและสิ้นสุด" }); setSaving(false); return; }
    // Only send `break` when it actually changed, so saving an unrelated field
    // never touches (or wipes) a stored break.
    const breakChanged = breakStartT !== (initialHours?.breakStart ?? "") || breakEndT !== (initialHours?.breakEnd ?? "") || breakWeekday !== (initialHours?.breakWeekdayOnly ?? true);
    const brk = { breakStart: breakStartT || null, breakEnd: breakEndT || null, breakWeekdayOnly: breakWeekday };
    try {
      const r = await fetch("/api/admin/reporta/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Only send opensOn when it actually changed — it's the shared
        // branches.opens_on column (also editable in RESERVA), so re-sending an
        // untouched value could revert a concurrent edit there.
        body: JSON.stringify({
          lineGroupId: groupId.trim() || null, monthlyTarget: targetNum, merchantName: merchant.trim() || null, cardColor: color,
          ...(breakChanged ? { break: brk } : {}),
          ...(opensOn !== (initialOpensOn ?? "") ? { opensOn: opensOn || null } : {})
        })
      }).then((x) => x.json());
      if (r.ok) setMsg({ kind: "ok", text: "บันทึกแล้ว" });
      else setMsg({ kind: "err", text: r.error === "bad_hours" ? "ช่วงพักต้องอยู่ในเวลาทำการ" : (r.error ?? "บันทึกไม่สำเร็จ") });
    } catch { setMsg({ kind: "err", text: "บันทึกผิดพลาด" }); }
    setSaving(false);
  };

  return (
    <div className="card space-y-4">
      {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-700"}`}>{msg.text}</div>}
      <div>
        <label className="label">LINE Group ID ของกลุ่มหัวหน้างาน (HOD)</label>
        <input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="เช่น Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" className="input" />
        <p className="text-xs text-slate-500 mt-1.5">
          เพิ่มบัญชี NOKHOOK OS (platform OA) เข้ากลุ่มก่อน แล้วนำ Group ID มาใส่ · เว้นว่างเพื่อปิดการส่ง
        </p>
      </div>
      <div>
        <label className="label">เป้ายอดขายต่อเดือน (บาท)</label>
        <input value={target} onChange={(e) => setTarget(e.target.value)} inputMode="numeric" placeholder="เช่น 500000" className="input !w-48" />
        <p className="text-xs text-slate-500 mt-1.5">
          ใช้แสดงแถบความคืบหน้า + คาดการณ์สิ้นเดือนในหน้าวิเคราะห์ · เว้นว่างเพื่อไม่ตั้งเป้า
        </p>
      </div>
      <div>
        <label className="label">วันเปิดสาขา (วันแรกที่เปิดร้าน)</label>
        <input type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} className="input !w-48" />
        <p className="text-xs text-slate-500 mt-1.5">
          สาขาที่เปิดกลางปีจะถูก<b>เฉลี่ยเป้าทั้งปี</b>และ<b>คาดการณ์รายได้</b>จากวันนี้ ไม่ใช่ทั้งปีเต็ม · ใช้ค่าเดียวกับ RESERVA (ตั้งที่ไหนก็ได้) · เว้นว่าง = ถือว่าเปิดมาทั้งปี
        </p>
      </div>
      <div>
        <label className="label">ชื่อร้านใน POS (Merchant) — กันไฟล์ผิดสาขา</label>
        <input value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder="ปกติเว้นว่าง (ใช้ชื่อสาขา)" className="input" />
        <p className="text-xs text-slate-500 mt-1.5">
          ปกติระบบเทียบกับ<b>ชื่อสาขา</b>ให้อัตโนมัติ — ถ้านำเข้าไฟล์ที่ชื่อร้านไม่ตรง จะถูกปฏิเสธทั้งชุด · กรอกที่นี่<b>เฉพาะเมื่อ</b>ชื่อร้านใน POS ต่างจากชื่อสาขา · เว้นว่าง = ใช้ชื่อสาขา
        </p>
      </div>
      <div>
        <label className="label">สีการ์ดของสาขานี้ (หัวการ์ด LINE)</label>
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)}
              className={`h-8 w-8 rounded-full border-2 ${color.toLowerCase() === c ? "border-slate-800 ring-2 ring-offset-1 ring-slate-300" : "border-white shadow"}`}
              style={{ backgroundColor: c }} aria-label={c} />
          ))}
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-8 w-10 rounded border border-slate-200 bg-white p-0.5" />
        </div>
        {/* Live preview of the LINE card header */}
        <div className="mt-2 rounded-xl overflow-hidden max-w-xs shadow-sm">
          <div style={{ backgroundColor: color }} className="px-4 py-3">
            <div className="text-[10px]" style={{ color: "#ffffff99" }}>NOKHOOK OS · ยอดขายรายวัน</div>
            <div className="text-white font-bold">สรุปยอดขายประจำวัน</div>
            <div className="text-xs" style={{ color: "#ffffffcc" }}>ตัวอย่างหัวการ์ดของสาขานี้</div>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-1.5">แนะนำสีเข้มเพื่อให้ตัวอักษรสีขาวอ่านง่าย · แต่ละสาขาตั้งคนละสีได้ ระบบจำไว้ให้</p>
      </div>
      <div>
        <label className="label">เวลาทำการ (กราฟช่วงเวลาที่ลูกค้า/คนไข้เข้ามาก จะตรึงแกนตามนี้)</label>
        <div className="flex items-center gap-2 flex-wrap text-sm">
          <span className="inline-flex items-center rounded-lg bg-slate-100 px-3 py-1.5 font-semibold text-slate-700 tabular-nums">
            {initialHours ? `${initialHours.open}–${initialHours.close}` : "ยังไม่ได้ตั้ง"}
          </span>
          <span className="text-xs text-slate-500">ดึงจาก RESERVA อัตโนมัติ · <a href="/admin/reserva/settings" className="underline text-brand">แก้เวลาเปิด–ปิดที่ RESERVA</a></span>
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500">พักช่วง (ถ้ามี)</span>
          <input type="time" value={breakStartT} onChange={(e) => setBreakStartT(e.target.value)} className="input !w-28" aria-label="พักเริ่ม" />
          <span className="text-slate-400">–</span>
          <input type="time" value={breakEndT} onChange={(e) => setBreakEndT(e.target.value)} className="input !w-28" aria-label="พักถึง" />
          <label className="flex items-center gap-1.5 text-xs text-slate-600 ml-1">
            <input type="checkbox" checked={breakWeekday} onChange={(e) => setBreakWeekday(e.target.checked)} />
            พักเฉพาะวันธรรมดา (เสาร์–อาทิตย์ ไม่พัก)
          </label>
        </div>
        <p className="text-xs text-slate-500 mt-1.5">
          เวลาเปิด–ปิด<b>ใช้ค่าเดียวกับ RESERVA</b> (คลินิก 09:00–21:00 ตามใบอนุญาต สพ.7/สพ.19 · ร้านอาหาร 11:00–21:00) · ช่วง<b>พัก</b>ตั้งที่นี่ (RESERVA ไม่มี) เช่น 14:00–16:00 (จ–ศ) · เว้นพักว่าง = ไม่มีพัก
        </p>
      </div>
      <button onClick={save} disabled={saving} className="btn-primary text-sm disabled:opacity-50">{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
    </div>
  );
}
