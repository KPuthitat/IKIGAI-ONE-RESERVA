"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { SpecialPayment } from "@/lib/special-payments";

export type StaffOption = { id: number; name: string; type: string | null };

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const fmtDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const KIND = { aid: "การช่วยเหลือ", advance: "เบิกล่วงหน้า" } as const;
const shiftMonth = (ym: string, by: number) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + by, 1)); return d.toISOString().slice(0, 7); };

type Limit = { earned: number; taken: number; available: number; basis: string; workedDays: number };

export default function Client({ month, today, staff, payments }: { month: string; today: string; staff: StaffOption[]; payments: SpecialPayment[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState<number | "">("");
  const [kind, setKind] = useState<"aid" | "advance">("aid");
  const [paidOn, setPaidOn] = useState(today);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [limit, setLimit] = useState<Limit | null>(null);
  const [voiding, setVoiding] = useState<number | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidPin, setVoidPin] = useState("");

  useEffect(() => {
    setLimit(null);
    if (kind !== "advance" || userId === "" || !paidOn) return;
    let live = true;
    fetch(apiUrl(`/api/admin/persona/special-payments/limit?user_id=${userId}&date=${paidOn}`), { cache: "no-store" })
      .then((r) => r.json()).then((j) => { if (live && j.limit) setLimit(j.limit); }).catch(() => {});
    return () => { live = false; };
  }, [kind, userId, paidOn, payments.length]);

  async function submit() {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl("/api/admin/persona/special-payments"), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId, kind, paid_on: paidOn, amount: Number(amount), reason, admin_pin: pin }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setMsg({ ok: false, text: (j.message ?? "บันทึกไม่สำเร็จ") + (j.available != null && j.error === "advance_exceeds_limit" ? ` (เบิกได้อีกไม่เกิน ${money(j.available)} บาท)` : "") });
      return;
    }
    setMsg({ ok: true, text: "บันทึกรายการเรียบร้อยแล้ว ระบบนำเข้ารอบเงินเดือนที่ครอบคลุมวันที่นี้ให้โดยอัตโนมัติ" });
    setAmount(""); setReason(""); setPin("");
    router.refresh();
  }

  async function doVoid(id: number) {
    setBusy(true); setMsg(null);
    const r = await fetch(apiUrl(`/api/admin/persona/special-payments/${id}/void`), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: voidReason, admin_pin: voidPin }) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: j.message ?? "ยกเลิกไม่สำเร็จ" }); return; }
    setVoiding(null); setVoidReason(""); setVoidPin("");
    setMsg({ ok: true, text: "ยกเลิกรายการเรียบร้อยแล้ว" });
    router.refresh();
  }

  const [y, m] = month.split("-").map(Number);
  const live = payments.filter((p) => !p.voidedAt);
  const totalAid = live.filter((p) => p.kind === "aid").reduce((a, p) => a + p.amount, 0);
  const totalAdv = live.filter((p) => p.kind === "advance").reduce((a, p) => a + p.amount, 0);
  const canSubmit = userId !== "" && Number(amount) > 0 && reason.trim().length >= 3 && pin.trim() !== "" && !busy;

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h1 className="text-xl font-bold text-slate-900">รอบจ่ายกรณีพิเศษ</h1>
        <p className="text-sm text-slate-500 mt-1">บันทึกการจ่ายเงินให้พนักงานนอกรอบเงินเดือน โดยเลือกว่าเป็นการช่วยเหลือหรือการเบิกล่วงหน้า พร้อมระบุเหตุผล ระบบจะนำไปรวมในรายได้และหักออกจากยอดโอนในรอบเงินเดือนให้โดยอัตโนมัติ</p>
      </div>

      <section className="card space-y-3">
        <h2 className="font-semibold text-slate-800">เพิ่มรอบจ่ายกรณีพิเศษ</h2>
        <p className="text-sm text-slate-600">เลือกประเภทการจ่าย</p>
        <div className="grid grid-cols-2 gap-2">
          {(["aid", "advance"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)}
              className={`rounded-lg border px-3 py-2 text-sm text-left ${kind === k ? "border-amber-700 bg-amber-50 text-amber-900 font-semibold" : "border-slate-300 text-slate-700"}`}>
              {KIND[k]}
              <span className="block text-xs font-normal text-slate-500 mt-0.5">{k === "aid" ? "จ่ายเพิ่ม นับเป็นรายได้และคิดภาษีตามประเภทของพนักงาน" : "เบิกจากเงินที่ทำได้จริงแล้วในเดือนนี้ ภาษีคิดจากยอดเต็ม"}</span>
            </button>
          ))}
        </div>
        <label className="block text-sm">พนักงาน
          <select className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" value={userId} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">เลือกพนักงาน</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm">วันที่จ่ายเงิน
            <input type="date" max={today} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            <span className="text-xs text-slate-500">{paidOn ? fmtDate(paidOn) : ""}</span>
          </label>
          <label className="block text-sm">จำนวนเงิน (บาท)
            <input type="number" inputMode="decimal" min="0" step="0.01" className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
        </div>
        {kind === "advance" && userId !== "" && (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {!limit ? "กำลังคำนวณวงเงิน" : limit.basis === "none"
              ? "ไม่สามารถคำนวณวงเงินได้ เนื่องจากพนักงานไม่มีเงินเดือนหรืออัตราค่าจ้างรายชั่วโมงที่ตั้งไว้"
              : <>ทำงานแล้ว {limit.workedDays} วัน คิดเป็นรายได้ {money(limit.earned)} บาท เบิกไปแล้ว {money(limit.taken)} บาท <b>เบิกได้อีกไม่เกิน {money(limit.available)} บาท</b></>}
          </div>
        )}
        <label className="block text-sm">เหตุผล
          <textarea rows={2} maxLength={300} className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2" value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder={kind === "aid" ? "เช่น เงินช่วยเหลือพนักงานกรณีทางบ้านประสบอุทกภัย" : "เช่น ขอเบิกเงินล่วงหน้า หักจากเงินเดือนสิ้นเดือน"} />
        </label>
        <label className="block text-sm">PIN ผู้ดูแลระบบ
          <input type="password" inputMode="numeric" className="mt-1 w-40 border border-slate-300 rounded-lg px-3 py-2" value={pin} onChange={(e) => setPin(e.target.value)} />
        </label>
        {msg && <div className={`text-sm ${msg.ok ? "text-emerald-700" : "text-rose-700"}`}>{msg.text}</div>}
        <button type="button" className="btn-primary" disabled={!canSubmit} onClick={submit}>{busy ? "กำลังบันทึก" : "บันทึกรายการ"}</button>
      </section>

      <section className="card space-y-3">
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="btn-secondary !py-1 !px-3 whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, -1)}`)}>เดือนก่อน</button>
          <h2 className="font-semibold text-slate-800">เดือน{MONTHS[m - 1]} {y + 543}</h2>
          <button type="button" className="btn-secondary !py-1 !px-3 whitespace-nowrap" onClick={() => router.push(`?month=${shiftMonth(month, 1)}`)}>เดือนถัดไป</button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">เงินช่วยเหลือพิเศษรวม<div className="font-bold">{money(totalAid)} บาท</div></div>
          <div className="rounded-lg bg-violet-50 px-3 py-2 text-violet-900">เบิกล่วงหน้ารวม<div className="font-bold">{money(totalAdv)} บาท</div></div>
        </div>
        {payments.length === 0 ? <p className="text-sm text-slate-500">ยังไม่มีรายการในเดือนนี้</p> : (
          <ul className="divide-y divide-slate-100">
            {payments.map((p) => (
              <li key={p.id} className={`py-3 text-sm ${p.voidedAt ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-900">{p.userName} · {KIND[p.kind]}</div>
                    <div className="text-slate-500">{fmtDate(p.paidOn)}</div>
                    <div className="text-slate-700 mt-0.5">{p.reason}</div>
                    {p.voidedAt && <div className="text-rose-700 mt-0.5">ยกเลิกแล้ว: {p.voidReason}</div>}
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className={`font-bold ${p.voidedAt ? "line-through text-slate-400" : "text-slate-900"}`}>{money(p.amount)} บาท</div>
                    {!p.voidedAt && voiding !== p.id && <button type="button" className="text-xs text-rose-700 underline mt-1" onClick={() => { setVoiding(p.id); setVoidReason(""); setVoidPin(""); }}>ยกเลิกรายการ</button>}
                  </div>
                </div>
                {voiding === p.id && (
                  <div className="mt-2 space-y-2 rounded-lg bg-rose-50 p-3">
                    <input className="w-full border border-slate-300 rounded-lg px-3 py-2 bg-white" placeholder="เหตุผลที่ยกเลิก" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                    <div className="flex gap-2">
                      <input type="password" inputMode="numeric" placeholder="PIN" className="w-28 border border-slate-300 rounded-lg px-3 py-2 bg-white" value={voidPin} onChange={(e) => setVoidPin(e.target.value)} />
                      <button type="button" className="btn-primary" disabled={busy || voidReason.trim().length < 3 || !voidPin} onClick={() => doVoid(p.id)}>ยืนยันยกเลิก</button>
                      <button type="button" className="btn-secondary" onClick={() => setVoiding(null)}>ปิด</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
