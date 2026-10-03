"use client";

import { useState } from "react";

// Membership sign-up form (owner 2026-10-03). Minimal by design: birthday as
// three numbers, gender, a coarse home area, how they found us, and the
// marketing consent. The privacy notice must be acknowledged; the marketing
// consent is a separate, optional choice (PDPA).

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const SOURCES: Array<{ key: string; label: string }> = [
  { key: "friend", label: "เพื่อนหรือครอบครัวแนะนำ" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "tiktok", label: "TikTok" },
  { key: "google", label: "ค้นหาใน Google" },
  { key: "line", label: "LINE" },
  { key: "walkby", label: "เดินผ่านหน้าร้าน" },
  { key: "event", label: "งานหรือกิจกรรม" },
  { key: "other", label: "อื่น ๆ" }
];

export type JoinInitial = {
  member_code: string;
  birth_day: number | null; birth_month: number | null; birth_year: number | null;
  gender: "M" | "F" | "X" | null; home_area: string | null; acquisition_source: string | null;
  consent_marketing: boolean;
};

export default function JoinClient({ token, branchName, initial }: { token: string; branchName: string; initial: JoinInitial | null }) {
  const nowBe = new Date().getFullYear() + 543;
  const [day, setDay] = useState(initial?.birth_day ? String(initial.birth_day) : "");
  const [month, setMonth] = useState(initial?.birth_month ? String(initial.birth_month) : "");
  const [yearBe, setYearBe] = useState(initial?.birth_year ? String(initial.birth_year + 543) : "");
  const [gender, setGender] = useState<"M" | "F" | "X" | "">(initial?.gender ?? "");
  const [area, setArea] = useState(initial?.home_area ?? "");
  const [source, setSource] = useState(initial?.acquisition_source ?? "");
  const [consent, setConsent] = useState(initial?.consent_marketing ?? false);
  const [notice, setNotice] = useState(!!initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const editing = !!initial;

  async function submit() {
    setError(null);
    if (!day || !month) { setError("กรุณาเลือกวันและเดือนเกิด"); return; }
    if (!gender) { setError("กรุณาเลือกเพศ"); return; }
    if (!notice) { setError("กรุณารับทราบประกาศความเป็นส่วนตัวก่อนสมัคร"); return; }
    setBusy(true);
    try {
      const res = await fetch("/api/insigna/members/join", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          t: token, birth_day: Number(day), birth_month: Number(month),
          birth_year_be: yearBe ? Number(yearBe) : null,
          gender, home_area: area.trim() || null, acquisition_source: source || null,
          consent_marketing: consent, accept_notice: notice
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error ?? "failed");
      setDone(j.member_code as string);
    } catch {
      setError("บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="bg-white rounded-2xl shadow border border-emerald-200 p-6 text-center mt-6">
        <div className="text-4xl mb-2">🎉</div>
        <div className="text-slate-800 font-bold">{editing ? "บันทึกข้อมูลแล้ว" : "สมัครสมาชิกเรียบร้อย"}</div>
        <div className="text-[11px] text-slate-500 mt-3">หมายเลขสมาชิกของท่าน</div>
        <div className="text-3xl font-black tracking-[0.2em] text-emerald-800 tabular-nums">{done}</div>
        <p className="text-sm text-slate-500 mt-3">บัตรสมาชิกถูกส่งไปที่แชท LINE ของท่านแล้ว แสดงบัตรให้พนักงานสแกนตอนชำระเงินค่ะ</p>
        <a href={`/m?t=${encodeURIComponent(token)}`} className="inline-block mt-4 px-5 py-2.5 rounded-xl bg-emerald-600 text-white font-bold text-sm">เปิดบัตรสมาชิก</a>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="text-center">
        <div className="text-[11px] font-bold uppercase tracking-widest text-brand">IKIGAI</div>
        <h1 className="text-xl font-bold text-slate-800 mt-1">{editing ? "แก้ไขข้อมูลสมาชิก" : "สมัครสมาชิก"}</h1>
        <p className="text-xs text-slate-400 mt-1">{branchName}{editing ? ` · หมายเลข ${initial!.member_code}` : " · ฟรี ไม่ถึงนาที"}</p>
      </div>

      <div className="bg-white rounded-2xl shadow border border-slate-200 p-5 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">วันเกิด <span className="text-rose-500">*</span></label>
          <div className="grid grid-cols-3 gap-2">
            <select value={day} onChange={(e) => setDay(e.target.value)} className="input">
              <option value="">วันที่</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className="input">
              <option value="">เดือน</option>
              {TH_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={yearBe} onChange={(e) => setYearBe(e.target.value)} className="input">
              <option value="">ปี พ.ศ. (ไม่บังคับ)</option>
              {Array.from({ length: 90 }, (_, i) => nowBe - 10 - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <p className="text-[11px] text-slate-400 mt-1">ใช้สำหรับสิทธิพิเศษวันเกิด</p>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">เพศ <span className="text-rose-500">*</span></label>
          <div className="grid grid-cols-3 gap-2">
            {([["F", "หญิง"], ["M", "ชาย"], ["X", "ไม่ระบุ"]] as const).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setGender(k)}
                className={`rounded-xl border px-3 py-2 text-sm ${gender === k ? "border-emerald-500 bg-emerald-50 text-emerald-800 font-semibold" : "border-slate-200 text-slate-600"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">ย่านที่พักอาศัย <span className="text-slate-400 font-normal">(ไม่บังคับ)</span></label>
          <input value={area} onChange={(e) => setArea(e.target.value.slice(0, 60))} placeholder="เช่น ศรีราชา หรือ บ่อวิน" className="input" />
          <p className="text-[11px] text-slate-400 mt-1">ระบุเพียงอำเภอหรือย่าน ไม่ต้องใส่ที่อยู่</p>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1">รู้จักร้านจาก <span className="text-slate-400 font-normal">(ไม่บังคับ)</span></label>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="input">
            <option value="">เลือก</option>
            {SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        <div className="rounded-xl bg-slate-50 p-3 text-[12px] text-slate-600 space-y-1.5">
          <div className="font-semibold text-slate-700">ประกาศความเป็นส่วนตัว</div>
          <p>ร้านเก็บเฉพาะวันเกิด เพศ ย่านที่พักอาศัย ช่องทางที่รู้จักร้าน และประวัติการมาใช้บริการที่ท่านให้พนักงานบันทึก โดยเชื่อมกับบัญชี LINE ของท่านผ่านรหัสที่ไม่สามารถย้อนกลับได้ ร้านไม่เก็บชื่อ เบอร์โทร หรืออีเมล พนักงานและผู้ดูแลระบบเห็นเพียงหมายเลขสมาชิก</p>
          <p>ข้อมูลใช้เพื่อดูแลสมาชิกและมอบสิทธิพิเศษ ท่านแก้ไข ถอนความยินยอม หรือลบข้อมูลทั้งหมดได้เองจากบัตรสมาชิกทุกเมื่อ</p>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={notice} onChange={(e) => setNotice(e.target.checked)} className="h-4 w-4 mt-0.5" />
          <span>ข้าพเจ้ารับทราบประกาศความเป็นส่วนตัวข้างต้น <span className="text-rose-500">*</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="h-4 w-4 mt-0.5" />
          <span>ยินดีรับข่าวสารและสิทธิพิเศษทาง LINE <span className="text-slate-400">(ไม่บังคับ ยกเลิกได้ทุกเมื่อ)</span></span>
        </label>

        {error && <div className="text-sm text-rose-600">{error}</div>}
        <button type="button" onClick={submit} disabled={busy}
          className="w-full py-3 rounded-xl bg-emerald-600 text-white font-bold text-sm disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : editing ? "บันทึกข้อมูล" : "สมัครสมาชิก"}
        </button>
      </div>
    </div>
  );
}
