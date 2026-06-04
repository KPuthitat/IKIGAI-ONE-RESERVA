"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";

// Mounjaro Employee Wellness — employee self-service. Thai (official),
// mobile-first (the self-log is meant to be filled on a phone).

type Enrollment = {
  status: "pending" | "active" | "withdrawn" | "completed";
  enrolled_at: string | null;
  withdrawn_reason: string | null;
} | null;
type Patient = {
  hn: string | null; start_date: string | null; notes: string | null;
  baseline: Record<string, number>;
} | null;
type Visit = { date: string | null; dose: number | null; weight: number | null; next_visit: string | null };
type SelfLog = { date: string | null; weight: number | null; injection_done: boolean; doctor_reply: string | null };

const SIDE_EFFECTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "nausea", label: "คลื่นไส้" },
  { key: "vomit", label: "อาเจียน" },
  { key: "diarrhea", label: "ท้องเสีย" },
  { key: "const", label: "ท้องผูก" },
  { key: "abdomen", label: "ปวดท้อง" },
  { key: "tachy", label: "ใจสั่น / หัวใจเต้นเร็ว" },
  { key: "fatigue", label: "อ่อนเพลีย" },
  { key: "inject", label: "ปฏิกิริยาบริเวณที่ฉีด" }
];
const SEV = ["ไม่มี", "เล็กน้อย", "ปานกลาง", "รุนแรง"];

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400_000);
}

