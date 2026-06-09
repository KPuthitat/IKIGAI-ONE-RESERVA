"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import {
  EXERCISE_CATALOG, EXERCISE_LEVELS, RPE_SCALE, getActivity, kcalEstimate,
  levelLabel, rpeLabel, activityLabel, REST_ACTIVITY_ID, type ExerciseLevel
} from "@/lib/exercise-catalog";

// Mounjaro Employee Wellness — employee self-service. Thai (official),
// mobile-first (the self-log is meant to be filled on a phone).

type Enrollment = {
  status: "pending" | "active" | "withdrawn" | "completed";
  enrolled_at: string | null;
  withdrawn_reason: string | null;
  pendingAction: "withdraw" | "erase" | null;
  invitedByDoctorId: number | null;
  employeeConfirmedAt: string | null;
} | null;
type Facility = { name: string; logo: string };
type Patient = {
  hn: string | null; start_date: string | null; notes: string | null;
  baseline: Record<string, number>;
} | null;
type Visit = { date: string | null; dose: number | null; weight: number | null; next_visit: string | null };
type SelfLog = {
  id: number;
  date: string | null; weight: number | null; injection_done: boolean;
  bp: string | null; hr: number | null; fbs: number | null; diary: string | null;
  notes_for_doctor: string | null;
  side_effect_diary_json: string | null;
  doctor_reply: string | null;
};
type ConsentInfo = { needed: boolean; version: string | null; body: string | null };
type AuditEntry = { action: string; by_name: string | null; created_at: string };
type ExLog = {
  id: number; date: string; activity_id: string; level: string;
  duration_min: number; met: number; rpe: number;
  kcal_est: number | null; low_energy_flag: boolean;
};
type ExSummary = {
  days: number; totalMin: number; totalKcal: number | null;
  avgRpe: number | null; streak: number; flagCount: number;
};
type ExerciseData = { logs: ExLog[]; summary: ExSummary };

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
  enrollment, patient, visits, selfLogs, exercise, consent, audit, hasPin, facility
}: {
  enrollment: Enrollment; patient: Patient; visits: Visit[]; selfLogs: SelfLog[];
  exercise: ExerciseData;
  consent: ConsentInfo; audit: AuditEntry[];
  /** Whether the employee has a 4-digit PIN set (everyone onboarded does).
   *  Drives the PIN field in the destructive-action confirm modal. */
  hasPin: boolean;
  /** The company's health-consulting clinic (name + logo) — pulled from
   *  the editable facility config, replacing the old hardcoded AT HOME. */
  facility: Facility;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Destructive action awaiting PIN + typed-phrase confirmation.
  const [destructive, setDestructive] = useState<"withdraw" | "erase" | null>(null);

  // enroll / pending-cancel — no PIN needed (opt-in / harmless).
  async function act(action: "enroll" | "withdraw", reason?: string) {
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
  // Doctor-invite states:
  const isInvited = enrollment?.invitedByDoctorId && !enrollment?.employeeConfirmedAt;
  const isConfirmedPending = enrollment?.status === "pending" && enrollment?.employeeConfirmedAt;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <div className="card space-y-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={facility.logo} alt="" className="w-10 h-10 rounded object-contain bg-slate-50 border border-slate-100" />
            <h1 className="text-xl font-bold text-slate-800">โครงการควบคุมน้ำหนัก</h1>
          </div>
          <StatusBadge status={status} />
        </div>
        <p className="text-xs text-slate-500">
          โครงการดูแลน้ำหนักภายใต้การดูแลของแพทย์ · {facility.name}
        </p>
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</div>
      )}

      {/* ── NO ENROLLMENT — not invited yet ── */}
      {status === "none" && (
        <div className="card space-y-3">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-sm text-slate-600 leading-relaxed">
            ขณะนี้ยังไม่ได้รับคำเชิญจากแพทย์เข้าร่วมโครงการควบคุมน้ำหนัก —
            หากสนใจ กรุณาติดต่อแพทย์ที่ดูแลเพื่อขอรับคำเชิญ
          </div>
        </div>
      )}

      {/* ── INVITED — waiting for employee to confirm ── */}
      {isInvited && (
        <div className="card space-y-3">
          <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 text-sm text-teal-800 leading-relaxed">
            <b>แพทย์เชิญคุณเข้าร่วมโครงการควบคุมน้ำหนัก</b> — กดยืนยันด้านล่างเพื่อเข้าร่วม
            หลังจากนั้นแพทย์จะนัดหมายตรวจ Baseline และเปิดแฟ้มการรักษาให้คุณ
          </div>
          <button type="button" disabled={busy !== null}
            onClick={() => act("enroll")}
            className="btn-primary w-full py-3 disabled:opacity-50">
            {busy === "enroll" ? "กำลังยืนยัน…" : "ยืนยันเข้าร่วมโครงการ"}
          </button>
        </div>
      )}

      {/* ── CONFIRMED — waiting for doctor's intake ── */}
      {isConfirmedPending && (
        <div className="card space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 leading-relaxed">
            คุณยืนยันรับคำเชิญแล้ว — รอแพทย์นัดหมายตรวจ Baseline และเปิดแฟ้มการรักษา
            ระบบจะแจ้งเตือนทาง LINE เมื่อพร้อมใช้งาน
          </div>
          <p className="text-[11px] text-slate-500">
            ยืนยันเมื่อ {enrollment?.enrolled_at ? new Date(enrollment.enrolled_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "—"}
          </p>
        </div>
      )}

      {/* ── ACTIVE — full view ── */}
      {status === "active" && !isInvited && !isConfirmedPending && (
        <ActiveView patient={patient} visits={visits} selfLogs={selfLogs} exercise={exercise}
          busy={busy} setBusy={setBusy} setMsg={setMsg}
          pendingAction={enrollment?.pendingAction ?? null}
          onRequestDestructive={(a) => { setMsg(null); setDestructive(a); }} />
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
          {status === "withdrawn" && (
            <div className="pt-1 border-t border-slate-100 mt-1">
              <p className="text-xs text-slate-600 mb-2">เปลี่ยนใจอยากกลับเข้าร่วมอีกครั้งใช่ไหม?</p>
              <button type="button" disabled={busy !== null}
                onClick={() => { if (window.confirm("ส่งคำขอกลับเข้าร่วมโครงการอีกครั้ง? คลินิกจะติดต่อนัดตรวจคัดกรองกลับ")) act("enroll"); }}
                className="btn-primary w-full py-2.5 disabled:opacity-50">
                {busy === "enroll" ? "กำลังส่ง…" : "สนใจกลับเข้าร่วมโครงการอีกครั้ง"}
              </button>
            </div>
          )}
        </div>
      )}

      {status === "active" && !isInvited && !isConfirmedPending && <AuditViewer audit={audit} />}
      {consent.needed && status === "active" && <ConsentModal body={consent.body} logo={facility.logo} />}
      {destructive && (
        <ConfirmDestructiveModal
          action={destructive}
          hasPin={hasPin}
          onClose={() => setDestructive(null)}
          onDone={() => { setDestructive(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

// Confirm modal for the two irreversible-feeling actions. Requires the
// employee to (1) type the exact phrase and (2) enter their PIN — so a
// stray tap can't withdraw them or wipe their portal data.
function ConfirmDestructiveModal({
  action, hasPin, onClose, onDone
}: {
  action: "withdraw" | "erase";
  hasPin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const phrase = action === "withdraw" ? "ออกจากโครงการ" : "ลบข้อมูล";
  const title = action === "withdraw" ? "ยืนยันการออกจากโครงการ" : "ยืนยันการลบข้อมูล";
  const [typed, setTyped] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const phraseOk = typed.trim() === phrase;
  const pinOk = !hasPin || /^\d{4}$/.test(pin);
  const canSubmit = phraseOk && pinOk && !busy;

  async function confirm() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/enrollment"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          reason: action === "withdraw" ? "ขอออกจากโครงการ" : undefined,
          pin: hasPin ? pin : undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.error === "bad_pin" ? "PIN ไม่ถูกต้อง ลองใหม่อีกครั้ง" : "ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
        return;
      }
      onDone();
    } catch {
      setErr("เกิดข้อผิดพลาด ลองใหม่อีกครั้ง");
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-rose-700">{title}</h3>
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-800 leading-relaxed">
          {action === "withdraw" ? (
            <>คุณกำลังจะส่งคำขอ<b>ออกจากโครงการ</b> — คำขอจะถูกส่งให้<b>แพทย์เจ้าของไข้อนุมัติ</b>ก่อน
              เมื่ออนุมัติแล้วหน้านี้จะหยุดแสดงข้อมูลการรักษา · <b>กลับเข้าร่วมใหม่ได้</b>ภายหลัง
              (เวชระเบียนที่แพทย์บันทึกยังถูกเก็บไว้)</>
          ) : (
            <>คุณกำลังจะส่งคำขอ<b>ลบข้อมูลออกจากพอร์ทัล</b> — คำขอจะถูกส่งให้<b>แพทย์เจ้าของไข้อนุมัติ</b>ก่อน ·
              เวชระเบียนที่แพทย์บันทึกจะถูกเก็บตามที่กฎหมายกำหนด (เข้าถึงเฉพาะแพทย์เจ้าของไข้)</>
          )}
        </div>
        <div>
          <label className="label">พิมพ์คำว่า &quot;{phrase}&quot; เพื่อยืนยัน</label>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)}
            placeholder={phrase} autoComplete="off" />
        </div>
        {hasPin && (
          <div>
            <label className="label">PIN 4 หลักของคุณ</label>
            <input className="input tracking-[0.5em] text-center" value={pin} inputMode="numeric"
              maxLength={4} autoComplete="off"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="••••" />
          </div>
        )}
        {err && <p className="text-sm text-rose-600">✗ {err}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium">
            ยกเลิก
          </button>
          <button type="button" onClick={confirm} disabled={!canSubmit}
            className="flex-1 py-2.5 rounded-lg bg-rose-600 text-white text-sm font-bold disabled:opacity-40">
            {busy ? "กำลังส่งคำขอ…" : "ส่งคำขอให้แพทย์อนุมัติ"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsentModal({ body, logo }: { body: string | null; logo: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [agree, setAgree] = useState(false);
  async function accept() {
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/consent"), { method: "POST" });
      if (res.ok) router.refresh();
    } finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logo} alt="" className="w-9 h-9 rounded object-contain bg-slate-50 border border-slate-100" />
          <h3 className="font-bold text-slate-800">ความยินยอมเปิดเผยข้อมูลทางสุขภาพ (PDPA)</h3>
        </div>
        <div className="max-h-64 overflow-y-auto whitespace-pre-line text-xs text-slate-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
          {body ?? "—"}
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          ข้าพเจ้าได้อ่านและยินยอมตามข้อความข้างต้น
        </label>
        <button type="button" onClick={accept} disabled={busy || !agree}
          className="btn-primary w-full py-2.5 disabled:opacity-50">
          {busy ? "กำลังบันทึก…" : "ยินยอมและเข้าใช้งาน"}
        </button>
      </div>
    </div>
  );
}

function AuditViewer({ audit }: { audit: AuditEntry[] }) {
  const [open, setOpen] = useState(false);
  const ACTION_TH: Record<string, string> = {
    read_own: "คุณเปิดดูข้อมูลตัวเอง", read_patient: "แพทย์เปิดดูข้อมูล",
    create_patient: "แพทย์สร้างเวชระเบียน", add_visit: "แพทย์บันทึกการนัด",
    reply_selflog: "แพทย์ตอบบันทึกอาการ", self_log: "คุณบันทึกอาการ",
    enroll: "สมัครเข้าโครงการ", withdraw: "ออกจากโครงการ", erase: "ขอลบข้อมูล",
    export: "ดาวน์โหลดข้อมูล", consent: "ให้ความยินยอม"
  };
  return (
    <div className="card">
      <button type="button" onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-sm font-bold text-slate-700">
        <span>ประวัติการเข้าถึงข้อมูลของฉัน (ใครเปิดดูบ้าง)</span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 max-h-64 overflow-y-auto">
          {audit.length === 0 ? (
            <p className="text-xs text-slate-400">ยังไม่มีบันทึก</p>
          ) : audit.map((a, i) => (
            <div key={i} className="text-xs border-b last:border-0 pb-1 flex justify-between gap-2">
              <span className="text-slate-700">
                {ACTION_TH[a.action] ?? a.action}
                {a.by_name && <span className="text-slate-400"> · {a.by_name}</span>}
              </span>
              <span className="text-slate-400 font-mono">
                {new Date(a.created_at).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })}
              </span>
            </div>
          ))}
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
  patient, visits, selfLogs, exercise, busy, setBusy, setMsg, pendingAction, onRequestDestructive
}: {
  patient: Patient; visits: Visit[]; selfLogs: SelfLog[]; exercise: ExerciseData;
  busy: string | null; setBusy: (s: string | null) => void;
  setMsg: (m: { kind: "ok" | "err"; text: string } | null) => void;
  pendingAction: "withdraw" | "erase" | null;
  onRequestDestructive: (a: "withdraw" | "erase") => void;
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

  // self-log form (daily)
  const [date, setDate] = useState(today);
  const [weight, setWeight] = useState("");
  const [injected, setInjected] = useState(false);
  const [bp, setBp] = useState("");
  const [hr, setHr] = useState("");
  const [fbs, setFbs] = useState("");
  const [se, setSe] = useState<Record<string, number>>({});
  const [diary, setDiary] = useState("");
  const [notes, setNotes] = useState("");
  // Edit an existing entry (owner 2026-06-09): editing health data needs the
  // staff's PIN and is audited server-side.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPin, setEditPin] = useState("");

  function resetForm() {
    setDate(today); setWeight(""); setInjected(false); setBp(""); setHr(""); setFbs("");
    setSe({}); setDiary(""); setNotes("");
  }
  function startEdit(l: SelfLog) {
    setEditingId(l.id);
    setDate(l.date ?? today);
    setWeight(l.weight != null ? String(l.weight) : "");
    setInjected(l.injection_done);
    setBp(l.bp ?? "");
    setHr(l.hr != null ? String(l.hr) : "");
    setFbs(l.fbs != null ? String(l.fbs) : "");
    setDiary(l.diary ?? "");
    setNotes(l.notes_for_doctor ?? "");
    let parsed: Record<string, number> = {};
    try {
      const o = l.side_effect_diary_json ? JSON.parse(l.side_effect_diary_json) : {};
      if (o && typeof o === "object") parsed = o as Record<string, number>;
    } catch { /* keep empty */ }
    setSe(parsed);
    setEditPin(""); setMsg(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function cancelEdit() { setEditingId(null); setEditPin(""); resetForm(); }

  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));
  async function submitLog() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setMsg({ kind: "err", text: "เลือกวันที่" }); return; }
    if (editingId != null && !/^\d{4}$/.test(editPin)) {
      setMsg({ kind: "err", text: "กรอก PIN 4 หลักเพื่อยืนยันการแก้ไข" }); return;
    }
    setBusy("log"); setMsg(null);
    try {
      const payload = {
        date, weight: numOrNull(weight),
        injection_done: injected, side_effect_diary: se,
        bp: bp.trim() || undefined,
        hr: numOrNull(hr),
        fbs: numOrNull(fbs),
        diary: diary.trim() || undefined,
        notes_for_doctor: notes.trim() || undefined
      };
      const res = await fetch(apiUrl("/api/mounjaro/self-log"), {
        method: editingId != null ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId != null ? { ...payload, id: editingId, pin: editPin } : payload)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        const text =
          j.error === "not_active" || j.error === "forbidden_or_not_active" ? "บันทึกได้เฉพาะผู้ที่อยู่ในโครงการ"
          : j.error === "wrong_pin" ? "PIN ไม่ถูกต้อง"
          : j.error === "no_pin_set" ? "ยังไม่ได้ตั้ง PIN — ตั้งที่หน้าลงเวลาก่อน"
          : "บันทึกไม่สำเร็จ";
        setMsg({ kind: "err", text });
        return;
      }
      setMsg({ kind: "ok", text: editingId != null
        ? "แก้ไขเรียบร้อย — ระบบบันทึกประวัติการแก้ไขไว้แล้ว"
        : "บันทึกเรียบร้อย — แพทย์จะเห็นข้อมูลของคุณ" });
      cancelEdit();
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

      {baseW && target && baseW > target && (() => {
        // Progress toward the goal weight, shown as a % (owner 2026-06-08).
        const pct = Math.max(0, Math.min(100, ((baseW - (curW ?? baseW)) / (baseW - target)) * 100));
        return (
          <div className="card">
            <div className="text-xs text-slate-500 mb-1">ความคืบหน้าสู่เป้าหมาย</div>
            <div className="flex items-end gap-3 mb-2.5">
              <div className="text-[44px] font-extrabold text-emerald-600 leading-[0.9] tabular-nums">{pct.toFixed(0)}%</div>
              <div className="text-[11px] text-slate-400 pb-1.5 leading-snug">
                เริ่มต้น {baseW} กก.<br />ปัจจุบัน {curW ?? baseW} กก. · เป้าหมาย {target} กก.
              </div>
            </div>
            <div className="h-3.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-emerald-400 transition-[width]" style={{ width: `${pct.toFixed(0)}%` }} />
            </div>
          </div>
        );
      })()}

      {/* Self-log form (daily) */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">บันทึกสุขภาพประจำวัน</h2>
        <p className="text-[11px] text-slate-500 -mt-1">
          บันทึกได้ทุกวัน — น้ำหนักและค่าต่าง ๆ จะถูกนำไปสร้างกราฟติดตามผลให้แพทย์ดูแล
        </p>
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
        {/* Daily vitals (optional) */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">ความดัน (BP)</label>
            <input className="input" value={bp} onChange={(e) => setBp(e.target.value)} placeholder="120/80" />
          </div>
          <div>
            <label className="label">ชีพจร (HR)</label>
            <input type="number" inputMode="numeric" min="0" className="input"
              value={hr} onChange={(e) => setHr(e.target.value)} placeholder="bpm" />
          </div>
          <div>
            <label className="label">น้ำตาล (DTX/FBS)</label>
            <input type="number" inputMode="numeric" min="0" className="input"
              value={fbs} onChange={(e) => setFbs(e.target.value)} placeholder="mg/dL" />
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
          <label className="label">บันทึกประจำวัน — อาหาร / การออกกำลังกาย</label>
          <textarea className="input text-sm" rows={2} value={diary} maxLength={2000}
            onChange={(e) => setDiary(e.target.value)}
            placeholder="เช่น มื้อเช้า… มื้อเที่ยง… ออกกำลังกาย เดิน 30 นาที ฯลฯ" />
        </div>
        <div>
          <label className="label">บันทึก / คำถามถึงแพทย์</label>
          <textarea className="input text-sm" rows={2} value={notes} maxLength={1000}
            onChange={(e) => setNotes(e.target.value)} placeholder="เช่น อยากปรึกษาเรื่อง…" />
        </div>
        {editingId != null && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 space-y-1.5">
            <div className="text-xs text-amber-800">
              กำลังแก้ไขรายการวันที่ <b>{date}</b> — ใส่ PIN เพื่อยืนยัน (ระบบจะบันทึกประวัติการแก้ไขไว้)
            </div>
            <input type="password" inputMode="numeric" maxLength={4} value={editPin}
              onChange={(e) => setEditPin(e.target.value.replace(/\D/g, ""))}
              className="input text-center tracking-[0.4em]" placeholder="PIN 4 หลัก" />
          </div>
        )}
        <div className="flex gap-2">
          {editingId != null && (
            <button type="button" onClick={cancelEdit} disabled={busy === "log"}
              className="btn-secondary py-2.5 px-4 disabled:opacity-50">ยกเลิก</button>
          )}
          <button type="button" disabled={busy === "log"} onClick={submitLog}
            className="btn-primary flex-1 py-2.5 disabled:opacity-50">
            {busy === "log" ? "กำลังบันทึก…" : editingId != null ? "บันทึกการแก้ไข" : "บันทึกข้อมูลวันนี้"}
          </button>
        </div>
      </div>

      {/* Exercise log (owner #11-16) */}
      <ExerciseSection exercise={exercise} baselineWeight={baseW} today={today}
        busy={busy} setBusy={setBusy} setMsg={setMsg} />

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
          {selfLogs.slice(0, 14).map((l) => (
            <div key={l.id} className="text-xs border-b last:border-0 pb-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="font-mono text-slate-500">{l.date}</span>
                  {l.weight != null && <> · {l.weight} กก.</>}
                  {l.bp && <> · BP {l.bp}</>}
                  {l.hr != null && <> · HR {l.hr}</>}
                  {l.fbs != null && <> · DTX {l.fbs}</>}
                  {l.injection_done && <> · ฉีดยาแล้ว</>}
                </div>
                <button type="button" onClick={() => startEdit(l)}
                  className="text-brand hover:underline whitespace-nowrap flex-shrink-0">แก้ไข</button>
              </div>
              {l.diary && <div className="text-slate-600 mt-0.5">บันทึกประจำวัน: {l.diary}</div>}
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
        {pendingAction ? (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 leading-relaxed">
            คุณได้ส่งคำขอ<b>{pendingAction === "erase" ? "ลบข้อมูล" : "ออกจากโครงการ"}</b>แล้ว —
            อยู่ระหว่าง<b>รอแพทย์อนุมัติ</b> ระบบจะแจ้งผลให้ทราบทางไลน์
            <div className="mt-2">
              <a href={apiUrl("/api/mounjaro/export")}
                className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 inline-block">
                ดาวน์โหลดข้อมูลของฉัน (JSON)
              </a>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <a href={apiUrl("/api/mounjaro/export")}
                className="text-xs px-3 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50">
                ดาวน์โหลดข้อมูลของฉัน (JSON)
              </a>
              <button type="button" disabled={busy !== null}
                onClick={() => onRequestDestructive("withdraw")}
                className="text-xs px-3 py-2 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 disabled:opacity-50">
                ขอออกจากโครงการ
              </button>
              <button type="button" disabled={busy !== null}
                onClick={() => onRequestDestructive("erase")}
                className="text-xs px-3 py-2 rounded-lg border border-rose-300 text-rose-600 hover:bg-rose-50 disabled:opacity-50">
                ขอลบข้อมูลของฉัน
              </button>
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              ทั้งสองรายการต้อง<b>พิมพ์ข้อความยืนยัน + ใส่ PIN</b>ก่อน เพื่อกันเผลอกด ·
              คำขอจะถูกส่งให้<b>แพทย์เจ้าของไข้อนุมัติ</b>ก่อน · การลบจะนำข้อมูลออกจากพอร์ทัล —
              ส่วนเวชระเบียนที่แพทย์บันทึกจะถูกเก็บรักษาตามที่กฎหมายกำหนด
            </p>
          </>
        )}
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

// ── Exercise log (owner #11-16) ─────────────────────────────────────
// Pick an intensity level → choose an activity → enter duration + a
// mandatory RPE (Borg CR10) → save. Energy is shown ONLY as an estimate
// and only when we have a baseline weight; there is no target/deficit.
function ExerciseSection({
  exercise, baselineWeight, today, busy, setBusy, setMsg
}: {
  exercise: ExerciseData; baselineWeight: number | null; today: string;
  busy: string | null; setBusy: (s: string | null) => void;
  setMsg: (m: { kind: "ok" | "err"; text: string } | null) => void;
}) {
  const router = useRouter();
  const { logs, summary } = exercise;
  const [level, setLevel] = useState<ExerciseLevel>("light");
  const [activityId, setActivityId] = useState<string>("");
  const [date, setDate] = useState(today);
  const [duration, setDuration] = useState<string>("");
  const [rpe, setRpe] = useState<number | null>(null);

  const activity = activityId ? getActivity(activityId) : null;
  const durationNum = duration.trim() === "" ? 0 : Number(duration);
  const kcalPreview = activity
    ? kcalEstimate(activity.met, baselineWeight, durationNum)
    : null;

  function pickActivity(id: string) {
    setActivityId(id);
    const a = getActivity(id);
    setDuration(a ? String(a.defaultMin) : "");
    setRpe(null);
  }

  const canSave = !!activity && durationNum >= 1 && rpe != null && busy === null;

  async function save() {
    if (!activity || rpe == null) { setMsg({ kind: "err", text: "เลือกกิจกรรมและระดับความเหนื่อย (RPE)" }); return; }
    if (!(durationNum >= 1)) { setMsg({ kind: "err", text: "กรอกระยะเวลาเป็นนาที" }); return; }
    setBusy("exercise"); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/exercise-log"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, activity_id: activity.id, duration_min: Math.round(durationNum), rpe })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error === "not_active" ? "บันทึกได้เฉพาะผู้ที่อยู่ในโครงการ" : "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกกิจกรรมเรียบร้อย" });
      setActivityId(""); setDuration(""); setRpe(null);
      router.refresh();
    } finally { setBusy(null); }
  }

  async function logRest() {
    setBusy("exercise"); setMsg(null);
    try {
      const res = await fetch(apiUrl("/api/mounjaro/exercise-log"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: today, activity_id: REST_ACTIVITY_ID, duration_min: 0, rpe: 0 })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error === "not_active" ? "บันทึกได้เฉพาะผู้ที่อยู่ในโครงการ" : "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "บันทึกวันพัก (ไม่ได้ออกกำลังกาย) เรียบร้อย" });
      router.refresh();
    } finally { setBusy(null); }
  }

  async function remove(id: number) {
    setBusy("exercise"); setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/mounjaro/exercise-log?id=${id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) router.refresh();
    } finally { setBusy(null); }
  }

  const activitiesForLevel = EXERCISE_CATALOG.filter((a) => a.level === level);

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">บันทึกการออกกำลังกาย</h2>
        <p className="text-[11px] text-slate-500 mt-0.5">
          เลือกระดับและกิจกรรมของวันนี้ แล้วประเมินความเหนื่อย (RPE) — บันทึกได้หลายกิจกรรมต่อวัน
        </p>
      </div>

      {/* Weekly summary (#14) */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <ExStat label="วันที่ออกกำลัง" value={`${summary.days} วัน`} />
        <ExStat label="เวลารวม" value={`${summary.totalMin} นาที`} />
        <ExStat label="พลังงานโดยประมาณ"
          value={summary.totalKcal != null ? `~${summary.totalKcal.toLocaleString("th-TH")} kcal` : "—"} />
        <ExStat label="RPE เฉลี่ย" value={summary.avgRpe != null ? String(summary.avgRpe) : "—"} />
        <ExStat label="ต่อเนื่อง (streak)" value={`${summary.streak} วัน`} accent="emerald" />
      </div>
      <p className="text-[10px] text-slate-400 -mt-1">สรุป 7 วันล่าสุด · พลังงานเป็นค่าโดยประมาณเท่านั้น ไม่ใช่เป้าหมาย</p>

      {/* Rest day — record that today had no exercise (owner 2026-06-08). */}
      <button type="button" disabled={busy !== null} onClick={logRest}
        className="w-full py-2 rounded-lg border border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
        วันนี้ไม่ได้ออกกำลังกาย (บันทึกวันพัก)
      </button>

      {/* Level tabs (#11) */}
      <div className="flex gap-2">
        {EXERCISE_LEVELS.map((l) => (
          <button key={l.key} type="button"
            onClick={() => { setLevel(l.key); setActivityId(""); setRpe(null); }}
            className={`flex-1 py-2 rounded-lg text-sm font-bold border transition ${
              level === l.key ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600"}`}>
            {l.label}
          </button>
        ))}
      </div>

      {/* Activity chips for the chosen level */}
      <div className="flex flex-wrap gap-2">
        {activitiesForLevel.map((a) => (
          <button key={a.id} type="button" onClick={() => pickActivity(a.id)}
            className={`text-xs px-3 py-2 rounded-lg border ${
              activityId === a.id
                ? "bg-brand/10 border-brand text-brand font-bold"
                : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
            {a.name}
          </button>
        ))}
      </div>

      {/* Selected activity → duration + RPE + estimate (#12, #13) */}
      {activity && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-3">
          <div className="font-bold text-slate-800 text-sm">{activity.name}</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">วันที่</label>
              <input type="date" className="input" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div>
              <label className="label">ระยะเวลา (นาที)</label>
              <input type="number" inputMode="numeric" min="1" max="600" className="input"
                value={duration} onChange={(e) => setDuration(e.target.value)} placeholder={String(activity.defaultMin)} />
            </div>
          </div>

          <div>
            <label className="label">ระดับความเหนื่อย (RPE 0–10) *</label>
            <div className="grid grid-cols-11 gap-1">
              {RPE_SCALE.map((r) => (
                <button key={r.value} type="button" onClick={() => setRpe(r.value)}
                  title={`${r.value} — ${r.label}`}
                  className={`py-1.5 rounded-md text-xs font-bold border ${
                    rpe === r.value ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600"}`}>
                  {r.value}
                </button>
              ))}
            </div>
            <p className={`text-[11px] mt-1 ${rpe == null ? "text-rose-500 font-semibold" : "text-slate-500"}`}>
              {rpe == null ? "กรุณาเลือกระดับความเหนื่อย (จำเป็น)" : `${rpe} — ${rpeLabel(rpe)}`}
            </p>
            {/* Full RPE legend (owner 2026-06-08): description for each score. */}
            <details className="mt-1">
              <summary className="text-[11px] text-brand cursor-pointer select-none">ดูความหมาย RPE แต่ละระดับ</summary>
              <div className="mt-1 grid grid-cols-1 gap-0.5 text-[11px] text-slate-500">
                {RPE_SCALE.map((r) => (
                  <div key={r.value} className="flex gap-2">
                    <span className="font-mono font-bold text-slate-600 w-4 text-right">{r.value}</span>
                    <span>{r.label}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>

          {/* Approximate energy (#13) — only when baseline weight is known */}
          {baselineWeight != null ? (
            <div className="text-sm text-slate-700">
              พลังงานโดยประมาณ:{" "}
              <b className="text-brand">
                {kcalPreview != null ? `~${Math.round(kcalPreview).toLocaleString("th-TH")} kcal` : "—"}
              </b>
              <span className="text-[10px] text-slate-400"> (ประมาณการจากน้ำหนักเริ่มต้น ไม่ใช่ค่าจริง)</span>
            </div>
          ) : (
            <p className="text-[11px] text-slate-400">ยังไม่มีน้ำหนักเริ่มต้นในระบบ จึงยังไม่แสดงพลังงานโดยประมาณ</p>
          )}

          <button type="button" disabled={!canSave} onClick={save}
            className="btn-primary w-full py-2.5 disabled:opacity-50">
            {busy === "exercise" ? "กำลังบันทึก…" : "บันทึกกิจกรรม"}
          </button>
        </div>
      )}

      {/* Recent logged activities */}
      {logs.length > 0 && (
        <div className="space-y-1.5 pt-1">
          <div className="text-xs font-bold text-slate-600">กิจกรรมที่บันทึกล่าสุด</div>
          {logs.slice(0, 12).map((l) => {
            const isRest = l.activity_id === REST_ACTIVITY_ID || l.level === "rest";
            return (
              <div key={l.id} className="flex items-center justify-between gap-2 text-xs border-b last:border-0 pb-1.5">
                <div className="min-w-0">
                  <span className="font-mono text-slate-500">{l.date}</span>{" "}
                  · <span className="text-slate-700">{activityLabel(l.activity_id)}</span>{" "}
                  {!isRest && <span className="text-[10px] text-slate-400">({levelLabel(l.level)})</span>}
                  <div className="text-[11px] text-slate-500">
                    {isRest ? (
                      "วันพัก — ไม่ได้ออกกำลังกาย"
                    ) : (
                      <>
                        {l.duration_min} นาที · RPE {l.rpe}
                        {l.kcal_est != null && <> · ~{l.kcal_est.toLocaleString("th-TH")} kcal</>}
                        {l.low_energy_flag && (
                          <span className="ml-1 text-amber-600">· ออกแรงเบาแต่เหนื่อยมาก</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
                <button type="button" disabled={busy !== null} onClick={() => remove(l.id)}
                  className="text-[11px] text-rose-500 hover:underline disabled:opacity-50 flex-shrink-0">
                  ลบ
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExStat({ label, value, accent }: { label: string; value: string; accent?: "emerald" }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-center">
      <div className="text-[10px] text-slate-500 leading-tight">{label}</div>
      <div className={`text-sm font-bold mt-0.5 ${accent === "emerald" ? "text-emerald-700" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}
