"use client";

import { useState, type ReactNode } from "react";
import { apiUrl } from "@/lib/url";
import type { CompanyOverview } from "@/lib/salesa-analytics";

// Download the company overview as a PDF, or push its summary card to the HOD
// LINE group (PIN-gated, with a preview of the card) — owner 2026-09-25.
export default function CompanyReportActions(
  { year, month, companyName, monthLabel, operator, color, overview }:
  { year: number; month: number; companyName: string; monthLabel: string; operator: string; color: string; overview: CompanyOverview }
) {
  const [open, setOpen] = useState(false);
  const pdfHref = apiUrl(`/api/admin/reporta/company/pdf?year=${year}&month=${month}`);

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
      <a href={pdfHref} target="_blank" rel="noopener noreferrer"
        className="btn-secondary text-sm px-3 py-1.5 text-center">ดาวน์โหลด PDF</a>
      <button type="button" onClick={() => setOpen(true)}
        className="btn-primary text-sm px-3 py-1.5">ส่งการ์ดเข้ากลุ่ม HOD</button>
      {open && (
        <SendPinModal year={year} month={month}
          preview={<CompanyCardPreview ov={overview} companyName={companyName} monthLabel={monthLabel} operator={operator} color={color} />}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

// Match salesaCompanyFlex's number formatting exactly (2 decimals, th-TH).
const baht = (n: number) => `${n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
function Pct({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-400">—</span>;
  const up = pct >= 0;
  return <span className={up ? "text-emerald-600" : "text-rose-500"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span>;
}

// An HTML mock of the LINE Flex card (salesaCompanyFlex) so the sender sees what
// goes to the group before confirming. Kept field-for-field in step with that
// builder — update both together.
function CompanyCardPreview({ ov, companyName, monthLabel, operator, color }: { ov: CompanyOverview; companyName: string; monthLabel: string; operator: string; color: string }) {
  const t = ov.total;
  const branches = [...ov.branches].sort((a, b) => b.mtdNett - a.mtdNett);
  return (
    <div className="text-sm">
      <div className="px-4 py-3 text-white" style={{ backgroundColor: color }}>
        <div className="text-[10px] opacity-70">IKIGAI OS · ภาพรวมบริษัท</div>
        <div className="font-bold leading-tight">{companyName}</div>
        <div className="text-[11px] opacity-90">รวมทุกสาขา · {monthLabel}</div>
      </div>
      <div className="px-4 py-3 space-y-1.5 bg-white">
        <div className="text-[11px] text-slate-400">รวม {ov.branchCount} สาขา · สรุปโดย: {operator}</div>
        <div className="flex justify-between gap-2">
          <span className="text-slate-500">ยอดขายรวม (วันที่ 1–{ov.throughDay})</span>
          <span className="font-bold text-emerald-700">{baht(t.mtdNett)}</span>
        </div>
        <div className="text-[11px] text-slate-500">เทียบเดือนก่อน <Pct pct={t.momPct} />{t.prevSameNett != null && <span className="text-slate-400"> ({baht(t.prevSameNett)})</span>}</div>
        <div className="flex justify-between gap-2 text-[12px] text-slate-600"><span>จำนวนบิลรวม</span><span>{t.bills.toLocaleString("th-TH")} บิล</span></div>
        <div className="flex justify-between gap-2 text-[12px] text-slate-600"><span>ลูกค้ารวม</span><span>{t.pax.toLocaleString("th-TH")} คน</span></div>
        {ov.isCurrentMonth && t.todayNett != null && (
          <div className="flex justify-between gap-2 text-[12px] text-slate-600"><span>ยอดขายวันนี้ (รวมสาขา)</span><span>{baht(t.todayNett)}</span></div>
        )}
        {ov.target && (
          <div className="pt-1 border-t border-slate-100 space-y-0.5">
            <div className="flex justify-between gap-2 text-[12px] text-slate-600"><span>เป้ารายเดือนรวม ({ov.targetedBranchCount} สาขา)</span><span>{baht(ov.target.target)}</span></div>
            <div className="text-[11px] text-slate-500">ทำได้ <b className={ov.target.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}>{ov.target.pctOfTarget.toFixed(0)}% ของเป้า</b> · คาดสิ้นเดือน <b className={ov.target.onTrack ? "text-emerald-600" : "text-amber-600"}>{baht(ov.target.projectedNett)} ({ov.target.projectedPct.toFixed(0)}%)</b></div>
          </div>
        )}
        {ov.annual && (
          <>
            <div className="flex justify-between gap-2 text-[12px] text-slate-600"><span>เป้าทั้งปี {ov.annual.year + 543}</span><span>{baht(ov.annual.annualTarget)}</span></div>
            <div className="text-[11px] text-slate-500">YTD <b className={ov.annual.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}>{baht(ov.annual.ytdNett)} ({ov.annual.pctOfTarget.toFixed(0)}%)</b> · คาดสิ้นปี <b className={ov.annual.onTrack ? "text-emerald-600" : "text-amber-600"}>{ov.annual.projectedPct.toFixed(0)}%</b></div>
          </>
        )}
        {branches.length > 0 && (
          <div className="pt-1 border-t border-slate-100 space-y-0.5">
            <div className="text-[11px] font-semibold text-slate-600">เทียบรายสาขา</div>
            {branches.map((b) => (
              <div key={b.branchId} className="flex justify-between gap-2 text-[12px]">
                <span className="text-slate-600 truncate">{b.branchName}</span>
                <span className="whitespace-nowrap text-slate-700">{baht(b.mtdNett)} <Pct pct={b.momPct} />{b.pctOfTarget != null && <span className="text-slate-400"> · {b.pctOfTarget.toFixed(0)}% เป้า</span>}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SendPinModal({ year, month, preview, onClose }:
  { year: number; month: number; preview: ReactNode; onClose: () => void }) {
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
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="font-bold text-slate-800">ส่งภาพรวมบริษัทเข้ากลุ่ม HOD</div>
        {done ? (
          <p className="text-emerald-600 text-sm font-medium py-4 text-center">✓ ส่งเข้ากลุ่ม LINE แล้ว</p>
        ) : (
          <>
            <div>
              <p className="text-xs text-slate-400 mb-1.5">ตัวอย่างการ์ดที่จะส่งเข้ากลุ่ม LINE</p>
              <div className="rounded-xl overflow-hidden shadow-sm border border-slate-100">{preview}</div>
            </div>
            <p className="text-sm text-slate-500">ยืนยันด้วย PIN เพื่อส่งการ์ดสรุปรวมทุกสาขาเข้ากลุ่ม LINE หัวหน้างาน</p>
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
    </div>
  );
}
