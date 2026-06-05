"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// ── Mounjaro clinical dashboard — patient registry ──────────────────
// Visual language mirrors the IKIGAI MediHealth tracker prototype:
// navy (#0F1B33) + gold (#B8954F), sharp 2px corners, serif numerals.
// Privacy model unchanged: a doctor sees ONLY their own patients, must
// unlock with their license each session, and every read is audited.

type PatientRow = {
  id: number; employee_name: string; hn: string | null; enrollment_status: string;
  dose: number | null; latestWeight: number | null; lossPct: number | null;
  weekNo: number; nextVisit: string | null; alertLevel: "danger" | "warning" | null;
  newSelfLog: boolean;
};
type PendingRow = {
  enrollment_id: number; employee_name: string; enrolled_at: string | null;
  gender: string | null; dob: string | null; phone: string | null;
  height_cm: number | null; weight_kg: number | null;
};

const inputCls =
  "w-full px-3 py-2 text-sm border border-[#C9C2B0] rounded-sm bg-white text-[#0F1B33] " +
  "focus:outline-none focus:border-[#B8954F] focus:ring-2 focus:ring-[#B8954F]/20";
const labelCls = "text-[12px] font-medium text-slate-500 tracking-wide";

function toBE(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const months = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${dt.getDate()} ${months[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}

export default function ClinicalClient({
  mode, patients, pending
}: { mode: "locked" | "list"; patients: PatientRow[]; pending: PendingRow[] }) {
  if (mode === "locked") return <UnlockGate />;
  return <PatientList patients={patients} pending={pending} />;
}

function UnlockGate() {
  const router = useRouter();
  const [license, setLicense] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function unlock() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/unlock"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license: license.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(j.error === "bad_license" ? "เลขใบประกอบไม่ถูกต้อง" : "ปลดล็อกไม่สำเร็จ"); return; }
      router.refresh();
    } finally { setBusy(false); }
  }
  return (
    <div className="max-w-md mx-auto mt-6">
      <div className="bg-white border border-[#E5E0D5] rounded-sm shadow-sm overflow-hidden">
        <div className="bg-[#0F1B33] px-6 py-5 border-b-[3px] border-[#B8954F]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 border-2 border-[#B8954F] flex items-center justify-center font-bold text-[#B8954F]">M</div>
            <div>
              <h1 className="text-white font-semibold text-[15px]">ระบบติดตามผู้ป่วย Mounjaro</h1>
              <div className="text-[10px] text-[#D4B675] tracking-[0.12em] uppercase mt-0.5">Tirzepatide Monitoring</div>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600">
            ข้อมูลผู้ป่วยเป็นข้อมูลอ่อนไหว — กรุณายืนยันตัวตนด้วย<b>เลขใบประกอบวิชาชีพ</b>ของท่าน
            (มีผล 8 ชั่วโมง · ทุกการเข้าถึงถูกบันทึก log)
          </p>
          <div>
            <label className={labelCls}>เลขใบประกอบวิชาชีพ</label>
            <input className={inputCls + " mt-1"} value={license} autoComplete="off"
              onChange={(e) => setLicense(e.target.value)} placeholder="เช่น ว.12345"
              onKeyDown={(e) => { if (e.key === "Enter") unlock(); }} />
          </div>
          {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
          <button type="button" disabled={busy || license.trim().length === 0} onClick={unlock}
            className="w-full py-2.5 bg-[#0F1B33] hover:bg-[#1B2D4F] text-white text-sm font-medium rounded-sm disabled:opacity-50 transition">
            {busy ? "กำลังตรวจสอบ…" : "ปลดล็อกเข้าดูข้อมูล"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ level }: { level: "danger" | "warning" | null }) {
  if (level === "danger")
    return <span className="text-[11px] px-2.5 py-0.5 rounded-sm border border-[#B91C1C] bg-[#FEF2F2] text-[#B91C1C] font-medium">เร่งด่วน</span>;
  if (level === "warning")
    return <span className="text-[11px] px-2.5 py-0.5 rounded-sm border border-[#B45309] bg-[#FEF3C7] text-[#78350F] font-medium">เฝ้าระวัง</span>;
  return <span className="text-[11px] px-2.5 py-0.5 rounded-sm border border-[#C9C2B0] bg-[#FAF8F3] text-slate-500 font-medium">ปกติ</span>;
}

function PatientList({ patients, pending }: { patients: PatientRow[]; pending: PendingRow[] }) {
  const router = useRouter();
  const [intake, setIntake] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-[#0F1B33]">รายชื่อผู้ป่วย</h1>
          <div className="text-[11px] text-slate-500 tracking-[0.12em] uppercase mt-0.5">Patient Registry · เห็นเฉพาะผู้ป่วยของท่าน</div>
        </div>
        <button type="button" onClick={() => setIntake(true)}
          className="px-4 py-2.5 bg-[#B8954F] hover:bg-[#A38240] text-white text-[13px] font-medium rounded-sm transition whitespace-nowrap">
          + เพิ่มผู้ป่วยใหม่
        </button>
      </div>

      {pending.length > 0 && (
        <div className="bg-[#F5EFE0] border border-[#D4B675] rounded-sm px-4 py-2.5 text-[13px] text-[#5C4A28]">
          มีพนักงาน <b>{pending.length}</b> คนสมัครเข้าโครงการ รอรับเข้า —
          กด <button onClick={() => setIntake(true)} className="underline font-medium">เพิ่มผู้ป่วยใหม่</button> เพื่อทำ baseline
        </div>
      )}

      <div className="bg-white border border-[#E5E0D5] rounded-sm shadow-sm overflow-x-auto">
        {patients.length === 0 ? (
          <div className="text-center py-16 px-8">
            <div className="text-5xl font-bold text-[#B8954F] mb-4">M</div>
            <p className="text-sm text-slate-500">ยังไม่มีผู้ป่วยในความดูแล<br />กดปุ่ม &quot;เพิ่มผู้ป่วยใหม่&quot; เพื่อเริ่มต้น</p>
          </div>
        ) : (
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead>
              <tr className="bg-[#0F1B33] text-white text-left text-[11px] uppercase tracking-[0.08em]">
                <th className="py-3 px-5 font-medium">HN</th>
                <th className="py-3 px-3 font-medium">ชื่อ-สกุล</th>
                <th className="py-3 px-3 font-medium text-right">ขนาดยาปัจจุบัน</th>
                <th className="py-3 px-3 font-medium text-right">สัปดาห์ที่</th>
                <th className="py-3 px-3 font-medium text-right">น้ำหนักล่าสุด</th>
                <th className="py-3 px-3 font-medium text-right">% ลดลง</th>
                <th className="py-3 px-3 font-medium">นัดถัดไป</th>
                <th className="py-3 px-5 font-medium">สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} onClick={() => router.push(`/admin/mounjaro/${p.id}`)}
                  className="border-b border-[#E5E0D5] last:border-0 hover:bg-[#F5EFE0] cursor-pointer">
                  <td className="py-3 px-5 font-mono text-xs tabular-nums">{p.hn ?? "—"}</td>
                  <td className="py-3 px-3 font-medium text-[#0F1B33]">
                    {p.employee_name}
                    {p.newSelfLog && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-sky-500 align-middle" title="มีบันทึกใหม่จากผู้ป่วย" />}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums">{p.dose != null ? `${p.dose} mg` : "—"}</td>
                  <td className="py-3 px-3 text-right tabular-nums">{p.weekNo}</td>
                  <td className="py-3 px-3 text-right tabular-nums">{p.latestWeight != null ? `${p.latestWeight.toFixed(1)} กก.` : "—"}</td>
                  <td className="py-3 px-3 text-right tabular-nums" style={{ color: (p.lossPct ?? 0) > 0 ? "#047857" : "#6B7280" }}>
                    {p.lossPct != null ? `${p.lossPct > 0 ? "−" : ""}${Math.abs(p.lossPct).toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-3 px-3">{toBE(p.nextVisit)}</td>
                  <td className="py-3 px-5"><StatusBadge level={p.alertLevel} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Standard monitoring reference */}
      <div className="bg-[#F5EFE0] border border-[#D4B675] rounded-sm px-6 py-5">
        <div className="text-[12px] font-semibold text-[#0F1B33] tracking-[0.08em] uppercase mb-2.5">
          เกณฑ์การติดตามมาตรฐาน · Standard Monitoring Parameters
        </div>
        <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5 text-[13px] text-[#3D3320]">
          {[
            ["ทุกครั้งที่นัด:", "น้ำหนัก, BMI, BP, HR, ผลข้างเคียง, adherence"],
            ["ทุก 4 สัปดาห์:", "ประเมินการ titrate ขนาดยา"],
            ["ทุก 3 เดือน:", "HbA1c (ถ้าเป็นเบาหวาน), LFT, lipid profile"],
            ["เฝ้าระวัง:", "HR เพิ่ม >10 bpm, ปวดท้องรุนแรง, hypoglycemia"],
            ["ข้อห้าม:", "ประวัติ MTC, MEN 2, ตั้งครรภ์, แพ้ tirzepatide"],
            ["เสริม:", "รอบเอว, ภาวะ dehydration ช่วง titrate"]
          ].map(([k, v]) => (
            <li key={k} className="relative pl-4 before:content-['·'] before:absolute before:left-1 before:text-[#B8954F] before:font-bold">
              <b>{k}</b> {v}
            </li>
          ))}
        </ul>
      </div>

      {intake && <IntakeModal pending={pending} onClose={() => setIntake(false)} />}
    </div>
  );
}

function ageFromDob(dob: string | null): string {
  if (!dob) return "";
  const d = new Date(dob);
  if (isNaN(d.getTime())) return "";
  const age = Math.floor((Date.now() - d.getTime()) / (365.25 * 86_400_000));
  return age > 0 && age < 130 ? String(age) : "";
}

function sexFromGender(g: string | null): string {
  return g === "male" ? "ชาย" : g === "female" ? "หญิง" : "หญิง";
}

function IntakeModal({ pending, onClose }: { pending: PendingRow[]; onClose: () => void }) {
  const router = useRouter();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  // Prefill from the sole pending employee when there's exactly one; the
  // doctor picks otherwise.
  const only = pending.length === 1 ? pending[0] : null;
  const [enrId, setEnrId] = useState<number | "">(only ? only.enrollment_id : "");
  const [hn, setHn] = useState("");
  const [age, setAge] = useState(only ? ageFromDob(only.dob) : "");
  const [sex, setSex] = useState(only ? sexFromGender(only.gender) : "หญิง");
  const [phone, setPhone] = useState(only?.phone ?? "");
  const [start, setStart] = useState(today);
  const [b, setB] = useState<Record<string, string>>(only ? {
    ...(only.weight_kg != null ? { weight: String(only.weight_kg) } : {}),
    ...(only.height_cm != null ? { height: String(only.height_cm) } : {})
  } : {});
  const [bp, setBp] = useState("");
  const [como, setComo] = useState<Record<string, boolean>>({});
  const [contra, setContra] = useState<Record<string, boolean>>({});
  const [meds, setMeds] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const selected = pending.find((p) => p.enrollment_id === enrId) ?? null;

  // Prefill demographics + height/weight from the chosen employee.
  function pick(id: number | "") {
    setEnrId(id);
    const row = pending.find((p) => p.enrollment_id === id);
    if (!row) return;
    setAge(ageFromDob(row.dob));
    setSex(sexFromGender(row.gender));
    setPhone(row.phone ?? "");
    setB((prev) => ({
      ...prev,
      weight: row.weight_kg != null ? String(row.weight_kg) : prev.weight ?? "",
      height: row.height_cm != null ? String(row.height_cm) : prev.height ?? ""
    }));
  }

  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  async function save() {
    if (enrId === "") { setErr("กรุณาเลือกพนักงานที่สมัครเข้าโครงการ"); return; }
    if (!hn.trim() || !b.weight || !b.height || !b.hr) {
      setErr("กรุณากรอกข้อมูลที่จำเป็น (HN, น้ำหนัก, ส่วนสูง, HR)"); return;
    }
    setBusy(true); setErr(null);
    try {
      const baseline: Record<string, number> = {};
      for (const k of ["weight", "height", "hr", "hba1c", "fbs", "waist", "target"]) {
        const v = num(b[k] ?? ""); if (v != null && !Number.isNaN(v)) baseline[k] = v;
      }
      const res = await fetch(apiUrl("/api/admin/mounjaro/baseline"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enrollment_id: enrId, hn: hn.trim() || undefined,
          baseline, bp: bp.trim() || undefined,
          age: age.trim() ? Number(age) : undefined,
          sex, phone: phone.trim() || undefined,
          comorbidities: como, contraindications: contra, medications: meds,
          notes: notes.trim() || undefined, start_date: start
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("บันทึกไม่สำเร็จ"); return; }
      onClose();
      if (j.patient_id) router.push(`/admin/mounjaro/${j.patient_id}`);
      else router.refresh();
    } finally { setBusy(false); }
  }

  const Num = (k: string, label: string, req?: boolean) => (
    <div>
      <label className={labelCls}>{label}{req && <span className="text-[#B91C1C]"> *</span>}</label>
      <input type="number" step="0.1" className={inputCls + " mt-1"} value={b[k] ?? ""}
        onChange={(e) => setB((p) => ({ ...p, [k]: e.target.value }))} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[#0F1B33]/60 backdrop-blur-[2px] p-4 sm:p-10 overflow-y-auto" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded-sm border-t-[3px] border-[#B8954F] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-[#0F1B33] px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-white font-semibold text-[16px]">เพิ่มผู้ป่วยใหม่</div>
            <div className="text-[10px] text-[#D4B675] tracking-[0.1em] uppercase mt-0.5">New Patient Registration</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 border border-white/30 text-white text-lg hover:bg-white/10">×</button>
        </div>
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

          <Section title="ข้อมูลผู้ป่วย">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-3">
                <label className={labelCls}>พนักงานที่สมัครเข้าโครงการ <span className="text-[#B91C1C]">*</span></label>
                {pending.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500 bg-[#FAF8F3] border border-[#E5E0D5] rounded-sm px-3 py-2">
                    ยังไม่มีพนักงานสมัครเข้าโครงการ — ให้พนักงานกดสมัครที่เมนู &quot;สุขภาพพนักงาน&quot; ก่อน
                  </p>
                ) : (
                  <select className={inputCls + " mt-1"} value={enrId}
                    onChange={(e) => pick(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">— เลือกพนักงาน —</option>
                    {pending.map((p) => (
                      <option key={p.enrollment_id} value={p.enrollment_id}>
                        {p.employee_name} {p.enrolled_at ? `(สมัคร ${p.enrolled_at.slice(0, 10)})` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className={labelCls}>HN <span className="text-[#B91C1C]">*</span></label>
                <input className={inputCls + " mt-1"} value={hn} onChange={(e) => setHn(e.target.value)} placeholder="จาก AT HOME CLINIC" />
              </div>
              <div>
                <label className={labelCls}>ชื่อ-สกุล</label>
                <input className={inputCls + " mt-1 bg-[#FAF8F3] text-slate-500"} value={selected?.employee_name ?? ""} readOnly />
              </div>
              <div>
                <label className={labelCls}>อายุ (ปี)</label>
                <input type="number" className={inputCls + " mt-1"} value={age} onChange={(e) => setAge(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>เพศ</label>
                <select className={inputCls + " mt-1"} value={sex} onChange={(e) => setSex(e.target.value)}>
                  <option value="หญิง">หญิง</option><option value="ชาย">ชาย</option><option value="อื่นๆ">อื่นๆ</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>เบอร์โทร</label>
                <input className={inputCls + " mt-1"} value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>วันที่เริ่มยา <span className="text-[#B91C1C]">*</span></label>
                <input type="date" className={inputCls + " mt-1"} value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
            </div>
          </Section>

          <Section title="ข้อมูลพื้นฐาน (Baseline)">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Num("weight", "น้ำหนัก (กก.)", true)}
              {Num("height", "ส่วนสูง (ซม.)", true)}
              {Num("waist", "รอบเอว (ซม.)")}
              <div>
                <label className={labelCls}>BP baseline (mmHg)</label>
                <input className={inputCls + " mt-1"} value={bp} onChange={(e) => setBp(e.target.value)} placeholder="120/80" />
              </div>
              {Num("hr", "HR baseline (bpm)", true)}
              {Num("hba1c", "HbA1c (%)")}
              {Num("fbs", "FBS (mg/dL)")}
              {Num("target", "เป้าหมายน้ำหนัก (กก.)")}
            </div>
          </Section>

          <Section title="ประวัติโรคและข้อห้าม · Comorbidities & Contraindications">
            <CheckRow state={como} set={setComo} items={[
              ["dm", "เบาหวานชนิดที่ 2"], ["htn", "ความดันโลหิตสูง"], ["dlp", "ไขมันในเลือดสูง"],
              ["cvd", "โรคหัวใจและหลอดเลือด (CVD)"], ["ckd", "โรคไตเรื้อรัง"],
              ["panc", "ประวัติตับอ่อนอักเสบ"], ["gb", "นิ่วในถุงน้ำดี"]
            ]} />
            <div className="mt-3 bg-[#FEF2F2] border-l-[3px] border-[#B91C1C] px-3 py-2.5">
              <div className="text-[12px] font-semibold text-[#B91C1C] mb-2">ข้อห้ามเด็ดขาด — ห้ามใช้หาก:</div>
              <CheckRow state={contra} set={setContra} items={[
                ["mtc", "ประวัติครอบครัวเป็นมะเร็งต่อมไทรอยด์ชนิดเมดัลลารี"], ["men2", "กลุ่มอาการเนื้องอกต่อมไร้ท่อหลายตำแหน่งชนิดที่ 2 (MEN 2)"],
                ["preg", "ตั้งครรภ์ / วางแผนตั้งครรภ์"], ["allergy", "แพ้ tirzepatide"]
              ]} />
            </div>
          </Section>

          <Section title="ยาที่ใช้ร่วม · Concomitant Medications">
            <CheckRow state={meds} set={setMeds} items={[
              ["insulin", "Insulin (เสี่ยงน้ำตาลต่ำ)"], ["su", "Sulfonylurea (เสี่ยงน้ำตาลต่ำ)"],
              ["met", "Metformin"], ["sglt2", "SGLT2 inhibitor"],
              ["ocp", "ยาเม็ดคุมกำเนิด (อาจลด efficacy ช่วง titrate)"]
            ]} />
            <div className="mt-3">
              <label className={labelCls}>ยาอื่นๆ / หมายเหตุ</label>
              <textarea className={inputCls + " mt-1"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </Section>

          {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
        </div>
        <div className="px-6 py-4 bg-[#FAF8F3] border-t border-[#E5E0D5] flex justify-end gap-2.5">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-[13px] border border-[#C9C2B0] rounded-sm text-[#0F1B33] hover:bg-white">ยกเลิก</button>
          <button onClick={save} disabled={busy} className="px-5 py-2 text-[13px] bg-[#0F1B33] hover:bg-[#1B2D4F] text-white rounded-sm disabled:opacity-50">
            {busy ? "กำลังบันทึก…" : "บันทึก"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="inline-block text-[12px] font-semibold text-[#0F1B33] uppercase tracking-[0.1em] mb-3.5 pb-2 pr-10 border-b border-[#B8954F]">{title}</div>
      {children}
    </div>
  );
}

function CheckRow({ state, set, items }: {
  state: Record<string, boolean>;
  set: (f: (p: Record<string, boolean>) => Record<string, boolean>) => void;
  items: Array<[string, string]>;
}) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-3">
      {items.map(([k, label]) => (
        <label key={k} className="flex items-center gap-1.5 text-[13px] cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-[#B8954F]" checked={!!state[k]}
            onChange={(e) => set((p) => ({ ...p, [k]: e.target.checked }))} />
          {label}
        </label>
      ))}
    </div>
  );
}
