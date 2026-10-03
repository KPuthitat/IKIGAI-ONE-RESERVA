"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiUrl } from "@/lib/url";
import type { SpecialDaysOutlook } from "@/lib/salesa-analytics";

// Push the upcoming special-days outlook to the HOD LINE group, with a preview of
// the card (PIN-gated) — owner 2026-09-29, mirrors CompanyReportActions.
export default function SpecialDaysSend(
  { outlook, color, operator, horizonDays }:
  { outlook: SpecialDaysOutlook; color: string; operator: string; horizonDays: number }
) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="btn-primary text-xs px-2.5 py-1 shrink-0">ส่งเข้ากลุ่ม LINE</button>
      {open && (
        <SendPinModal
          preview={<SpecialDaysPreview outlook={outlook} color={color} operator={operator} horizonDays={horizonDays} />}
          onClose={() => setOpen(false)} />
      )}
    </>
  );
}

const baht = (n: number) => `${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
function Pct({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-400">ยังไม่มีประวัติ</span>;
  const up = pct >= 0;
  return <span className={up ? "text-emerald-600" : "text-rose-500"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span>;
}

// HTML mock of salesaSpecialDaysFlex — keep field-for-field in step with it.
function SpecialDaysPreview({ outlook, color, operator, horizonDays }: { outlook: SpecialDaysOutlook; color: string; operator: string; horizonDays: number }) {
  const days = outlook.days.slice(0, 3);
  return (
    <div className="text-sm">
      <div className="px-4 py-3 text-white" style={{ backgroundColor: color }}>
        <div className="text-[10px] opacity-70">NOKHOOK OS · เตรียมรับมือวันสำคัญ</div>
        <div className="font-bold leading-tight">วันสำคัญที่กำลังจะมาถึง</div>
        <div className="text-[11px] opacity-90">{horizonDays} วันข้างหน้า · เตรียมวัตถุดิบ / คน / โปรโมชั่น</div>
      </div>
      <div className="px-4 py-3 space-y-2 bg-white">
        <div className="text-[11px] text-slate-400">คาดการณ์จากประวัติวันหยุด 12 เดือนล่าสุด · สรุปโดย: {operator}</div>
        {days.map((d, i) => (
          <div key={d.date} className={i > 0 ? "pt-2 border-t border-slate-100" : ""}>
            <div className="font-semibold text-slate-800">{d.nameTh}</div>
            <div className="text-[11px] text-slate-400">{d.dateLabel} · อีก {d.daysAway} วัน{d.weekend ? " · เสาร์–อาทิตย์" : ""}</div>
            {d.branches.map((b) => (
              <div key={b.branchId} className="mt-1.5">
                <div className="text-[12px]">
                  <span className="font-semibold text-slate-700">{b.branchName}</span>{" "}
                  {b.expectedUpliftPct != null
                    ? <span className="text-slate-500">คาด <Pct pct={b.expectedUpliftPct} /></span>
                    : <span className="text-slate-400">ยังไม่มีประวัติ</span>}
                  {b.expectedNett != null && <span className="text-slate-400"> · คาดยอด {baht(b.expectedNett)}</span>}
                  {b.basis !== "none" && b.sampleCount > 0 && (
                    <span className="text-slate-300"> · {b.basis === "same-day" ? `จากวันนี้ปีก่อน ${b.sampleCount} ครั้ง` : `อ้างอิงวันหยุดทั่วไป ${b.sampleCount} ครั้ง`}</span>
                  )}
                </div>
                <ul className="mt-0.5 space-y-0.5">
                  {b.suggestions.map((s, k) => (
                    <li key={k} className="text-[11px] text-slate-600 leading-snug">• {s}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SendPinModal({ preview, onClose }: { preview: React.ReactNode; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }
    setSending(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/special-days/notify"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { setDone(true); setTimeout(onClose, 1200); return; }
      const e = j?.error as string | undefined;
      setErr(j?.message ?? (
        e === "wrong_pin" || e === "pin_invalid" ? "PIN ไม่ถูกต้อง"
        : e === "no_pin" ? "ยังไม่ได้ตั้ง PIN (ตั้งที่หน้าโปรไฟล์)"
        : e === "user_not_found" ? "ไม่พบผู้ใช้ ลองเข้าสู่ระบบใหม่"
        : "ส่งไม่สำเร็จ"));
    } catch { setErr("เชื่อมต่อไม่ได้"); }
    finally { setSending(false); }
  }

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-bold text-slate-800">ส่งวันสำคัญที่กำลังจะมาถึง</div>
        {done ? (
          <p className="text-emerald-600 text-sm font-medium py-4 text-center">✓ ส่งเข้ากลุ่ม LINE แล้ว</p>
        ) : (
          <>
            <div>
              <p className="text-xs text-slate-400 mb-1.5">ตัวอย่างรายงานที่จะส่งเข้ากลุ่ม LINE</p>
              <div className="rounded-xl overflow-hidden shadow-sm border border-slate-100">{preview}</div>
            </div>
            <p className="text-sm text-slate-500">ยืนยันด้วย PIN เพื่อส่งรายงานวันสำคัญที่กำลังจะมาถึงเข้ากลุ่ม LINE หัวหน้างาน</p>
            <div>
              <label className="label text-center">PIN (4 หลัก)</label>
              <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
                onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                className="input text-center tracking-[0.5em] text-lg" />
            </div>
            {err && <p className="text-rose-600 text-xs font-medium">✗ {err}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-slate-600 text-sm">ยกเลิก</button>
              <button type="button" onClick={submit} disabled={sending || pin.length < 4}
                className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">
                {sending ? "กำลังส่ง…" : "ยืนยันส่ง"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
