"use client";

import { Fragment, useRef, useState } from "react";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";
import { humanizeApiError } from "@/lib/error-messages";
import type { DfMonthView, DfMonthWeek, DfDayLine } from "@/lib/df-rounds";
import type { DfDoctor } from "@/lib/df-db";

// Doctor-Fee rounds — revshare-style month view (owner 2026-09-13): import a
// daily report, the month lists each day's DF grouped into Mon–Sun rounds, and
// each week is cut + paid (transfers to the doctors + posts to accounta) the
// following Monday. Mirrors /admin/accounta/revshare/rounds.

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const TH_MON = ["", "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function thDate(iso: string): string { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_MON[m]} ${y + 543}`; }
function weekLabel(a: string, b: string): string {
  const [, am, ad] = a.split("-").map(Number); const [by, bm, bd] = b.split("-").map(Number);
  return `${ad}${am === bm ? "" : ` ${TH_MON[am]}`}–${bd} ${TH_MON[bm]} ${by + 543}`;
}

type PinAction =
  | { kind: "pay" | "revert"; week: string; label: string }
  | { kind: "set_wht"; userId: number; rate: number; label: string };

export default function DoctorFeeRoundsClient({ view: initialView, doctors: initialDoctors }: { view: DfMonthView; doctors: DfDoctor[] }) {
  const [view, setView] = useState(initialView);
  const [doctors, setDoctors] = useState(initialDoctors);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState<PinAction | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showWht, setShowWht] = useState(false);
  const [dayOpen, setDayOpen] = useState<Set<string>>(new Set());
  const [dayLines, setDayLines] = useState<Record<string, DfDayLine[]>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  async function toggleDay(date: string) {
    setDayOpen((p) => { const n = new Set(p); if (n.has(date)) n.delete(date); else n.add(date); return n; });
    if (!dayLines[date]) {
      try {
        const r = await fetch(apiUrl(`/api/admin/persona/doctor-fee/rounds?day=${date}`));
        const j = await r.json();
        if (r.ok && j.ok) setDayLines((p) => ({ ...p, [date]: j.lines as DfDayLine[] }));
      } catch { /* ignore — the row just shows nothing */ }
    }
  }

  async function loadMonth(year: number, month: number) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl(`/api/admin/persona/doctor-fee/rounds?year=${year}&month=${month}`));
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "error");
      setView(j.view); setDoctors(j.doctors);
    } catch (e) { setMsg({ kind: "err", text: errText(e) }); }
    finally { setBusy(false); }
  }
  const shift = (delta: number) => {
    let y = view.year, m = view.month + delta;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    loadMonth(y, m);
  };

  async function importFile(file: File) {
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch(apiUrl("/api/admin/persona/doctor-fee/import"), { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg({ kind: "err", text: humanizeApiError(j, "นำเข้าไฟล์ไม่สำเร็จ") }); return; }
      setMsg({ kind: "ok", text: `นำเข้าแล้ว ${j.total} รายการ (${j.inserted} ใหม่ · ${j.updated} อัปเดต)` });
      await loadMonth(view.year, view.month);
    } catch { setMsg({ kind: "err", text: "นำเข้าไฟล์ไม่สำเร็จ" }); }
    finally { setBusy(false); }
  }

  async function runPin() {
    if (!pending || pin.length < 4) return;
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { action: pending.kind, pin, year: view.year, month: view.month };
      if (pending.kind === "set_wht") { body.userId = pending.userId; body.rate = pending.rate; }
      else body.week = pending.week;
      const r = await fetch(apiUrl("/api/admin/persona/doctor-fee/rounds"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "error");
      setView(j.view); setDoctors(j.doctors);
      setMsg({ kind: "ok", text: pending.kind === "pay" ? "ตัดรอบ + จ่าย + ลงบัญชีแล้ว" : pending.kind === "revert" ? "ยกเลิกการจ่ายแล้ว" : "บันทึกอัตราภาษีแล้ว" });
      setPending(null); setPin("");
    } catch (e) { setMsg({ kind: "err", text: errText(e) }); }
    finally { setBusy(false); }
  }

  const toggle = (wk: string) => setExpanded((p) => { const n = new Set(p); if (n.has(wk)) n.delete(wk); else n.add(wk); return n; });

  return (
    <div className="space-y-4">
      {/* Month navigator */}
      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
        <span className="text-sm font-bold text-slate-700">{TH_MONTHS[view.month]} {view.year + 543}</span>
        <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
      </div>

      {/* Workflow bar */}
      <div className="card text-[11px] text-slate-500">
        จังหวะการทำงาน: <b className="text-slate-700">นำเข้าไฟล์รายงานประจำวัน</b> → ระบบรวม <b className="text-slate-700">รอบจ่ายรายสัปดาห์</b> (จ–อา) ให้อัตโนมัติ → <b className="text-slate-700">ตัดรอบ + จ่าย</b> ในจันทร์ถัดไป แล้วลงบัญชี accounta
      </div>

      {/* Import card */}
      <div className="card flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }} disabled={busy} />
        <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "กำลังทำงาน…" : "นำเข้าไฟล์รายงานประจำวัน"}
        </button>
        <span className="text-[11px] text-slate-400">โปรแกรมจับรายการ DF ตามกฎ (ตั้งกฎที่หน้า “ค่าตอบแทนแพทย์”) · นำเข้าซ้ำได้ ระบบอัปเดตให้เอง</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setShowWht((s) => !s)} className="rounded-md border border-brand text-brand px-3 py-2 text-xs font-bold hover:bg-brand/5">
          อัตราภาษีหัก ณ ที่จ่าย (แยกตามแพทย์)
        </button>
      </div>

      {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</div>}

      {showWht && (
        <div className="card space-y-2">
          <div className="text-sm font-semibold text-slate-700">อัตราภาษีหัก ณ ที่จ่าย · แยกตามแพทย์</div>
          <p className="text-[11px] text-slate-400">เปอร์เซ็นต์ที่หักตอนโอน (เช่น 3 = ภ.ง.ด.53) · 0 = ไม่หัก · มีผลกับรอบที่ยังไม่ตัด</p>
          {doctors.map((d) => (
            <WhtRow key={d.user_id} doctor={d} disabled={busy}
              onSave={(rate) => setPending({ kind: "set_wht", userId: d.user_id, rate, label: `${d.title_prefix ?? ""}${d.display_name}` })} />
          ))}
        </div>
      )}

      {/* Daily entries grouped by week (weekly round) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ยอด DF รายวัน + รอบจ่ายรายสัปดาห์</div>
        {view.weeks.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูลเดือนนี้ — กด “นำเข้าไฟล์รายงานประจำวัน” ด้านบน</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">วันที่</th>
                <th className="text-right py-1.5 px-2">ยอดค่าตรวจ</th>
                <th className="text-right py-1.5 px-2">DF</th>
                <th className="text-left py-1.5 px-2">ที่มา</th>
                <th></th>
              </tr></thead>
              <tbody>
                {view.weeks.map((w) => (
                  <Fragment key={w.weekStart}>
                    {w.days.map((d) => (
                      <Fragment key={d.date}>
                        <tr className="border-b border-slate-50 hover:bg-slate-50/50 cursor-pointer" onClick={() => toggleDay(d.date)}>
                          <td className="py-1 px-2 text-slate-600 whitespace-nowrap">
                            <span className="text-slate-300 mr-1">{dayOpen.has(d.date) ? "▾" : "▸"}</span>{thDate(d.date)}
                          </td>
                          <td className="py-1 px-2 text-right tabular-nums text-slate-500">฿{fmtMoney(d.pool)}</td>
                          <td className="py-1 px-2 text-right tabular-nums font-medium text-slate-700">฿{fmtMoney(d.fee)}</td>
                          <td className="py-1 px-2 text-[11px] text-slate-400">นำเข้าไฟล์{d.bills > 0 && <span className="text-slate-500"> · {d.bills} บิล</span>}</td>
                          <td></td>
                        </tr>
                        {dayOpen.has(d.date) && (
                          <tr><td colSpan={5} className="bg-slate-50/60 px-2 py-2"><DayDetail lines={dayLines[d.date]} /></td></tr>
                        )}
                      </Fragment>
                    ))}
                    <WeekRow w={w} expanded={expanded.has(w.weekStart)} busy={busy}
                      onToggle={() => toggle(w.weekStart)}
                      onPay={() => setPending({ kind: "pay", week: w.weekStart, label: weekLabel(w.weekStart, w.weekEnd) })}
                      onRevert={() => setPending({ kind: "revert", week: w.weekStart, label: weekLabel(w.weekStart, w.weekEnd) })} />
                    {expanded.has(w.weekStart) && (
                      <tr><td colSpan={5} className="bg-slate-50/60 px-2 py-2">
                        <DoctorTable w={w} />
                      </td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-300 font-bold">
                <td className="py-1.5 px-2 text-slate-700">รวมทั้งเดือน</td>
                <td className="py-1.5 px-2 text-right tabular-nums">฿{fmtMoney(view.monthRevenue)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums">฿{fmtMoney(view.monthFee)}</td>
                <td colSpan={2} className="py-1.5 px-2 text-[11px] text-slate-400">{view.monthBills} บิล · จ่ายเป็นรายสัปดาห์</td>
              </tr></tfoot>
            </table>
          </div>
        )}
      </div>

      {/* PIN modal */}
      {pending && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setPending(null); setPin(""); } }}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-5 space-y-3">
            <h3 className="font-semibold text-slate-800">ยืนยันด้วย PIN</h3>
            <p className="text-sm text-slate-500">
              {pending.kind === "set_wht"
                ? `ตั้งอัตราภาษีหัก ${(pending.rate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}% สำหรับ ${pending.label}`
                : pending.kind === "pay" ? `ตัดรอบ + จ่าย + ลงบัญชี สัปดาห์ ${pending.label}`
                : `ยกเลิกการจ่ายรอบ ${pending.label} (ลบรายการในบัญชีด้วย)`}
            </p>
            <input type="password" inputMode="numeric" autoFocus maxLength={4} className="input w-full text-center tracking-[0.5em] text-lg"
              value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(e) => { if (e.key === "Enter") runPin(); }} placeholder="••••" />
            <div className="flex gap-2">
              <button type="button" className="btn-secondary flex-1" onClick={() => { setPending(null); setPin(""); }}>ยกเลิก</button>
              <button type="button" className="btn-primary flex-1" disabled={busy || pin.length < 4} onClick={runPin}>ยืนยัน</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function WeekRow({ w, expanded, busy, onToggle, onPay, onRevert }: {
  w: DfMonthWeek; expanded: boolean; busy: boolean; onToggle: () => void; onPay: () => void; onRevert: () => void;
}) {
  const paid = w.status === "paid";
  return (
    <tr className="bg-slate-50 border-b border-slate-200">
      <td className="py-1 px-2 text-[11px] font-bold text-slate-600 whitespace-nowrap">
        <button type="button" onClick={onToggle} className="hover:text-brand">{expanded ? "▾" : "▸"} รอบจ่ายสัปดาห์ {weekLabel(w.weekStart, w.weekEnd)}</button>
        <div className="text-[10px] font-normal text-brand">จ่ายวันจันทร์ที่ {thDate(w.payDate)}{w.spansMonth && <span className="text-slate-400"> · รอบเต็ม ฿{fmtMoney(w.roundFee)}</span>}</div>
      </td>
      <td className="py-1 px-2 text-right tabular-nums text-[11px] text-slate-400">฿{fmtMoney(w.shownRevenue)}</td>
      <td className="py-1 px-2 text-right tabular-nums font-bold text-brand">฿{fmtMoney(w.shownFee)}</td>
      <td colSpan={2} className="py-1 px-2 text-right whitespace-nowrap">
        {w.unassignedFee > 0 && (
          <span className="text-[10px] text-amber-700 mr-2" title="มีรายได้ในวันที่ไม่มีแพทย์ในตารางเวร — ยังไม่ถูกจัดสรร">⚠ มีรายได้แต่ไม่มีแพทย์ในเวร ฿{fmtMoney(w.unassignedFee)}</span>
        )}
        {w.beforeCutover ? (
          <span className="text-[10px] text-amber-700">ก่อนวันเริ่มจ่ายรายสัปดาห์ — จ่ายผ่านเงินเดือน</span>
        ) : paid ? (
          <>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 mr-2">จ่ายแล้ว ฿{fmtMoney(w.roundNet)}</span>
            {w.stale && <span className="text-[10px] text-amber-700 mr-2">ยอดเปลี่ยน</span>}
            <button type="button" disabled={busy} onClick={onRevert} className="text-[11px] text-rose-500 hover:underline">ยกเลิก</button>
          </>
        ) : (
          <button type="button" disabled={busy || w.roundNet <= 0} onClick={onPay}
            className="rounded-md bg-brand text-white px-3 py-1 text-[11px] font-bold hover:opacity-90 disabled:opacity-40">
            ตัดรอบ + จ่าย ฿{fmtMoney(w.roundNet)}
          </button>
        )}
      </td>
    </tr>
  );
}

