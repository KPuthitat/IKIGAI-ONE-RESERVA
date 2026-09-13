"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import type { DfRule, DfDoctor } from "@/lib/df-db";
import { RulesEditor } from "./DfRulesEditor";

type Span = { min: string | null; max: string | null; count: number };

// Doctor-Fee settings page (owner 2026-09-13): the calculation setup moved off
// the landing page onto its own page — import the clinic sales file, define which
// service codes earn DF and at what rate, and set each doctor's WHT + guarantee
// (การันตี) arrangement.
export default function DoctorFeeConfigClient({
  initialRules, span, initialDoctors
}: {
  initialRules: DfRule[];
  span: Span;
  initialDoctors: DfDoctor[];
}) {
  const router = useRouter();
  const [rules, setRules] = useState<DfRule[]>(initialRules);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) { setErr("เลือกไฟล์ Invoice Report (.xlsx) ก่อน"); return; }
    setBusy(true); setErr(null); setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(apiUrl("/api/admin/persona/doctor-fee/import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "นำเข้าไฟล์ไม่สำเร็จ")); return; }
      setUploadMsg(`นำเข้าสำเร็จ: ใหม่ ${j.inserted} · อัปเดต ${j.updated} · รวม ${j.total} บรรทัด (${j.periodStart} – ${j.periodEnd})`);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch { setErr("นำเข้าไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง"); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      {err && <div className="card !py-3 text-sm text-rose-600">{err}</div>}

      {/* Bulk import of the clinic sales file */}
      <div className="card space-y-3">
        <h2 className="font-semibold text-slate-700 text-sm">นำเข้าไฟล์ยอดขายคลินิก (Invoice Report .xlsx)</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".xlsx,.xls"
            className="text-sm file:mr-3 file:rounded-full file:border-0 file:bg-brand file:text-white file:px-4 file:py-2 file:text-sm" />
          <button type="button" className="btn btn-primary text-sm" onClick={upload} disabled={busy}>
            {busy ? "กำลังนำเข้า…" : "นำเข้า"}
          </button>
          {span.count > 0 && <span className="text-[11px] text-slate-400">มีข้อมูลแล้ว {span.count} บรรทัด ({span.min} – {span.max})</span>}
        </div>
        {uploadMsg && <div className="text-xs text-emerald-700">{uploadMsg}</div>}
        <p className="text-[11px] text-slate-400">ระบบดึงเฉพาะบรรทัดที่ตรงรหัสในหัวข้อ (เช่น HSC, HSC-GRP) · นำเข้าซ้ำได้ ระบบอัปเดตทับให้เอง · หรือใช้หน้า “รอบจ่ายรายสัปดาห์” นำเข้ารายวัน</p>
      </div>

      <RulesEditor rules={rules} onChange={setRules} onSaved={() => router.refresh()} />

      <DoctorSettings initialDoctors={initialDoctors} />
    </div>
  );
}

// ── Per-doctor settings (WHT + guarantee) ─────────────────────────────
// PIN-gated (money-affecting) via /api/admin/persona/doctor-fee/doctors.

type PinAction = { userId: number; label: string; body: Record<string, unknown> };

function DoctorSettings({ initialDoctors }: { initialDoctors: DfDoctor[] }) {
  const [doctors, setDoctors] = useState<DfDoctor[]>(initialDoctors);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState<PinAction | null>(null);
  const [pin, setPin] = useState("");

  async function runPin() {
    if (!pending || pin.length < 4) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(apiUrl("/api/admin/persona/doctor-fee/doctors"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...pending.body, userId: pending.userId, pin })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg({ kind: "err", text: humanizeApiError(j, "บันทึกไม่สำเร็จ") }); return; }
      setDoctors(j.doctors as DfDoctor[]);
      setMsg({ kind: "ok", text: "บันทึกการตั้งค่าแล้ว" });
      setPending(null); setPin("");
    } catch { setMsg({ kind: "err", text: "บันทึกไม่สำเร็จ" }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-semibold text-slate-700">ตั้งค่ารายแพทย์ (ภาษีหัก ณ ที่จ่าย + การันตี)</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">
          ภาษีหัก ณ ที่จ่าย = เปอร์เซ็นต์ที่หักตอนโอน (เช่น 3 = ภ.ง.ด.53) · การันตี = ตกลงเรทต่อชั่วโมง ระบบจ่าย “มากกว่า” ระหว่าง DF กับการันตี
          (เรท × ชั่วโมงตามตารางเวร) แพทย์ที่เลือกการันตีจะไม่ได้ DF แยก · มีผลกับรอบที่ยังไม่ตัด
        </p>
      </div>

      {msg && <div className={`text-sm rounded-lg px-3 py-2 ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800"}`}>{msg.text}</div>}

      {doctors.length === 0 ? (
        <div className="text-sm text-slate-400">ยังไม่มีแพทย์ในระบบ</div>
      ) : (
        <div className="space-y-2">
          {doctors.map((d) => (
            <DoctorRow key={d.user_id} doctor={d} disabled={busy}
              onSaveWht={(rate) => setPending({ userId: d.user_id, label: `${d.title_prefix ?? ""}${d.display_name}`, body: { wht_rate: rate } })}
              onSaveGuarantee={(g) => setPending({ userId: d.user_id, label: `${d.title_prefix ?? ""}${d.display_name}`, body: g })} />
          ))}
        </div>
      )}

      {pending && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setPending(null); setPin(""); } }}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-sm w-full p-5 space-y-3">
            <h3 className="font-semibold text-slate-800">ยืนยันด้วย PIN</h3>
            <p className="text-sm text-slate-500">บันทึกการตั้งค่าของ {pending.label}</p>
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

function DoctorRow({ doctor, disabled, onSaveWht, onSaveGuarantee }: {
  doctor: DfDoctor; disabled: boolean;
  onSaveWht: (rate: number) => void;
  onSaveGuarantee: (g: { guarantee_enabled: boolean; guarantee_rate: number; guarantee_wht: boolean }) => void;
}) {
  const [pct, setPct] = useState(String(+(doctor.df_wht_rate * 100).toFixed(2)));
  const [gOn, setGOn] = useState(doctor.guarantee_enabled);
  const [gRate, setGRate] = useState(String(+doctor.guarantee_rate.toFixed(2)));
  const [gWht, setGWht] = useState(doctor.guarantee_wht);

  const whtRate = Math.min(1, Math.max(0, (Number(pct) || 0) / 100));
  const whtChanged = Math.abs(whtRate - doctor.df_wht_rate) > 1e-9;

  const rateNum = Number(gRate);
  const gRateOk = gRate.trim() !== "" && Number.isFinite(rateNum) && rateNum >= 0;
  const guaranteeChanged =
    gOn !== doctor.guarantee_enabled ||
    (gRateOk && Math.abs(rateNum - doctor.guarantee_rate) > 1e-9) ||
    gWht !== doctor.guarantee_wht;

  return (
    <div className="border border-slate-100 rounded-lg p-2.5 space-y-2">
      <div className="font-medium text-slate-800 text-sm">
        {doctor.title_prefix ?? ""}{doctor.display_name}
        {doctor.guarantee_enabled && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-700 align-middle">การันตี</span>}
      </div>

      {/* WHT */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-[11px] text-slate-500 w-32 shrink-0">ภาษีหัก ณ ที่จ่าย</span>
        <input type="number" min={0} max={100} step={0.5} className="input !py-1 !w-20 text-right shrink-0"
          value={pct} onChange={(e) => setPct(e.target.value)} />
        <span className="text-slate-400 shrink-0">%</span>
        <button type="button" className="btn-secondary text-xs shrink-0" disabled={disabled || !whtChanged} onClick={() => onSaveWht(whtRate)}>บันทึก</button>
      </div>

      {/* Guarantee */}
      <div className="flex flex-wrap items-center gap-2 text-sm border-t border-slate-50 pt-2">
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 w-32 shrink-0">
          <input type="checkbox" className="w-4 h-4 accent-brand" checked={gOn} onChange={(e) => setGOn(e.target.checked)} />
          ใช้ระบบการันตี
        </label>
        <span className="flex items-center gap-1 shrink-0">
          <input type="number" min={0} step={10} disabled={!gOn} className="input !py-1 !w-24 text-right disabled:opacity-40"
            value={gRate} onChange={(e) => setGRate(e.target.value)} placeholder="เช่น 500" />
          <span className="text-[11px] text-slate-400">บาท/ชม.</span>
        </span>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 shrink-0">
          <input type="checkbox" className="w-4 h-4 accent-brand" disabled={!gOn} checked={gWht} onChange={(e) => setGWht(e.target.checked)} />
          หักภาษีกับการันตีด้วย
        </label>
        <button type="button" className="btn-secondary text-xs shrink-0"
          disabled={disabled || !guaranteeChanged || (gOn && !gRateOk)}
          onClick={() => onSaveGuarantee({ guarantee_enabled: gOn, guarantee_rate: gRateOk ? rateNum : 0, guarantee_wht: gWht })}>
          บันทึกการันตี
        </button>
      </div>
    </div>
  );
}
