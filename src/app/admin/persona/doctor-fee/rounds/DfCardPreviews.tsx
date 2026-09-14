"use client";

// Visual mocks of the doctor DF LINE cards (mirror dfDoctorDailyFlex /
// dfDoctorWeeklyFlex) so the operator sees exactly what lands in the doctor's
// LINE before sending (owner 2026-09-13: พรีวิวการ์ดก่อนกดส่ง, เหมือนจ้อจี้).

import { useState } from "react";
import { fmtMoney } from "@/lib/format";

const baht = (n: number) => `${fmtMoney(n)} บาท`;

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="w-full rounded-[18px] overflow-hidden bg-white shadow-lg ring-1 ring-black/5">
      <div className="px-5 py-4" style={{ backgroundColor: "#0e2724" }}>
        <div className="text-[10px]" style={{ color: "#7fd1bd" }}>IKIGAI OS · ค่าตอบแทนแพทย์</div>
        <div className="text-lg font-bold text-white leading-tight mt-0.5">{title}</div>
        <div className="text-[11px]" style={{ color: "#a9cfc6" }}>{subtitle}</div>
      </div>
      <div className="px-5 py-4 space-y-2">{children}</div>
    </div>
  );
}
function Row({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[13px] text-slate-500">{label}</span>
      <span className={`text-[13px] tabular-nums whitespace-nowrap ${bold ? "font-bold" : ""}`} style={color ? { color } : undefined}>{value}</span>
    </div>
  );
}

export type DailyPreviewData = {
  doctorName: string; clinicName: string; dateLabel: string;
  perCode: Array<{ code: string; share: number; bills: number }>;
  patients: number; doctorCount: number; dayShare: number;
  weekLabel: string; weekAccum: number; monthLabel: string; monthAccum: number;
};
export function DfDailyPreview(d: DailyPreviewData) {
  return (
    <Shell title="สรุปค่าตอบแทนแพทย์ (DF)" subtitle={`ประจำวัน · ${d.dateLabel}`}>
      <div className="text-[15px] font-bold text-slate-800 leading-tight">{d.doctorName}</div>
      <div className="text-[10px] text-slate-400">คลินิก: {d.clinicName}</div>
      <div className="border-t border-slate-100 my-1" />
      <div className="text-[10px] text-slate-400">รายการค่าตอบแทน (DF) วันนี้</div>
      {d.perCode.length === 0
        ? <div className="text-[12px] text-slate-400">— ไม่มีรายการที่คิด DF —</div>
        : d.perCode.map((c) => <Row key={c.code} label={`[${c.code}] · ${c.bills} บิล`} value={baht(c.share)} />)}
      {d.doctorCount > 1 && <div className="text-[10px] text-slate-400">แบ่งกับแพทย์ {d.doctorCount} ท่านในเวรวันนี้ (หารเท่ากัน)</div>}
      <Row label="ตรวจคนไข้วันนี้" value={`${d.patients.toLocaleString("th-TH")} คน`} />
      <div className="border-t border-slate-100 my-1" />
      <Row label="ค่าตอบแทน (DF) ของท่านวันนี้" value={baht(d.dayShare)} bold color="#0f6e56" />
      <div className="border-t border-slate-100 my-1" />
      <div className="text-[10px] text-slate-400">ยอดสะสม</div>
      <Row label={`สัปดาห์นี้ (${d.weekLabel})`} value={baht(d.weekAccum)} bold />
      <Row label={`เดือนนี้ (${d.monthLabel})`} value={baht(d.monthAccum)} bold />
      <div className="text-[9px] text-slate-400 text-center pt-1">ยอดสะสมจะสรุปยอดจ่ายจริงอีกครั้งในรอบจ่ายรายสัปดาห์</div>
    </Shell>
  );
}

