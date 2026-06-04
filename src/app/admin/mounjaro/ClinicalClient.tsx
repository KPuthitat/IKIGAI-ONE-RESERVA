"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

type PatientRow = {
  id: number; employee_name: string; hn: string | null; enrollment_status: string;
  dose: number | null; latestWeight: number | null; lossPct: number | null;
  weekNo: number; nextVisit: string | null; alertLevel: "danger" | "warning" | null;
  newSelfLog: boolean;
};
type PendingRow = { enrollment_id: number; employee_name: string; enrolled_at: string | null };

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
    <div className="max-w-md mx-auto space-y-4">
      <div className="card space-y-3">
        <h1 className="text-lg font-bold text-slate-800">โครงการ Mounjaro — ข้อมูลทางคลินิก</h1>
        <p className="text-sm text-slate-600">
          ข้อมูลผู้ป่วยเป็นข้อมูลอ่อนไหว — กรุณายืนยันตัวตนด้วย<b>เลขใบประกอบวิชาชีพ</b>ของท่านเพื่อเข้าดู
          (มีผล 8 ชั่วโมง · ทุกการเข้าถึงถูกบันทึก log)
        </p>
        <div>
          <label className="label">เลขใบประกอบวิชาชีพ</label>
          <input className="input" value={license} autoComplete="off"
            onChange={(e) => setLicense(e.target.value)} placeholder="เช่น ว.12345" />
        </div>
        {err && <p className="text-sm text-rose-600">✗ {err}</p>}
        <button type="button" disabled={busy || license.trim().length === 0} onClick={unlock}
          className="btn-primary w-full py-2.5 disabled:opacity-50">
          {busy ? "กำลังตรวจสอบ…" : "ปลดล็อกเข้าดูข้อมูล"}
        </button>
      </div>
    </div>
  );
}

