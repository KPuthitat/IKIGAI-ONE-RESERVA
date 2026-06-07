"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { nameWithPrefix } from "@/lib/name";

// ── Mounjaro clinical dashboard — patient registry ──────────────────
// Visual language follows the app CI (owner #10 2026-06-06): espresso
// brown headers (ink #3a2716) + caramel accents (brand #a06820) on a
// cream/white surface — the navy/gold clinical chrome was dropped so the
// health program matches the rest of IKIGAI OS.
// Privacy model unchanged: a doctor sees ONLY their own patients, must
// unlock with their license each session, and every read is audited.

type PatientRow = {
  id: number; employee_name: string; hn: string | null; enrollment_status: string;
  dose: number | null; latestWeight: number | null; lossPct: number | null;
  weekNo: number; nextVisit: string | null; alertLevel: "danger" | "warning" | null;
  newSelfLog: boolean;
};
type PendingRow = {
  enrollment_id: number; employee_name: string; title_prefix: string | null;
  enrolled_at: string | null;
  gender: string | null; dob: string | null; phone: string | null;
  height_cm: number | null; weight_kg: number | null;
};
type InvitedRow = {
  enrollment_id: number; employee_name: string; invited_at: string | null;
};

const inputCls =
  "w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white text-[#3a2716] " +
  "focus:outline-none focus:border-[#a06820] focus:ring-2 focus:ring-[#a06820]/20";
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
  mode, patients, pending, pendingInvitations
}: {
  mode: "locked" | "list";
  patients: PatientRow[];
  pending: PendingRow[];
  pendingInvitations: InvitedRow[];
}) {
  if (mode === "locked") return <UnlockGate />;
  return <PatientList patients={patients} pending={pending} pendingInvitations={pendingInvitations} />;
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
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="bg-white px-6 py-5 border-b-[3px] border-[#a06820]">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ahc-logo.png" alt="AHC" className="w-10 h-10 rounded object-contain" />
            <div>
              <h1 className="text-[#3a2716] font-semibold text-[15px]">ระบบติดตามผู้ป่วย โครงการควบคุมน้ำหนัก</h1>
              <div className="text-[10px] text-[#a06820] tracking-[0.12em] uppercase mt-0.5">Tirzepatide Monitoring</div>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[#3a2716]">กรุณายืนยันตัวตน</h2>
            <p className="text-[11px] text-slate-400 mt-1">
              (มีผลภายในครั้งละ 8 ชั่วโมง นับจากเวลายืนยัน · ทุกการเข้าถึงข้อมูลผู้ป่วยจะถูกบันทึกไว้ตามระเบียบ)
            </p>
          </div>
          <div>
            <label className={labelCls}>เลขใบประกอบวิชาชีพ</label>
            <input className={inputCls + " mt-1"} value={license} autoComplete="off"
              onChange={(e) => setLicense(e.target.value)} placeholder="เช่น ว.12345"
              onKeyDown={(e) => { if (e.key === "Enter") unlock(); }} />
          </div>
          {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
          <button type="button" disabled={busy || license.trim().length === 0} onClick={unlock}
            className="w-full py-2.5 bg-[#a06820] hover:bg-[#7a4f16] text-white text-sm font-medium rounded-xl disabled:opacity-50 transition">
            {busy ? "กำลังตรวจสอบ…" : "ปลดล็อกเข้าดูข้อมูล"}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ level }: { level: "danger" | "warning" | null }) {
  if (level === "danger")
    return <span className="text-[11px] px-2.5 py-0.5 rounded-xl border border-[#B91C1C] bg-[#FEF2F2] text-[#B91C1C] font-medium">เร่งด่วน</span>;
  if (level === "warning")
    return <span className="text-[11px] px-2.5 py-0.5 rounded-xl border border-[#B45309] bg-[#FEF3C7] text-[#78350F] font-medium">เฝ้าระวัง</span>;
  return <span className="text-[11px] px-2.5 py-0.5 rounded-xl border border-slate-300 bg-slate-50 text-slate-500 font-medium">ปกติ</span>;
}

function PatientList({ patients, pending, pendingInvitations }: {
  patients: PatientRow[]; pending: PendingRow[]; pendingInvitations: InvitedRow[];
}) {
  const router = useRouter();
  const [intake, setIntake] = useState(false);
  const [invite, setInvite] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-[20px] font-semibold text-[#3a2716]">รายชื่อผู้ป่วย</h1>
          <div className="text-[11px] text-slate-500 tracking-[0.12em] uppercase mt-0.5">Patient Registration · เห็นเฉพาะผู้ป่วยของท่าน</div>
        </div>
        <div className="flex gap-2.5">
          <button type="button" onClick={() => setInvite(true)}
            className="px-4 py-2.5 border border-[#a06820] text-[#a06820] hover:bg-slate-50 text-[13px] font-medium rounded-xl transition whitespace-nowrap">
            + ส่งคำเชิญ
          </button>
          {pending.length > 0 && (
            <button type="button" onClick={() => setIntake(true)}
              className="px-4 py-2.5 bg-[#a06820] hover:bg-[#7a4f16] text-white text-[13px] font-medium rounded-xl transition whitespace-nowrap">
              ทำ Baseline ({pending.length})
            </button>
          )}
        </div>
      </div>

      {pendingInvitations.length > 0 && (
        <div className="bg-[#F0F4FF] border border-[#B8C7E0] rounded-xl px-4 py-2.5 text-[13px] text-[#1E3A5F]">
          คำเชิญที่ส่งแล้ว รอพนักงานยืนยัน ({pendingInvitations.length} คน): {" "}
          {pendingInvitations.map((r, i) => (
            <span key={r.enrollment_id}>{i > 0 ? " · " : ""}<b>{r.employee_name}</b></span>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="bg-white border border-[#d6a14d] rounded-xl px-4 py-2.5 text-[13px] text-slate-700">
          พนักงานยืนยันรับคำเชิญแล้ว <b>{pending.length}</b> คน รอบันทึก Baseline —
          กด <button onClick={() => setIntake(true)} className="underline font-medium">ทำ Baseline</button> เพื่อเปิดแฟ้มผู้ป่วย
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-x-auto">
        {patients.length === 0 ? (
          <div className="text-center py-16 px-8">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/ahc-logo.png" alt="AHC" className="w-16 h-16 rounded object-contain mx-auto mb-4 opacity-60" />
            <p className="text-sm text-slate-500">ยังไม่มีผู้ป่วยในความดูแล<br />กดปุ่ม &quot;ส่งคำเชิญ&quot; เพื่อเริ่มต้นเชิญพนักงาน</p>
          </div>
        ) : (
          <table className="w-full text-[13px] whitespace-nowrap">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-left text-[11px] uppercase tracking-[0.08em] border-b border-slate-200">
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
                  className="border-b border-slate-200 last:border-0 hover:bg-slate-50 cursor-pointer">
                  <td className="py-3 px-5 font-mono text-xs tabular-nums">{p.hn ?? "—"}</td>
                  <td className="py-3 px-3 font-medium text-[#3a2716]">
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
      <div className="bg-white border border-[#d6a14d] rounded-xl px-6 py-5">
        <div className="text-[12px] font-semibold text-[#3a2716] tracking-[0.08em] uppercase mb-3">
          เกณฑ์การติดตามมาตรฐาน · Standard Monitoring Parameters
        </div>
        <ul className="space-y-3 text-[13px] text-[#3D3320]">
          {([
            { label: "ทุกครั้งที่นัด", items: [
              "น้ำหนัก",
              "ดัชนีมวลกาย (BMI)",
              "ความดันโลหิต (BP)",
              "ชีพจร (HR)",
              "อาการข้างเคียง",
              "การปฏิบัติตามคำแนะนำ (Adherence)"
            ]},
            { label: "ทุก 4 สัปดาห์", items: [
              "ประเมินการปรับขนาดยา (Titration)"
            ]},
            { label: "ทุก 3 เดือน", items: [
              "HbA1c — เฉพาะผู้ป่วยเบาหวาน",
              "การทำงานของตับ (LFT)",
              "ไขมันในเลือด (Lipid Profile)"
            ]},
            { label: "เฝ้าระวัง", items: [
              "ชีพจรเพิ่มขึ้น >10 ครั้ง/นาที",
              "ปวดท้องรุนแรง — เฝ้าระวังตับอ่อนอักเสบ",
              "น้ำตาลในเลือดต่ำ (Hypoglycemia)"
            ]},
            { label: "ข้อห้ามเด็ดขาด", items: [
              "ประวัติมะเร็งต่อมไทรอยด์ชนิดเมดัลลารี (MTC)",
              "กลุ่มอาการเนื้องอกต่อมไร้ท่อหลายตำแหน่ง ชนิดที่ 2 (MEN 2)",
              "ตั้งครรภ์ หรือวางแผนตั้งครรภ์",
              "แพ้ยา Tirzepatide"
            ]},
            { label: "ติดตามเพิ่มเติม", items: [
              "รอบเอว",
              "ภาวะขาดน้ำ (Dehydration) ช่วงปรับขนาดยา"
            ]}
          ] as Array<{ label: string; items: string[] }>).map(({ label, items }) => (
            <li key={label}>
              <div className="font-semibold text-[#3a2716] mb-1">{label}</div>
              <ul className="space-y-0.5 pl-3">
                {items.map((item) => (
                  <li key={item} className="flex items-start gap-1.5 text-[#3D3320]">
                    <span className="text-[#a06820] font-bold mt-px flex-shrink-0">–</span>
                    {item}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>

      {intake && <IntakeModal pending={pending} onClose={() => setIntake(false)} />}
      {invite && <InviteModal onClose={() => setInvite(false)} onSent={() => { setInvite(false); router.refresh(); }} />}
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
  // คำนำหน้า — prefilled from the employee record, editable (owner #7).
  const [prefix, setPrefix] = useState(only?.title_prefix ?? "");
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
    setPrefix(row.title_prefix ?? "");
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
          title_prefix: prefix.trim() || undefined,
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
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 backdrop-blur-[2px] p-4 sm:p-10 overflow-y-auto" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl rounded-xl border-t-[3px] border-[#a06820] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="text-[#3a2716] font-semibold text-[16px]">เพิ่มผู้ป่วยใหม่</div>
            <div className="text-[10px] text-[#a06820] tracking-[0.1em] uppercase mt-0.5">New Patient Registration</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg border border-slate-200 text-slate-400 text-lg hover:bg-slate-50">×</button>
        </div>
        <div className="p-6 space-y-6 max-h-[70vh] overflow-y-auto">

          <Section title="ข้อมูลผู้ป่วย">
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-3">
                <label className={labelCls}>พนักงานที่สมัครเข้าโครงการ <span className="text-[#B91C1C]">*</span></label>
                {pending.length === 0 ? (
                  <p className="mt-1 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                    ยังไม่มีพนักงานยืนยันรับคำเชิญ — ส่งคำเชิญก่อน แล้วรอพนักงานยืนยัน
                  </p>
                ) : (
                  <select className={inputCls + " mt-1"} value={enrId}
                    onChange={(e) => pick(e.target.value === "" ? "" : Number(e.target.value))}>
                    <option value="">— เลือกพนักงาน —</option>
                    {pending.map((p) => (
                      <option key={p.enrollment_id} value={p.enrollment_id}>
                        {nameWithPrefix(p.title_prefix, p.employee_name)} {p.enrolled_at ? `(สมัคร ${p.enrolled_at.slice(0, 10)})` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div>
                <label className={labelCls}>HN <span className="text-[#B91C1C]">*</span></label>
                <input className={inputCls + " mt-1"} value={hn} onChange={(e) => setHn(e.target.value)} placeholder="เลข HN จากคลินิก" />
              </div>
              <div>
                <label className={labelCls}>คำนำหน้า</label>
                <input className={inputCls + " mt-1"} value={prefix} list="mj-prefix-list"
                  onChange={(e) => setPrefix(e.target.value)} placeholder="เช่น นางสาว" maxLength={20} />
                <datalist id="mj-prefix-list">
                  <option value="นาย" /><option value="นาง" /><option value="นางสาว" />
                  <option value="เด็กชาย" /><option value="เด็กหญิง" />
                </datalist>
              </div>
              <div>
                <label className={labelCls}>ชื่อ-สกุล</label>
                <input className={inputCls + " mt-1 bg-slate-50 text-slate-500"} value={selected?.employee_name ?? ""} readOnly />
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
                ["mtc", "ประวัติมะเร็งต่อมไทรอยด์ชนิดเมดัลลารี (MTC)"],
                ["men2", "กลุ่มอาการเนื้องอกต่อมไร้ท่อหลายตำแหน่งชนิดที่ 2 (MEN 2)"],
                ["preg", "ตั้งครรภ์ / วางแผนตั้งครรภ์"],
                ["allergy", "แพ้ยา Tirzepatide"]
              ]} />
            </div>
          </Section>

          <Section title="ยาที่ใช้ร่วม · Concomitant Medications">
            <CheckRow state={meds} set={setMeds} items={[
              ["insulin", "อินซูลิน (Insulin) — เสี่ยงน้ำตาลต่ำ"],
              ["su", "ซัลโฟนิลยูเรีย (Sulfonylurea) — เสี่ยงน้ำตาลต่ำ"],
              ["met", "เมตฟอร์มิน (Metformin)"],
              ["sglt2", "ยากลุ่มยับยั้ง SGLT-2 (Sodium-Glucose Cotransporter-2)"],
              ["ocp", "ยาเม็ดคุมกำเนิด — อาจลดประสิทธิผลช่วงปรับขนาดยา"]
            ]} />
            <div className="mt-3">
              <label className={labelCls}>ยาอื่นๆ / หมายเหตุ</label>
              <textarea className={inputCls + " mt-1"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </Section>

          {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
        </div>
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2.5">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-slate-50">ยกเลิก</button>
          <button onClick={save} disabled={busy} className="px-5 py-2 text-[13px] bg-[#a06820] hover:bg-[#7a4f16] text-white rounded-xl disabled:opacity-50">
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
      <div className="inline-block text-[12px] font-semibold text-[#3a2716] uppercase tracking-[0.1em] mb-3.5 pb-2 pr-10 border-b border-[#a06820]">{title}</div>
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
          <input type="checkbox" className="w-4 h-4 accent-[#a06820]" checked={!!state[k]}
            onChange={(e) => set((p) => ({ ...p, [k]: e.target.checked }))} />
          {label}
        </label>
      ))}
    </div>
  );
}

// ── InviteModal ──────────────────────────────────────────────────────
// Doctor selects an eligible employee and sends them an invitation.
// The employee receives a LINE notification and can confirm on the
// health portal. Only confirmed invitations appear in the intake list.
type EligibleEmployee = { id: number; display_name: string; title_prefix: string | null };

function InviteModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [employees, setEmployees] = useState<EligibleEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(apiUrl("/api/admin/mounjaro/eligible-employees"))
      .then((r) => r.json())
      .then((j) => { if (j.ok) setEmployees(j.employees); })
      .finally(() => setLoading(false));
  }, []);

  async function send() {
    if (selectedId === "") { setErr("กรุณาเลือกพนักงาน"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/invite"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: selectedId })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const msg = j.error === "already_active" ? "พนักงานคนนี้อยู่ในโครงการแล้ว"
          : j.error === "already_confirmed" ? "พนักงานคนนี้ยืนยันรับคำเชิญแล้ว รอทำ Baseline"
          : "ส่งคำเชิญไม่สำเร็จ";
        setErr(msg); return;
      }
      onSent();
    } finally { setBusy(false); }
  }

  const selected = employees.find((e) => e.id === selectedId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-md rounded-xl border-t-[3px] border-[#a06820] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/ahc-logo.png" alt="AHC" className="w-16 h-16 rounded-lg object-contain bg-slate-100 p-1 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[#3a2716] font-semibold text-[15px]">ส่งคำเชิญเข้าร่วมโครงการ</div>
            <div className="text-[10px] text-[#a06820] tracking-[0.1em] uppercase mt-0.5">Send Program Invitation</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg border border-slate-200 text-slate-400 text-lg hover:bg-slate-50 flex-shrink-0">×</button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-[13px] text-slate-600">
            เลือกพนักงานที่ท่านต้องการเชิญเข้าโครงการควบคุมน้ำหนัก —
            ระบบจะส่งแจ้งเตือนทาง LINE ให้พนักงานกดยืนยัน และนัดหมายตรวจ Baseline
          </p>
          <div>
            <label className={labelCls}>เลือกพนักงาน <span className="text-[#B91C1C]">*</span></label>
            {loading ? (
              <p className="mt-1 text-sm text-slate-400">กำลังโหลด…</p>
            ) : employees.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                ไม่มีพนักงานที่สามารถเชิญได้ (ทุกคนอยู่ในโครงการแล้ว)
              </p>
            ) : (
              <select className={inputCls + " mt-1"} value={selectedId}
                onChange={(e) => setSelectedId(e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">— เลือกพนักงาน —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {nameWithPrefix(e.title_prefix, e.display_name)}
                  </option>
                ))}
              </select>
            )}
          </div>
          {selected && (
            <div className="bg-white border border-[#d6a14d] rounded-xl px-4 py-3 text-[13px] text-slate-700">
              <b>{nameWithPrefix(selected.title_prefix, selected.display_name)}</b> จะได้รับแจ้งเตือนทาง LINE
              ให้กดยืนยันเข้าร่วมโครงการ · เมื่อยืนยันแล้วจึงจะปรากฏในรายการรอทำ Baseline
            </div>
          )}
          {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
        </div>
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2.5">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-slate-50">ยกเลิก</button>
          <button onClick={send} disabled={busy || selectedId === "" || loading}
            className="px-5 py-2 text-[13px] bg-[#a06820] hover:bg-[#7a4f16] text-white rounded-xl disabled:opacity-50">
            {busy ? "กำลังส่ง…" : "ส่งคำเชิญ"}
          </button>
        </div>
      </div>
    </div>
  );
}