export default function MounjaroSelfClient({
  enrollment, patient, visits, selfLogs
}: {
  enrollment: Enrollment; patient: Patient; visits: Visit[]; selfLogs: SelfLog[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmErase, setConfirmErase] = useState(false);

  async function act(action: "enroll" | "withdraw" | "erase", reason?: string) {
    setBusy(action); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/enrollment"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg({ kind: "err", text: "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง" }); return; }
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
    } finally { setBusy(null); }
  }

  const status = enrollment?.status ?? "none";

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="card space-y-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h1 className="text-xl font-bold text-slate-800">โครงการ Mounjaro Employee Wellness</h1>
          <StatusBadge status={status} />
        </div>
        <p className="text-xs text-slate-500">
          โครงการดูแลน้ำหนักภายใต้การดูแลของแพทย์ IKIGAI MediHealth (AT HOME CLINIC)
        </p>
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div>
      )}

      {/* ── NO ENROLLMENT ── */}
      {status === "none" && (
        <div className="card space-y-3">
          <p className="text-sm text-slate-700 leading-relaxed">
            สนใจเข้าร่วมโครงการลดน้ำหนักด้วยยา Mounjaro (Tirzepatide) ภายใต้การดูแลของแพทย์ใช่ไหม?
            กดปุ่มด้านล่างเพื่อแสดงความสนใจ คลินิกจะติดต่อนัดตรวจคัดกรองกลับภายใน 3 วันทำการ
          </p>
          <button type="button" disabled={busy !== null}
            onClick={() => act("enroll")}
            className="btn-primary w-full py-3 disabled:opacity-50">
            {busy === "enroll" ? "กำลังส่ง…" : "สนใจเข้าร่วมโครงการ"}
          </button>
        </div>
      )}

      {/* ── PENDING ── */}
      {status === "pending" && (
        <div className="card space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 leading-relaxed">
            รอการนัดตรวจคัดกรอง — คลินิก AT HOME จะติดต่อกลับภายใน 3 วันทำการ
            หลังตรวจคัดกรองและแพทย์รับเข้าโครงการแล้ว หน้านี้จะแสดงข้อมูลการรักษาของคุณ
          </div>
          <p className="text-[11px] text-slate-500">
            ส่งความสนใจเมื่อ {enrollment?.enrolled_at ? new Date(enrollment.enrolled_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "—"}
          </p>
          <button type="button" disabled={busy !== null}
            onClick={() => act("withdraw", "ยกเลิกคำขอเข้าร่วม")}
            className="w-full py-2.5 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium disabled:opacity-50">
            ยกเลิกคำขอ
          </button>
        </div>
      )}

      {/* ── ACTIVE ── */}
      {status === "active" && (
        <ActiveView patient={patient} visits={visits} selfLogs={selfLogs}
          busy={busy} setBusy={setBusy} setMsg={setMsg}
          onAct={act} confirmErase={confirmErase} setConfirmErase={setConfirmErase} />
      )}

      {/* ── WITHDRAWN / COMPLETED ── */}
      {(status === "withdrawn" || status === "completed") && (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">
            {status === "completed" ? "สรุปผลโครงการ" : "ออกจากโครงการแล้ว"}
          </h2>
          {patient && (
            <p className="text-sm text-slate-700">
              น้ำหนักเริ่มต้น {patient.baseline.weight ?? "—"} กก.
              {visits[0]?.weight != null && <> · ล่าสุด {visits[0].weight} กก.</>}
            </p>
          )}
          {enrollment?.withdrawn_reason && (
            <p className="text-xs text-slate-500">เหตุผล: {enrollment.withdrawn_reason}</p>
          )}
          <p className="text-[11px] text-slate-400">
            ข้อมูลเวชระเบียนถูกเก็บรักษาตามกฎหมายที่คลินิกกำหนด — ติดต่อคลินิกหากต้องการสอบถาม
          </p>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { t: string; c: string }> = {
    none:      { t: "ยังไม่เข้าร่วม", c: "bg-slate-100 text-slate-500" },
    pending:   { t: "รอนัดตรวจคัดกรอง", c: "bg-amber-100 text-amber-700" },
    active:    { t: "อยู่ในโครงการ", c: "bg-emerald-100 text-emerald-700" },
    withdrawn: { t: "ออกจากโครงการ", c: "bg-slate-200 text-slate-600" },
    completed: { t: "จบโครงการ", c: "bg-sky-100 text-sky-700" }
  };
  const m = map[status] ?? map.none;
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${m.c}`}>{m.t}</span>;
}

function ActiveView({
  patient, visits, selfLogs, busy, setBusy, setMsg, onAct, confirmErase, setConfirmErase
}: {
  patient: Patient; visits: Visit[]; selfLogs: SelfLog[];
  busy: string | null; setBusy: (s: string | null) => void;
  setMsg: (m: { kind: "ok" | "err"; text: string } | null) => void;
  onAct: (a: "withdraw" | "erase", reason?: string) => void;
  confirmErase: boolean; setConfirmErase: (b: boolean) => void;
}) {
  const router = useRouter();
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const baseW = patient?.baseline.weight ?? null;
  const target = patient?.baseline.target ?? null;
  const latestVisit = visits[0] ?? null;
  const latestLogWeight = selfLogs.find((l) => l.weight != null)?.weight ?? null;
  const curW = latestVisit?.weight ?? latestLogWeight ?? baseW;
  const lossPct = (baseW && curW) ? ((baseW - curW) / baseW) * 100 : null;
  const nextDays = daysUntil(latestVisit?.next_visit ?? null);

  // self-log form
  const [date, setDate] = useState(today);
  const [weight, setWeight] = useState("");
  const [injected, setInjected] = useState(false);
  const [se, setSe] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("");

  async function submitLog() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setMsg({ kind: "err", text: "เลือกวันที่" }); return; }
    setBusy("log"); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/self-log"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date, weight: weight.trim() === "" ? null : Number(weight),
          injection_done: injected, side_effect_diary: se,
          notes_for_doctor: notes.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error === "not_active" ? "บันทึกได้เฉพาะผู้ที่อยู่ในโครงการ" : "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกเรียบร้อย — แพทย์จะเห็นข้อมูลของคุณ" });
      setWeight(""); setInjected(false); setSe({}); setNotes("");
      router.refresh();
    } finally { setBusy(null); }
  }

  return (
    <>
      {/* Dashboard stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="น้ำหนักปัจจุบัน" value={curW != null ? `${curW} กก.` : "—"} />
        <Stat label="ลดลงจากเริ่มต้น" value={lossPct != null ? `${lossPct.toFixed(1)}%` : "—"} accent="emerald" />
        <Stat label="ขนาดยาปัจจุบัน" value={latestVisit?.dose != null ? `${latestVisit.dose} mg` : "—"} />
        <Stat label="นัดถัดไป"
          value={nextDays != null ? (nextDays >= 0 ? `อีก ${nextDays} วัน` : "เลยกำหนด") : "—"}
          sub={latestVisit?.next_visit ?? undefined} accent={nextDays != null && nextDays < 0 ? "rose" : undefined} />
      </div>

      {baseW && target && (
        <div className="card">
          <div className="text-xs text-slate-500 mb-1">ความคืบหน้าสู่เป้าหมาย</div>
          <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-emerald-400"
              style={{ width: `${Math.max(0, Math.min(100, baseW > target ? ((baseW - (curW ?? baseW)) / (baseW - target)) * 100 : 0)).toFixed(0)}%` }} />
          </div>
          <div className="text-[11px] text-slate-400 mt-1">
            เริ่มต้น {baseW} กก. · เป้าหมาย {target} กก.
          </div>
        </div>
      )}

      {/* Self-log form */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">บันทึกอาการรายสัปดาห์</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">วันที่</label>
            <input type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">น้ำหนัก (กก.)</label>
            <input type="number" inputMode="decimal" min="0" step="0.1" className="input"
              value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="เช่น 82.5" />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={injected} onChange={(e) => setInjected(e.target.checked)} />
          ฉีดยาตามกำหนดในสัปดาห์นี้แล้ว
        </label>
        <div className="space-y-2">
          <div className="text-xs font-bold text-slate-600">อาการข้างเคียง (เลือกระดับ)</div>
          {SIDE_EFFECTS.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-sm text-slate-700 flex-1 min-w-[130px]">{s.label}</span>
              <div className="flex gap-1">
                {SEV.map((lbl, n) => (
                  <button key={n} type="button"
                    onClick={() => setSe((p) => ({ ...p, [s.key]: n }))}
                    className={`text-[11px] px-2 py-1 rounded-md border ${
                      (se[s.key] ?? 0) === n
                        ? "bg-brand text-white border-brand"
                        : "border-slate-300 text-slate-500"}`}>
                    {n} {lbl}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div>
          <label className="label">บันทึก / คำถามถึงแพทย์</label>
          <textarea className="input text-sm" rows={2} value={notes} maxLength={1000}
            onChange={(e) => setNotes(e.target.value)} placeholder="เช่น อยากปรึกษาเรื่อง…" />
        </div>
        <button type="button" disabled={busy === "log"} onClick={submitLog}
          className="btn-primary w-full py-2.5 disabled:opacity-50">
          {busy === "log" ? "กำลังบันทึก…" : "บันทึกอาการ"}
        </button>
      </div>

      {/* Baseline + visit history (read-only) */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ข้อมูลการรักษา (ดูอย่างเดียว)</h2>
        {patient && (
          <p className="text-xs text-slate-500">
            HN {patient.hn ?? "—"} · เริ่มโครงการ {patient.start_date ?? "—"}
            {baseW != null && <> · น้ำหนักเริ่มต้น {baseW} กก.</>}
          </p>
        )}
        {visits.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีบันทึกการนัด</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-left text-slate-500 border-b">
                <th className="py-1 pr-2">วันที่</th><th className="py-1 pr-2">ขนาดยา</th>
                <th className="py-1 pr-2">น้ำหนัก</th><th className="py-1 pr-2">นัดถัดไป</th>
              </tr></thead>
              <tbody>
                {visits.map((v, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1 pr-2 font-mono">{v.date ?? "—"}</td>
                    <td className="py-1 pr-2">{v.dose != null ? `${v.dose} mg` : "—"}</td>
                    <td className="py-1 pr-2">{v.weight != null ? `${v.weight} กก.` : "—"}</td>
                    <td className="py-1 pr-2 font-mono">{v.next_visit ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* My self-logs + doctor replies */}
      {selfLogs.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">บันทึกของฉัน</h2>
          {selfLogs.slice(0, 8).map((l, i) => (
            <div key={i} className="text-xs border-b last:border-0 pb-1.5">
              <span className="font-mono text-slate-500">{l.date}</span>
              {l.weight != null && <> · {l.weight} กก.</>}
              {l.injection_done && <> · ฉีดยาแล้ว</>}
              {l.doctor_reply && (
                <div className="mt-0.5 text-emerald-700 bg-emerald-50 rounded px-2 py-1">
                  แพทย์: {l.doctor_reply}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* PDPA + leave actions */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">ข้อมูลส่วนตัว & สิทธิของฉัน (PDPA)</h2>
        <div className="flex flex-wrap gap-2">
          <a href={apiUrl("/api/mounjaro/export")}
            className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
            ดาวน์โหลดข้อมูลของฉัน (JSON)
          </a>
          <button type="button" disabled={busy !== null}
            onClick={() => onAct("withdraw", "ขอออกจากโครงการ")}
            className="text-xs px-3 py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
            ขอออกจากโครงการ
          </button>
          {!confirmErase ? (
            <button type="button" onClick={() => setConfirmErase(true)}
              className="text-xs px-3 py-2 rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50">
              ขอลบข้อมูลของฉัน
            </button>
          ) : (
            <button type="button" disabled={busy !== null}
              onClick={() => onAct("erase")}
              className="text-xs px-3 py-2 rounded-lg bg-rose-600 text-white font-bold disabled:opacity-50">
              ยืนยันลบข้อมูล (กดอีกครั้ง)
            </button>
          )}
        </div>
        <p className="text-[10px] text-slate-400 leading-relaxed">
          การลบจะนำข้อมูลออกจากพอร์ทัลและยุติการเข้าร่วมโครงการ — ส่วนเวชระเบียนที่แพทย์บันทึก
          จะถูกเก็บรักษาตามระยะเวลาที่กฎหมายกำหนด ภายใต้การเข้าถึงเฉพาะแพทย์เจ้าของไข้
        </p>
      </div>
    </>
  );
}

function Stat({ label, value, sub, accent }: {
  label: string; value: string; sub?: string; accent?: "emerald" | "rose";
}) {
  const c = accent === "emerald" ? "text-emerald-700" : accent === "rose" ? "text-rose-600" : "text-slate-800";
  return (
    <div className="card">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${c}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 font-mono">{sub}</div>}
    </div>
  );
}
