"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Alert } from "@/lib/mounjaro-alerts";

type Visit = {
  date: string | null; dose: number | null; weight: number | null; hr: number | null;
  decision: string | null; next_visit: string | null; notes: string | null;
};
type SelfLog = {
  id: number; date: string | null; weight: number | null; injection_done: boolean;
  notes_for_doctor: string | null; doctor_reply: string | null;
};

const SIDE_EFFECTS = [
  ["nausea", "คลื่นไส้"], ["vomit", "อาเจียน"], ["diarrhea", "ท้องเสีย"], ["const", "ท้องผูก"],
  ["abdomen", "ปวดท้อง"], ["tachy", "ใจสั่น"], ["fatigue", "อ่อนเพลีย"], ["inject", "บริเวณฉีด"]
] as const;
const DOSES = [2.5, 5, 7.5, 10, 12.5, 15];

export default function PatientDetailClient(props: {
  patientId: number; employeeName: string; hn: string | null; startDate: string | null;
  notes: string | null; baseline: Record<string, number>;
  comorbidities: Record<string, boolean>; contraindications: Record<string, boolean>;
  medications: Record<string, boolean>;
  visits: Visit[]; selfLogs: SelfLog[]; alerts: Alert[];
}) {
  const { patientId, employeeName, hn, startDate, baseline, visits, selfLogs, alerts } = props;
  const router = useRouter();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

  const last = visits[visits.length - 1] ?? null;
  const dangers = alerts.filter((a) => a.level === "danger");
  const warnings = alerts.filter((a) => a.level === "warning");

  return (
    <div className="space-y-4">
      <Link href="/admin/mounjaro" className="text-xs text-brand hover:underline">← กลับรายชื่อผู้ป่วย</Link>

      <div className="card space-y-1">
        <h1 className="text-xl font-bold text-slate-800">{employeeName}</h1>
        <p className="text-xs text-slate-500">
          HN {hn ?? "—"} · เริ่มโครงการ {startDate ?? "—"}
          {baseline.weight != null && <> · เริ่มต้น {baseline.weight} กก.</>}
          {baseline.target != null && <> · เป้าหมาย {baseline.target} กก.</>}
        </p>
      </div>

      {/* Safety alerts */}
      {(dangers.length > 0 || warnings.length > 0) && (
        <div className="space-y-2">
          {dangers.map((a, i) => (
            <div key={`d${i}`} className="rounded-lg border-2 border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <b>เร่งด่วน:</b> {a.message}
            </div>
          ))}
          {warnings.map((a, i) => (
            <div key={`w${i}`} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <b>เฝ้าระวัง:</b> {a.message}
            </div>
          ))}
        </div>
      )}

      {/* Titration timeline */}
      <div className="card">
        <h2 className="font-bold text-slate-800 text-sm mb-2">การปรับขนาดยา (Titration)</h2>
        <div className="flex items-center gap-1 flex-wrap text-xs">
          {DOSES.map((dose) => {
            const reached = visits.some((v) => v.dose === dose);
            const current = last?.dose === dose;
            return (
              <span key={dose}>
                <span className={`px-2 py-1 rounded-md font-bold ${
                  current ? "bg-brand text-white" : reached ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"}`}>
                  {dose}
                </span>
                {dose !== 15 && <span className="text-slate-300 mx-0.5">→</span>}
              </span>
            );
          })}
          <span className="text-[11px] text-slate-400 ml-2">mg</span>
        </div>
      </div>

      {/* Visit history */}
      <div className="card overflow-x-auto">
        <h2 className="font-bold text-slate-800 text-sm mb-2">ประวัติการนัด</h2>
        {visits.length === 0 ? <p className="text-xs text-slate-400">ยังไม่มีบันทึก</p> : (
          <table className="w-full text-xs whitespace-nowrap">
            <thead><tr className="text-left text-slate-500 border-b">
              <th className="py-1 pr-2">วันที่</th><th className="py-1 pr-2">ขนาดยา</th><th className="py-1 pr-2">น้ำหนัก</th>
              <th className="py-1 pr-2">ชีพจร</th><th className="py-1 pr-2">การตัดสินใจ</th><th className="py-1 pr-2">นัดถัดไป</th>
            </tr></thead>
            <tbody>
              {[...visits].reverse().map((v, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1 pr-2 font-mono">{v.date ?? "—"}</td>
                  <td className="py-1 pr-2">{v.dose != null ? `${v.dose} mg` : "—"}</td>
                  <td className="py-1 pr-2">{v.weight ?? "—"}</td>
                  <td className="py-1 pr-2">{v.hr ?? "—"}</td>
                  <td className="py-1 pr-2">{v.decision ?? "—"}</td>
                  <td className="py-1 pr-2 font-mono">{v.next_visit ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <VisitForm patientId={patientId} today={today} defaultDose={last?.dose ?? null} onSaved={() => router.refresh()} />

      {/* Self-logs from the employee + reply */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">บันทึกจากผู้ป่วย (self-log)</h2>
        {selfLogs.length === 0 ? <p className="text-xs text-slate-400">ยังไม่มี self-log</p> :
          selfLogs.slice(0, 12).map((l) => (
            <SelfLogRow key={l.id} log={l} onReplied={() => router.refresh()} />
          ))}
      </div>
    </div>
  );
}

function VisitForm({ patientId, today, defaultDose, onSaved }: {
  patientId: number; today: string; defaultDose: number | null; onSaved: () => void;
}) {
  const [date, setDate] = useState(today);
  const [dose, setDose] = useState<string>(defaultDose != null ? String(defaultDose) : "");
  const [f, setF] = useState<Record<string, string>>({});
  const [se, setSe] = useState<Record<string, number>>({});
  const [adherence, setAdherence] = useState("full");
  const [decision, setDecision] = useState("maintain");
  const [hypo, setHypo] = useState("");
  const [next, setNext] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const num = (s: string) => (s.trim() === "" ? null : Number(s));
  async function save() {
    setBusy(true); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/visit"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId, date,
          dose: dose === "" ? null : Number(dose),
          weight: num(f.weight ?? ""), bp: f.bp || undefined, hr: num(f.hr ?? ""),
          hba1c: num(f.hba1c ?? ""), fbs: num(f.fbs ?? ""), waist: num(f.waist ?? ""),
          side_effects: se, hypo_count: num(hypo),
          adherence, decision, next_visit: next || null, notes: notes.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: "บันทึกไม่สำเร็จ" }); return; }
      setMsg({ kind: "ok", text: "บันทึกการนัดแล้ว" });
      setF({}); setSe({}); setHypo(""); setNext(""); setNotes("");
      onSaved();
    } finally { setBusy(false); }
  }
  const N = (k: string, label: string) => (
    <div><label className="label">{label}</label>
      <input type="number" step="0.1" className="input" value={f[k] ?? ""} onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))} /></div>
  );

  return (
    <div className="card space-y-3">
      <h2 className="font-bold text-slate-800 text-sm">บันทึกการนัดใหม่</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div><label className="label">วันที่</label><input type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="label">ขนาดยา (mg)</label>
          <select className="input" value={dose} onChange={(e) => setDose(e.target.value)}>
            <option value="">—</option>{DOSES.map((d) => <option key={d} value={d}>{d}</option>)}
          </select></div>
        {N("weight", "น้ำหนัก")}{N("hr", "ชีพจร")}{N("hba1c", "HbA1c")}{N("fbs", "FBS")}{N("waist", "รอบเอว")}
        <div><label className="label">ความดัน</label><input className="input" value={f.bp ?? ""} onChange={(e) => setF((p) => ({ ...p, bp: e.target.value }))} placeholder="120/80" /></div>
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-bold text-slate-600">อาการข้างเคียง (0–3)</div>
        {SIDE_EFFECTS.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-sm text-slate-700 flex-1 min-w-[120px]">{label}</span>
            <div className="flex gap-1">{[0, 1, 2, 3].map((n) => (
              <button key={n} type="button" onClick={() => setSe((p) => ({ ...p, [k]: n }))}
                className={`text-[11px] w-7 py-1 rounded-md border ${(se[k] ?? 0) === n ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-500"}`}>{n}</button>
            ))}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div><label className="label">น้ำตาลต่ำ (ครั้ง)</label><input type="number" className="input" value={hypo} onChange={(e) => setHypo(e.target.value)} /></div>
        <div><label className="label">การใช้ยา</label>
          <select className="input" value={adherence} onChange={(e) => setAdherence(e.target.value)}>
            <option value="full">ครบ</option><option value="missed1">ขาด 1</option><option value="missed2">ขาด ≥2</option><option value="held">หยุดยา</option>
          </select></div>
        <div><label className="label">การตัดสินใจ</label>
          <select className="input" value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="maintain">คงขนาด</option><option value="increase">เพิ่มขนาด</option><option value="decrease">ลดขนาด</option><option value="hold">หยุด</option>
          </select></div>
        <div><label className="label">นัดถัดไป</label><input type="date" className="input" value={next} onChange={(e) => setNext(e.target.value)} /></div>
      </div>
      <div><label className="label">บันทึกแพทย์</label><textarea className="input text-sm" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      {msg && <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>}
      <button type="button" onClick={save} disabled={busy} className="btn-primary w-full py-2.5 disabled:opacity-50">{busy ? "กำลังบันทึก…" : "บันทึกการนัด"}</button>
    </div>
  );
}

function SelfLogRow({ log, onReplied }: { log: SelfLog; onReplied: () => void }) {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  async function send() {
    if (reply.trim() === "") return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/reply"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ self_log_id: log.id, reply: reply.trim() })
      });
      if (res.ok) { onReplied(); }
    } finally { setBusy(false); }
  }
  return (
    <div className="text-xs border-b last:border-0 pb-2">
      <div className="font-mono text-slate-500">{log.date}
        {log.weight != null && <> · {log.weight} กก.</>}
        {log.injection_done && <> · ฉีดแล้ว</>}
      </div>
      {log.notes_for_doctor && <div className="text-slate-700 mt-0.5">ผู้ป่วย: {log.notes_for_doctor}</div>}
      {log.doctor_reply ? (
        <div className="text-emerald-700 bg-emerald-50 rounded px-2 py-1 mt-1">แพทย์: {log.doctor_reply}</div>
      ) : (
        <div className="flex gap-1 mt-1">
          <input className="input !py-1 text-xs flex-1" value={reply} placeholder="ตอบผู้ป่วย…"
            onChange={(e) => setReply(e.target.value)} />
          <button type="button" onClick={send} disabled={busy} className="text-xs px-3 rounded-md bg-brand text-white font-bold disabled:opacity-50">ตอบ</button>
        </div>
      )}
    </div>
  );
}