function DayDetail({ lines }: { lines: DfDayLine[] | undefined }) {
  if (lines === undefined) return <div className="text-[11px] text-slate-400">กำลังโหลด…</div>;
  if (lines.length === 0) return <div className="text-[11px] text-slate-400">ไม่มีรายการที่คิด DF ในวันนี้</div>;
  return (
    <table className="w-full text-[12px]">
      <thead><tr className="text-slate-400 text-left">
        <th className="py-1 pr-2">ใบแจ้งหนี้</th><th className="py-1 px-2">รหัส</th><th className="py-1 px-2">รายการ</th>
        <th className="py-1 px-2 text-right">ยอดสุทธิ</th><th className="py-1 pl-2 text-right">DF</th>
      </tr></thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={`${l.invoice_no}-${l.item_tag}-${i}`} className="border-t border-slate-100">
            <td className="py-1 pr-2 text-slate-500 whitespace-nowrap">{l.invoice_no}</td>
            <td className="py-1 px-2 text-slate-600 whitespace-nowrap">[{l.item_tag}]</td>
            <td className="py-1 px-2 text-slate-500 max-w-[360px] truncate" title={l.description ?? ""}>{l.description ?? l.item_code ?? "—"}</td>
            <td className="py-1 px-2 text-right tabular-nums text-slate-500">฿{fmtMoney(l.net)}</td>
            <td className="py-1 pl-2 text-right tabular-nums font-medium text-slate-700">฿{fmtMoney(l.fee)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DoctorTable({ w }: { w: DfMonthWeek }) {
  if (w.doctors.length === 0) return <div className="text-[11px] text-slate-400">ไม่มีค่าตอบแทนในสัปดาห์นี้ (ยังไม่มีแพทย์ในเวร)</div>;
  return (
    <table className="w-full text-[12px]">
      <thead><tr className="text-slate-400 text-left">
        <th className="py-1 pr-2">แพทย์</th><th className="py-1 px-2 text-center">วันเวร</th>
        <th className="py-1 px-2 text-right">ก่อนหัก</th><th className="py-1 px-2 text-center">หัก%</th>
        <th className="py-1 px-2 text-right">ภาษี</th><th className="py-1 pl-2 text-right">โอนสุทธิ</th>
      </tr></thead>
      <tbody>
        {w.doctors.map((d) => (
          <tr key={d.user_id} className="border-t border-slate-100">
            <td className="py-1 pr-2 text-slate-700">{d.title_prefix ?? ""}{d.display_name}</td>
            <td className="py-1 px-2 text-center text-slate-500">{d.workedDays}</td>
            <td className="py-1 px-2 text-right tabular-nums">฿{fmtMoney(d.grossFee)}</td>
            <td className="py-1 px-2 text-center text-slate-400">{(d.whtRate * 100).toLocaleString("th-TH", { maximumFractionDigits: 2 })}%</td>
            <td className="py-1 px-2 text-right tabular-nums text-rose-700">{d.whtAmount > 0 ? `−฿${fmtMoney(d.whtAmount)}` : "—"}</td>
            <td className="py-1 pl-2 text-right tabular-nums font-semibold">฿{fmtMoney(d.netFee)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WhtRow({ doctor, disabled, onSave }: { doctor: DfDoctor; disabled: boolean; onSave: (rate: number) => void }) {
  const [pct, setPct] = useState(String(+(doctor.df_wht_rate * 100).toFixed(2)));
  const rate = Math.min(1, Math.max(0, (Number(pct) || 0) / 100));
  const changed = Math.abs(rate - doctor.df_wht_rate) > 1e-9;
  return (
    <div className="flex items-center gap-2 text-sm border-b border-slate-50 pb-2 last:border-0">
      <span className="text-slate-700 flex-1 min-w-0 truncate">{doctor.title_prefix ?? ""}{doctor.display_name}</span>
      <input type="number" min={0} max={100} step={0.5} className="input !py-1 !w-16 text-right shrink-0" value={pct} onChange={(e) => setPct(e.target.value)} />
      <span className="text-slate-400 shrink-0">%</span>
      <button className="btn-secondary text-xs shrink-0" disabled={disabled || !changed} onClick={() => onSave(rate)}>บันทึก</button>
    </div>
  );
}

function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    df_before_cutover: "สัปดาห์นี้อยู่ก่อนวันเริ่มจ่ายรายสัปดาห์ — ตัดรอบไม่ได้",
    df_round_paid: "รอบนี้จ่ายไปแล้ว — ต้องยกเลิกก่อนจึงจะแก้ได้",
    no_pin: "คุณยังไม่ได้ตั้ง PIN", wrong_pin: "PIN ไม่ถูกต้อง",
    not_df_branch: "สาขานี้ไม่ได้เปิดใช้ค่าตอบแทนแพทย์", not_a_doctor: "ผู้ใช้นี้ไม่ใช่แพทย์ที่รับค่าตอบแทน"
  };
  return map[m] ?? `เกิดข้อผิดพลาด: ${m}`;
}
