"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

const MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

export default function DobForm({ token }: { token: string }) {
  const router = useRouter();
  const [d, setD] = useState(""), [m, setM] = useState(""), [y, setY] = useState("");
  const [mode, setMode] = useState<"dob" | "id">("dob");
  const [id4, setId4] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const thisYearBe = new Date().getFullYear() + 543;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "dob" && (!d || !m || !y)) { setErr("กรุณาเลือกวัน เดือน และปีเกิดให้ครบ"); return; }
    if (mode === "id" && !/^[A-Za-z0-9]{4}$/.test(id4.trim())) { setErr("กรุณากรอกเลขบัตร 4 ตัวท้ายให้ครบ"); return; }
    const ce = Number(y) - 543;
    setBusy(true); setErr(null);
    try {
      const r = await fetch(apiUrl("/api/annual-checkup/link/verify"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "dob" ? { token, dob: `${ce}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` } : { token, idLast4: id4.trim() }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) { router.refresh(); return; }
      setErr(j.message ?? "ไม่สำเร็จ ลองอีกครั้ง");
    } catch { setErr("เชื่อมต่อไม่สำเร็จ ลองอีกครั้ง"); }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} className="max-w-sm mx-auto my-8 space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-center space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/health-report/logos.png" alt="AT HOME CLINIC · OMNIA HEALTH" className="h-10 w-auto mx-auto" />
        <div className="text-brand font-extrabold text-3xl leading-none">Health <span className="text-base">Check up report</span></div>
        <div className="text-brand">รายงานผลการตรวจสุขภาพ</div>
      </div>
      <div className="flex items-center gap-2 rounded-xl bg-white border border-slate-200 px-3 py-2 text-xs text-slate-600"><span aria-hidden>🔒</span><span>ข้อมูลสุขภาพเป็นความลับ ลิงก์นี้เปิดได้เฉพาะเจ้าของผลตรวจ</span></div>
      <p className="text-sm text-slate-700">เพื่อความปลอดภัยของข้อมูลสุขภาพ กรุณายืนยันตัวตนด้วย{mode === "dob" ? "วันเดือนปีเกิด (พุทธศักราช)" : "เลขบัตรประจำตัว 4 ตัวท้าย"}ของท่าน</p>
      {mode === "id" ? <input inputMode="text" maxLength={4} autoComplete="off" value={id4} onChange={(e) => setId4(e.target.value)} className="input min-h-[44px] w-full text-center tracking-widest" aria-label="เลขบัตร 4 ตัวท้าย" /> : <div className="grid grid-cols-3 gap-2">
        <select className="input min-h-[44px]" value={d} onChange={(e) => setD(e.target.value)} aria-label="วันที่เกิด"><option value="">วัน</option>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select>
        <select className="input min-h-[44px]" value={m} onChange={(e) => setM(e.target.value)} aria-label="เดือนเกิด"><option value="">เดือน</option>{MONTHS.map((x, i) => <option key={x} value={i + 1}>{x}</option>)}</select>
        <select className="input min-h-[44px]" value={y} onChange={(e) => setY(e.target.value)} aria-label="ปีเกิด พ.ศ."><option value="">ปี พ.ศ.</option>{Array.from({ length: 90 }, (_, i) => thisYearBe - 15 - i).map((x) => <option key={x} value={x}>{x}</option>)}</select>
      </div>}
      <button type="button" className="text-sm underline text-slate-600 min-h-[44px]" onClick={() => { setMode(mode === "dob" ? "id" : "dob"); setErr(null); }}>{mode === "dob" ? "ใช้เลขบัตร 4 ตัวท้ายแทน" : "ใช้วันเดือนปีเกิดแทน"}</button>
      {err && <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{err}</div>}
      <button type="submit" disabled={busy} className="w-full min-h-[48px] rounded-xl btn-primary font-semibold disabled:opacity-60">{busy ? "กำลังตรวจสอบ…" : "เปิดดูผลตรวจ"}</button>
      <p className="text-xs text-slate-500">ถ้ากรอกผิดหลายครั้ง ลิงก์จะถูกล็อกชั่วคราว</p>
    </form>
  );
}
