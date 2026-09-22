"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";

// Download the company overview as a PDF, or push its summary card to the HOD
// LINE group (PIN-gated) — owner 2026-09-25. Mirrors the per-branch REPORTA send.
export default function CompanyReportActions({ year, month }: { year: number; month: number }) {
  const [open, setOpen] = useState(false);
  const pdfHref = apiUrl(`/api/admin/reporta/company/pdf?year=${year}&month=${month}`);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <a href={pdfHref} target="_blank" rel="noopener noreferrer"
        className="btn-secondary text-sm px-3 py-1.5">ดาวน์โหลด PDF</a>
      <button type="button" onClick={() => setOpen(true)}
        className="btn-primary text-sm px-3 py-1.5">ส่งการ์ดเข้ากลุ่ม HOD</button>
      {open && <SendPinModal year={year} month={month} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SendPinModal({ year, month, onClose }: { year: number; month: number; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }
    setSending(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/reporta/company/notify"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, month, pin })
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="font-bold text-slate-800">ส่งภาพรวมบริษัทเข้ากลุ่ม HOD</div>
        {done ? (
          <p className="text-emerald-600 text-sm font-medium py-4 text-center">✓ ส่งเข้ากลุ่ม LINE แล้ว</p>
        ) : (
          <>
            <p className="text-sm text-slate-500">ยืนยันด้วย PIN เพื่อส่งการ์ดสรุปรวมทุกสาขาเข้ากลุ่ม LINE หัวหน้างาน</p>
            <div>
              <label className="label text-center">PIN (4 หลัก)</label>
              <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
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
    </div>
  );
}