export type WeeklyPreviewData = {
  doctorName: string; clinicName: string; weekLabel: string; payDateLabel: string; workedDays: number;
  grossFee: number; whtRate: number; whtAmount: number; netFee: number;
  isGuarantee: boolean; guaranteeHours: number; guaranteeAmount: number; dfEarned: number; deficitBefore: number; deficitAfter: number;
};
export function DfWeeklyPreview(d: WeeklyPreviewData) {
  return (
    <Shell title="สรุปค่าตอบแทนแพทย์ (DF)" subtitle={`ประจำสัปดาห์ · ${d.weekLabel}`}>
      <div className="text-[15px] font-bold text-slate-800 leading-tight">{d.doctorName}</div>
      <div className="text-[10px] text-slate-400">คลินิก: {d.clinicName}</div>
      <div className="border-t border-slate-100 my-1" />
      {d.isGuarantee ? (
        <>
          <Row label="การันตี (เรท × ชม.ตามเวร)" value={`${baht(d.guaranteeAmount)} · ${d.guaranteeHours.toLocaleString("th-TH", { maximumFractionDigits: 1 })} ชม.`} />
          <Row label="DF ที่ทำได้จริง" value={baht(d.dfEarned)} />
          {d.dfEarned >= d.guaranteeAmount && d.deficitBefore > 0 && (
            <Row label="คืนยอดที่คลินิกออกให้ก่อนหน้า" value={"−" + baht(Math.min(d.dfEarned - d.guaranteeAmount, d.deficitBefore))} color="#854f0b" />
          )}
          {d.dfEarned < d.guaranteeAmount && (
            <Row label="คลินิกออกส่วนต่างให้" value={"+" + baht(d.guaranteeAmount - d.dfEarned)} color="#0f6e56" />
          )}
          <Row label="ยอดที่จ่ายสัปดาห์นี้ (ก่อนหักภาษี)" value={baht(d.grossFee)} bold />
          {d.deficitAfter > 0 && <div className="text-[10px] text-amber-700">ยกยอดที่คลินิกออกให้สะสม {baht(d.deficitAfter)}</div>}
        </>
      ) : (
        <>
          <Row label="วันเวรที่มียอด" value={`${d.workedDays} วัน`} />
          <Row label="ค่าตอบแทน (DF) ก่อนหักภาษี" value={baht(d.grossFee)} bold />
        </>
      )}
      {d.whtAmount > 0 && (
        <Row label={`หักภาษี ณ ที่จ่าย ${(d.whtRate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}%`} value={"−" + baht(d.whtAmount)} color="#a32d2d" />
      )}
      <div className="rounded-lg bg-emerald-50 px-3 py-2 mt-1">
        <div className="text-[11px] text-slate-500">โอนสุทธิ · จ่ายวันจันทร์ที่ {d.payDateLabel}</div>
        <div className="text-xl font-bold tabular-nums" style={{ color: "#0f6e56" }}>{baht(d.netFee)}</div>
      </div>
      <div className="text-[9px] text-slate-400 text-center pt-1">เอกสารแจ้งเตือนภายใน ไม่ใช่เอกสารทางภาษี</div>
    </Shell>
  );
}

/** Modal: card preview + PIN, then sends on confirm. */
export function DfSendModal({ heading, preview, onConfirm, onClose }: {
  heading: string;
  preview: React.ReactNode;
  onConfirm: (pin: string) => Promise<{ ok: boolean; message?: string }>;
  onClose: () => void;
}) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  async function submit() {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }
    setSending(true); setErr(null);
    try {
      const r = await onConfirm(pin);
      if (!r.ok) setErr(r.message ?? "ส่งไม่สำเร็จ");
    } finally { setSending(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3 my-8" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">{heading}</h3>
        <p className="text-[11px] text-slate-400">ตัวอย่างข้อความที่แพทย์ท่านนี้จะเห็นใน LINE (ส่งเฉพาะท่านนี้)</p>
        <div className="rounded-2xl bg-slate-100 p-3">{preview}</div>
        <div>
          <label className="label">PIN (4 หลัก) เพื่อยืนยันส่ง</label>
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !sending) void submit(); }}
            className="input font-mono text-center text-2xl tracking-[10px]" />
        </div>
        {err && <p className="text-rose-600 text-xs font-medium">{err === "pin_invalid" || err === "wrong_pin" ? "✗ PIN ไม่ถูกต้อง" : `✗ ${err}`}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={sending} className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium disabled:opacity-50">ยกเลิก</button>
          <button type="button" onClick={submit} disabled={sending || pin.length < 4} className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">{sending ? "กำลังส่ง…" : "ยืนยันส่งให้แพทย์"}</button>
        </div>
      </div>
    </div>
  );
}