function PatientList({ patients, pending }: { patients: PatientRow[]; pending: PendingRow[] }) {
  const [intake, setIntake] = useState<PendingRow | null>(null);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">โครงการ Mounjaro — ผู้ป่วยของฉัน</h1>
        <p className="text-sm text-slate-500">เห็นเฉพาะผู้ป่วยที่ท่านเป็นแพทย์เจ้าของไข้ · ทุกการเข้าถึงถูกบันทึก</p>
      </div>

      {pending.length > 0 && (
        <div className="card border-l-4 border-amber-300 bg-amber-50/50 space-y-2">
          <h2 className="font-bold text-amber-900 text-sm">รอตรวจคัดกรอง (รับเข้าโครงการ)</h2>
          {pending.map((p) => (
            <div key={p.enrollment_id} className="flex items-center justify-between gap-2 text-sm border-b border-amber-200 last:border-0 pb-1.5">
              <span className="text-slate-800">{p.employee_name}
                <span className="text-[11px] text-slate-400 ml-2">สนใจเมื่อ {p.enrolled_at?.slice(0, 10) ?? "—"}</span>
              </span>
              <button type="button" onClick={() => setIntake(p)}
                className="text-xs px-3 py-1.5 rounded-md bg-brand text-white font-bold">
                ทำ baseline + รับเข้าโครงการ
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card overflow-x-auto">
        {patients.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">ยังไม่มีผู้ป่วยในความดูแล</p>
        ) : (
          <table className="w-full text-sm whitespace-nowrap">
            <thead><tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3">HN</th><th className="py-2 pr-3">ชื่อ</th>
              <th className="py-2 pr-3 text-right">ขนาดยา</th><th className="py-2 pr-3 text-right">สัปดาห์</th>
              <th className="py-2 pr-3 text-right">น้ำหนักล่าสุด</th><th className="py-2 pr-3 text-right">% ลด</th>
              <th className="py-2 pr-3">นัดถัดไป</th><th className="py-2 pr-3">แจ้งเตือน</th><th className="py-2 pr-3"></th>
            </tr></thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-mono text-xs">{p.hn ?? "—"}</td>
                  <td className="py-2 pr-3 font-medium text-slate-800">
                    {p.employee_name}
                    {p.newSelfLog && <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-sky-500" title="มี self-log ใหม่" />}
                  </td>
                  <td className="py-2 pr-3 text-right">{p.dose != null ? `${p.dose} mg` : "—"}</td>
                  <td className="py-2 pr-3 text-right">{p.weekNo || "—"}</td>
                  <td className="py-2 pr-3 text-right">{p.latestWeight != null ? `${p.latestWeight}` : "—"}</td>
                  <td className="py-2 pr-3 text-right text-emerald-700">{p.lossPct != null ? `${p.lossPct.toFixed(1)}%` : "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{p.nextVisit ?? "—"}</td>
                  <td className="py-2 pr-3">
                    {p.alertLevel === "danger" ? <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-rose-100 text-rose-700">ต้องรีบดู</span>
                      : p.alertLevel === "warning" ? <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-100 text-amber-700">เฝ้าระวัง</span>
                      : <span className="text-slate-300 text-xs">ปกติ</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Link href={`/admin/mounjaro/${p.id}`} className="text-xs text-brand hover:underline">เปิด →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {intake && <BaselineModal pending={intake} onClose={() => setIntake(null)} />}
    </div>
  );
}

function BaselineModal({ pending, onClose }: { pending: PendingRow; onClose: () => void }) {
  const router = useRouter();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [hn, setHn] = useState("");
  const [b, setB] = useState<Record<string, string>>({});
  const [como, setComo] = useState<Record<string, boolean>>({});
  const [contra, setContra] = useState<Record<string, boolean>>({});
  const [meds, setMeds] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [start, setStart] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  async function save() {
    setBusy(true); setErr(null);
    try {
      const baseline: Record<string, number> = {};
      for (const k of ["weight", "height", "hr", "hba1c", "fbs", "waist", "target"]) {
        const v = num(b[k] ?? ""); if (v != null && !Number.isNaN(v)) baseline[k] = v;
      }
      const res = await fetch(apiUrl("/api/admin/mounjaro/baseline"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enrollment_id: pending.enrollment_id, hn: hn.trim() || undefined,
          baseline, comorbidities: como, contraindications: contra, medications: meds,
          notes: notes.trim() || undefined, start_date: start
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("บันทึกไม่สำเร็จ"); return; }
      onClose(); router.refresh();
    } finally { setBusy(false); }
  }

  const Num = (k: string, label: string, unit?: string) => (
    <div>
      <label className="label">{label}{unit ? ` (${unit})` : ""}</label>
      <input type="number" step="0.1" className="input" value={b[k] ?? ""}
        onChange={(e) => setB((p) => ({ ...p, [k]: e.target.value }))} />
    </div>
  );
  const Checks = (state: Record<string, boolean>, set: (f: (p: Record<string, boolean>) => Record<string, boolean>) => void,
    items: Array<[string, string]>) => (
    <div className="flex flex-wrap gap-2">
      {items.map(([k, label]) => (
        <label key={k} className="flex items-center gap-1.5 text-sm border border-slate-200 rounded-lg px-2 py-1 cursor-pointer">
          <input type="checkbox" checked={!!state[k]} onChange={(e) => set((p) => ({ ...p, [k]: e.target.checked }))} />
          {label}
        </label>
      ))}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800">Baseline — {pending.employee_name}</h3>
        <p className="text-[11px] text-slate-500">ผู้สมัครต้องลงทะเบียนเป็นผู้ป่วยที่ AT HOME CLINIC ก่อน แล้วกรอก HN ที่นี่</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div><label className="label">HN</label><input className="input" value={hn} onChange={(e) => setHn(e.target.value)} /></div>
          {Num("weight", "น้ำหนัก", "กก.")}{Num("height", "ส่วนสูง", "ซม.")}
          {Num("hr", "ชีพจร", "bpm")}{Num("hba1c", "HbA1c", "%")}{Num("fbs", "FBS", "mg/dL")}
          {Num("waist", "รอบเอว", "ซม.")}{Num("target", "น้ำหนักเป้าหมาย", "กก.")}
          <div><label className="label">เริ่มโครงการ</label><input type="date" className="input" value={start} onChange={(e) => setStart(e.target.value)} /></div>
        </div>
        <div><div className="text-xs font-bold text-slate-600 mb-1">โรคร่วม</div>
          {Checks(como, setComo, [["dm", "เบาหวาน"], ["htn", "ความดัน"], ["dlp", "ไขมัน"], ["cvd", "หัวใจ"], ["ckd", "ไต"], ["panc", "ตับอ่อน"], ["gb", "ถุงน้ำดี"]])}</div>
        <div><div className="text-xs font-bold text-rose-600 mb-1">ข้อห้ามใช้ยา (ติ๊กแล้วระบบเตือน DANGER)</div>
          {Checks(contra, setContra, [["mtc", "MTC"], ["men2", "MEN2"], ["preg", "ตั้งครรภ์"], ["allergy", "แพ้ยา"]])}</div>
        <div><div className="text-xs font-bold text-slate-600 mb-1">ยาที่ใช้</div>
          {Checks(meds, setMeds, [["insulin", "Insulin"], ["su", "SU"], ["met", "Metformin"], ["sglt2", "SGLT2"], ["ocp", "ยาคุม"]])}</div>
        <div><label className="label">หมายเหตุ</label><textarea className="input text-sm" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        {err && <p className="text-sm text-rose-600">✗ {err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">ยกเลิก</button>
          <button type="button" onClick={save} disabled={busy} className="flex-1 btn-primary py-2.5 disabled:opacity-50">{busy ? "กำลังบันทึก…" : "รับเข้าโครงการ"}</button>
        </div>
      </div>
    </div>
  );
}
