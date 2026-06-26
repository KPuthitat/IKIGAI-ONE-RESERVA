"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Alert } from "@/lib/mounjaro-alerts";
import { levelLabel, rpeLabel, activityLabel, REST_ACTIVITY_ID } from "@/lib/exercise-catalog";

// ── Mounjaro patient detail — clinical tracker view ─────────────────
// Themed to the app CI (owner #10 2026-06-06): espresso-brown header +
// caramel (brand) accents on cream/white, tabbed detail. The old
// navy/gold clinical chrome was dropped. Backend access is doctor-scoped
// + audited.

type Visit = {
  id: number; date: string | null; dose: number | null; weight: number | null;
  bp: string | null; hr: number | null; hba1c: number | null; fbs: number | null;
  waist: number | null; side_effects: Record<string, number>;
  hypo_count: number | null; adherence: string | null;
  decision: string | null; next_visit: string | null; notes: string | null;
};
type SelfLog = {
  id: number; date: string | null; weight: number | null; injection_done: boolean;
  bp: string | null; hr: number | null; fbs: number | null; diary: string | null;
  notes_for_doctor: string | null; doctor_reply: string | null;
};
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

const DOSES = [2.5, 5, 7.5, 10, 12.5, 15];
const SE_FIELDS: Array<[string, string]> = [
  ["nausea", "คลื่นไส้"], ["vomit", "อาเจียน"], ["diarrhea", "ท้องเสีย"], ["const", "ท้องผูก"],
  ["abdomen", "ปวดท้อง (เฝ้าระวังภาวะตับอ่อนอักเสบ)"], ["tachy", "หัวใจเต้นเร็ว / ใจสั่น"],
  ["fatigue", "อ่อนเพลีย"], ["inject", "ปฏิกิริยาบริเวณฉีด"]
];
const DECISION_LABEL: Record<string, string> = {
  maintain: "คงขนาดเดิม", increase: "ปรับขึ้น", decrease: "ปรับลง", hold: "หยุดยา"
};
const ADH_LABEL: Record<string, string> = {
  full: "ฉีดครบทุกสัปดาห์", missed1: "ขาด 1 ครั้ง", missed2: "ขาด ≥2 ครั้ง", held: "หยุดเอง"
};

const inputCls =
  "w-full px-3 py-2 text-sm border border-slate-300 rounded-xl bg-white text-[#3a2716] " +
  "focus:outline-none focus:border-[#a06820] focus:ring-2 focus:ring-[#a06820]/20";
const labelCls = "text-[12px] font-medium text-slate-500 tracking-wide";

function toBE(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const m = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  return `${dt.getDate()} ${m[dt.getMonth()]} ${dt.getFullYear() + 543}`;
}
function calcBMI(w?: number | null, h?: number | null): number | null {
  if (!w || !h) return null;
  const m = h / 100;
  return w / (m * m);
}
function bmiCat(bmi: number | null): string {
  if (!bmi) return "";
  if (bmi < 18.5) return "น้ำหนักน้อย";
  if (bmi < 23) return "ปกติ";
  if (bmi < 25) return "น้ำหนักเกิน";
  if (bmi < 30) return "อ้วนระดับ 1";
  return "อ้วนระดับ 2";
}
function num(b: Record<string, number | string>, k: string): number | null {
  const v = b[k];
  return typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : null;
}
/** Age in whole years from an ISO DOB — for auto-filling from the linked
 *  employee record when baseline age isn't set (owner 2026-06-08). */
function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a >= 0 && a < 130 ? a : null;
}

export default function PatientDetailClient(props: {
  patientId: number; employeeName: string; hn: string | null; startDate: string | null;
  notes: string | null; baseline: Record<string, number | string>;
  comorbidities: Record<string, boolean>; contraindications: Record<string, boolean>;
  medications: Record<string, boolean>;
  visits: Visit[]; selfLogs: SelfLog[]; alerts: Alert[];
  exercise: ExerciseData;
  employeeDob?: string | null; employeePhone?: string | null;
  pendingAction: { action: "withdraw" | "erase"; reason: string | null; at: string | null } | null;
}) {
  const { patientId, employeeName, hn, startDate, notes, baseline,
    comorbidities, contraindications, medications, visits, selfLogs, alerts, exercise,
    employeeDob, employeePhone, pendingAction } = props;
  // Age + phone auto-pulled from the linked employee record when the
  // baseline override is blank (owner 2026-06-08).
  const displayAge = num(baseline, "age") ?? ageFromDob(employeeDob);
  const displayPhone = (baseline.phone as string)?.trim() || employeePhone || null;
  const router = useRouter();
  const [tab, setTab] = useState<"titration" | "visits" | "chart" | "baseline" | "exercise">("titration");
  const [showVisit, setShowVisit] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [decidingPending, setDecidingPending] = useState(false);

  async function decidePending(decision: "approve" | "reject") {
    const verb = pendingAction?.action === "erase" ? "ลบข้อมูล" : "ออกจากโครงการ";
    const msg = decision === "approve"
      ? `อนุมัติคำขอ${verb}ของผู้ป่วยรายนี้?`
      : `ไม่อนุมัติคำขอ${verb}ของผู้ป่วยรายนี้?`;
    if (!window.confirm(msg)) return;
    setDecidingPending(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/mounjaro/patient/${patientId}/pending-action`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
      if (res.ok) {
        // Approving a withdraw/erase removes the patient from the doctor's
        // active list → bounce back. Reject just refreshes the banner away.
        if (decision === "approve") router.push("/admin/mounjaro");
        else router.refresh();
      }
    } finally { setDecidingPending(false); }
  }

  const baseWeight = num(baseline, "weight");
  const baseHeight = num(baseline, "height");
  const last = visits[visits.length - 1] ?? null;
  const currentDose = last?.dose ?? 2.5;
  // Current weight = the most recent weigh-in from EITHER source — clinic
  // visits AND the patient's daily self-logs — picked by date (owner
  // 2026-06-12). Previously this used only the last clinic visit, so the
  // headline read "62.0 · 0%" while the chart (which already merges both
  // sources) clearly showed the self-logged loss. Order-independent.
  const weighIns = [
    ...visits.filter((v) => v.weight != null && v.date).map((v) => ({ date: v.date as string, weight: v.weight as number })),
    ...selfLogs.filter((l) => l.weight != null && l.date).map((l) => ({ date: l.date as string, weight: l.weight as number }))
  ].sort((a, b) => a.date.localeCompare(b.date));
  const currentWeight = weighIns.length ? weighIns[weighIns.length - 1].weight : baseWeight;
  const lossPct = baseWeight && currentWeight != null ? ((baseWeight - currentWeight) / baseWeight) * 100 : null;
  const bmi = calcBMI(currentWeight, baseHeight);
  const weeksFromStart = startDate
    ? Math.max(0, Math.floor((Date.now() - new Date(startDate).getTime()) / (7 * 86_400_000))) : 0;

  const dangers = alerts.filter((a) => a.level === "danger");
  const warnings = alerts.filter((a) => a.level === "warning");

  async function deletePatient() {
    if (!window.confirm("ลบผู้ป่วยรายนี้ออกจากความดูแล? (เวชระเบียนยังถูกเก็บไว้ตามกฎหมาย)")) return;
    const res = await fetch(apiUrl(`/api/admin/mounjaro/patient/${patientId}`), { method: "DELETE" });
    if (res.ok) router.push("/admin/mounjaro");
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="relative bg-white border border-slate-200 rounded-2xl shadow-card px-6 py-6 after:content-[''] after:absolute after:bottom-0 after:left-0 after:w-20 after:h-[3px] after:bg-[#a06820] after:rounded-bl-2xl">
        <button onClick={() => router.push("/admin/mounjaro")}
          className="text-[12px] text-[#a06820] hover:text-[#7a4f16] tracking-[0.08em] uppercase mb-2">← กลับสู่รายชื่อ</button>
        <div className="text-[24px] font-semibold leading-tight text-[#3a2716]">{employeeName}</div>
        <div className="text-[13px] text-[#a06820] tabular-nums tracking-[0.05em] mt-0.5">
          HN {hn ?? "—"} · เริ่มยา {toBE(startDate)}
        </div>
        <div className="text-[12px] text-slate-500 tabular-nums mt-1">
          อายุ {displayAge != null ? `${displayAge} ปี` : "—"} · โทร {displayPhone ?? "—"}
        </div>
      </div>

      {/* Pending withdraw/erase request — needs the attending doctor's
          decision (owner 2026-06-05). Shown above clinical alerts. */}
      {pendingAction && (
        <div className="px-4 py-3.5 border-l-[3px] border-[#B45309] bg-[#FFFBEB] text-[#78350F] text-[13px] space-y-2">
          <div className="font-semibold">
            คำขอรออนุมัติ: {pendingAction.action === "erase" ? "ขอลบข้อมูลออกจากพอร์ทัล" : "ขอออกจากโครงการ"}
          </div>
          {pendingAction.reason && <div>เหตุผลจากผู้ป่วย: {pendingAction.reason}</div>}
          <div className="text-[11px] text-[#92400E]">
            {pendingAction.action === "erase"
              ? "เมื่ออนุมัติ ข้อมูลในพอร์ทัลของผู้ป่วยจะถูกซ่อน (เวชระเบียนยังเก็บตามกฎหมาย)"
              : "เมื่ออนุมัติ ผู้ป่วยจะออกจากโครงการ (กลับเข้าร่วมใหม่ได้ภายหลัง)"}
          </div>
          <div className="flex gap-2 pt-1">
            <button type="button" disabled={decidingPending}
              onClick={() => decidePending("approve")}
              className="px-4 py-2 rounded-xl bg-[#B45309] text-white text-[12px] font-bold disabled:opacity-50">
              อนุมัติคำขอ
            </button>
            <button type="button" disabled={decidingPending}
              onClick={() => decidePending("reject")}
              className="px-4 py-2 rounded-xl border border-[#B45309] text-[#B45309] text-[12px] font-bold disabled:opacity-50">
              ไม่อนุมัติ
            </button>
          </div>
        </div>
      )}

      {/* Alert banner */}
      {dangers.length === 0 && warnings.length === 0 ? (
        <div className="flex gap-3 items-start px-4 py-3.5 border-l-[3px] border-[#047857] bg-[#ECFDF5] text-[#064E3B] text-[13px]">
          <span className="font-semibold text-base leading-none mt-0.5">✓</span>
          <div><div className="font-semibold">ไม่พบสัญญาณเตือน</div>การติดตามอยู่ในเกณฑ์ปกติ</div>
        </div>
      ) : (
        <div className="space-y-2">
          {dangers.map((a, i) => <AlertBox key={`d${i}`} level="danger" a={a} />)}
          {warnings.map((a, i) => <AlertBox key={`w${i}`} level="warning" a={a} />)}
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-slate-200 border border-slate-200 rounded-2xl overflow-hidden">
        <Stat label="ขนาดยาปัจจุบัน" value={`${currentDose}`} unit="mg/wk" sub={last ? toBE(last.date) : "ยังไม่มีการนัด"} />
        <Stat label="สัปดาห์ที่" value={`${weeksFromStart}`} unit="สัปดาห์" sub="จากวันเริ่มยา" />
        <Stat label="น้ำหนักล่าสุด" value={currentWeight != null ? currentWeight.toFixed(1) : "—"} unit="กก."
          sub={`BMI ${bmi ? bmi.toFixed(1) : "—"} · ${bmiCat(bmi)}`} />
        <Stat label="น้ำหนักที่ลดได้" value={lossPct != null ? `${lossPct > 0 ? "−" : ""}${Math.abs(lossPct).toFixed(1)}` : "—"} unit="%"
          sub={baseWeight && currentWeight != null ? `−${(baseWeight - currentWeight).toFixed(1)} กก. จาก ${baseWeight.toFixed(1)}` : ""}
          valueColor={lossPct != null && lossPct > 0 ? "#047857" : undefined} />
        <Stat label="นัดถัดไป" value={last?.next_visit ? toBE(last.next_visit) : "—"} small
          sub={last?.next_visit ? `อีก ${Math.max(0, Math.floor((new Date(last.next_visit).getTime() - Date.now()) / 86_400_000))} วัน` : "ยังไม่กำหนด"} />
      </div>

      {/* Progress toward the goal weight, as a % (owner 2026-06-08). */}
      {(() => {
        const target = num(baseline, "target");
        if (baseWeight == null || target == null || !(baseWeight > target)) return null;
        const pct = Math.max(0, Math.min(100, ((baseWeight - (currentWeight ?? baseWeight)) / (baseWeight - target)) * 100));
        return (
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-4">
            <div className="text-[12px] text-slate-500 uppercase tracking-[0.08em] mb-1">ความคืบหน้าสู่เป้าหมาย</div>
            <div className="flex items-end gap-3 mb-2.5">
              <div className="text-[44px] font-extrabold text-[#047857] leading-[0.9] tabular-nums">{pct.toFixed(0)}%</div>
              <div className="text-[11px] text-slate-400 pb-1.5 tabular-nums leading-snug">
                เริ่มต้น {baseWeight.toFixed(1)} กก.<br />ปัจจุบัน {(currentWeight ?? baseWeight).toFixed(1)} กก. · เป้าหมาย {target.toFixed(1)} กก.
              </div>
            </div>
            <div className="h-3 rounded-full bg-[#EFEADD] overflow-hidden">
              <div className="h-full bg-[#047857]" style={{ width: `${pct.toFixed(0)}%` }} />
            </div>
          </div>
        );
      })()}

      {/* Tabs — horizontally scrollable so the 4 labels never wrap /
          overlap on narrow phones. */}
      <div className="flex border-b border-slate-200 gap-1 overflow-x-auto whitespace-nowrap -mx-1 px-1">
        {([["titration", "การปรับขนาดยา"], ["visits", "บันทึกการนัด"], ["chart", "กราฟติดตาม"], ["exercise", "การออกกำลังกาย"], ["baseline", "ข้อมูลพื้นฐาน"]] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`flex-shrink-0 px-4 py-3 text-[13px] font-medium -mb-px border-b-2 transition ${
              tab === k ? "text-[#3a2716] border-[#a06820]" : "text-slate-500 border-transparent hover:text-[#3a2716]"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab: Titration */}
      {tab === "titration" && (
        <Card title="ตารางการปรับขนาดยา · Titration Schedule"
          action={<GoldBtn onClick={() => setShowVisit(true)}>+ บันทึกการนัด</GoldBtn>}>
          <div className="grid grid-cols-3 sm:grid-cols-6">
            {DOSES.map((dose, i) => {
              const idx = DOSES.indexOf(currentDose);
              const cls = i < idx ? "bg-white border-[#a06820]" : i === idx ? "bg-[#a06820] border-[#a06820] text-white" : "bg-white border-slate-200";
              return (
                <div key={dose} className={`text-center py-4 px-2 border ${i > 0 ? "border-l-0 sm:border-l-0" : ""} ${cls}`}>
                  <div className={`text-lg font-bold ${i === idx ? "text-white" : "text-[#3a2716]"}`}>{dose}</div>
                  <div className={`text-[10px] ${i === idx ? "text-white/80" : "text-slate-500"}`}>mg</div>
                  <div className={`text-[10px] uppercase tracking-[0.08em] mt-1.5 ${i === idx ? "text-white/80" : "text-slate-500"}`}>
                    {i === 0 ? "Starter" : `Step ${i + 1}`}
                  </div>
                </div>
              );
            })}
          </div>
          {!last ? (
            <div className="mt-4 flex gap-3 items-start px-4 py-3 border-l-[3px] border-[#B45309] bg-[#FEF3C7] text-[#78350F] text-[13px]">
              <span className="font-semibold mt-0.5">•</span>
              <div><div className="font-semibold">ยังไม่มีการบันทึกนัด</div>เริ่มต้นที่ 2.5 mg เป็นเวลา 4 สัปดาห์ แล้วประเมินการปรับขนาดยา</div>
            </div>
          ) : (
            <div className="mt-4 bg-slate-50 border-l-[3px] border-[#a06820] px-4 py-3">
              <div className="text-[11px] text-slate-500 uppercase tracking-[0.08em] mb-1">การตัดสินใจครั้งล่าสุด</div>
              <div className="font-semibold text-[15px] text-[#3a2716]">{DECISION_LABEL[last.decision ?? "maintain"] ?? "—"}</div>
              <div className="text-[12px] text-slate-500 mt-0.5">
                บันทึก {toBE(last.date)} · ขนาดถัดไป {DOSES.indexOf(currentDose) < 5 ? `${DOSES[DOSES.indexOf(currentDose) + 1]} mg` : "ถึง max แล้ว"}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Tab: Visits */}
      {tab === "visits" && (
        <Card title="ประวัติการนัด · Visit Log"
          action={<GoldBtn onClick={() => setShowVisit(true)}>+ บันทึกการนัด</GoldBtn>}>
          {visits.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-sm text-slate-500 mb-4">ยังไม่มีการบันทึกการนัด</p>
              <GoldBtn onClick={() => setShowVisit(true)}>+ บันทึกการนัดแรก</GoldBtn>
            </div>
          ) : (
            <div className="overflow-x-auto -mx-6 sm:mx-0">
              <table className="w-full text-[13px] whitespace-nowrap">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-left text-[11px] uppercase tracking-[0.08em] border-b border-slate-200">
                    <th className="py-2.5 px-4 font-medium">วันที่</th>
                    <th className="py-2.5 px-3 font-medium">ขนาดยา</th>
                    <th className="py-2.5 px-3 font-medium">น้ำหนัก</th>
                    <th className="py-2.5 px-3 font-medium">BP / HR</th>
                    <th className="py-2.5 px-3 font-medium">ผลข้างเคียงเด่น</th>
                    <th className="py-2.5 px-3 font-medium">การตัดสินใจ</th>
                    <th className="py-2.5 px-4 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {[...visits].reverse().map((v) => {
                    const se = Object.entries(v.side_effects || {})
                      .filter(([, lvl]) => lvl >= 1)
                      .map(([k, lvl]) => {
                        const f = SE_FIELDS.find((x) => x[0] === k);
                        const lab = ["", "เล็กน้อย", "ปานกลาง", "รุนแรง"][lvl] ?? "";
                        return f ? `${f[1].split(" ")[0]} (${lab})` : "";
                      }).filter(Boolean).join(", ");
                    return (
                      <FragmentRow key={v.id} v={v} se={se} patientId={patientId} onChange={() => router.refresh()} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* Tab: Chart */}
      {tab === "chart" && (
        <Card title="กราฟติดตามผลลัพธ์ · Progress Chart">
          <ProgressChart baseline={{ weight: baseWeight, hr: num(baseline, "hr") }} startDate={startDate} visits={visits} selfLogs={selfLogs} />
        </Card>
      )}

      {/* Tab: Exercise (owner #15-16) */}
      {tab === "exercise" && (
        <Card title="การออกกำลังกาย · Exercise Log">
          {/* Soft clinical flag (#15) — light activity at high RPE. */}
          {exercise.summary.flagCount > 0 && (
            <div className="mb-3 rounded-xl border border-[#B45309] bg-[#FFFBEB] px-3 py-2 text-[12px] text-[#92400E]">
              <b>ข้อสังเกตเชิงคลินิก:</b> ใน 7 วันล่าสุดมีการออกกำลังกายระดับเบาแต่ผู้ป่วยประเมินความเหนื่อยสูง
              (RPE ≥ 7) จำนวน {exercise.summary.flagCount} ครั้ง อาจเป็นสัญญาณภาวะพลังงานต่ำหรือผลข้างเคียงของยา
              — แนะนำให้สอบถามเพิ่มเติม
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-px bg-slate-200 border border-slate-200 rounded-2xl overflow-hidden mb-3">
            <Stat label="วันที่ออกกำลัง (7 วัน)" value={String(exercise.summary.days)} unit="วัน" />
            <Stat label="เวลารวม" value={String(exercise.summary.totalMin)} unit="นาที" />
            <Stat label="พลังงานโดยประมาณ"
              value={exercise.summary.totalKcal != null ? `~${exercise.summary.totalKcal.toLocaleString("th-TH")}` : "—"} unit="kcal" small />
            <Stat label="RPE เฉลี่ย" value={exercise.summary.avgRpe != null ? String(exercise.summary.avgRpe) : "—"} />
            <Stat label="ต่อเนื่อง (streak)" value={String(exercise.summary.streak)} unit="วัน" />
          </div>

          {exercise.logs.length === 0 ? (
            <p className="text-[13px] text-slate-400 py-6 text-center">ผู้ป่วยยังไม่มีบันทึกการออกกำลังกาย</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px] whitespace-nowrap">
                <thead>
                  <tr className="text-left text-slate-500 border-b border-slate-200">
                    <th className="py-2 pr-3 font-medium">วันที่</th>
                    <th className="py-2 pr-3 font-medium">กิจกรรม</th>
                    <th className="py-2 pr-3 font-medium">ระดับ</th>
                    <th className="py-2 pr-3 font-medium text-right">นาที</th>
                    <th className="py-2 pr-3 font-medium text-right">RPE</th>
                    <th className="py-2 pr-3 font-medium text-right">พลังงาน</th>
                  </tr>
                </thead>
                <tbody>
                  {exercise.logs.slice(0, 60).map((l) => {
                    const isRest = l.activity_id === REST_ACTIVITY_ID || l.level === "rest";
                    return (
                      <tr key={l.id} className={`border-b border-slate-200 last:border-0 ${l.low_energy_flag ? "bg-[#FFFBEB]" : ""}`}>
                        <td className="py-2 pr-3 font-mono text-xs">{toBE(l.date)}</td>
                        <td className="py-2 pr-3">{activityLabel(l.activity_id)}</td>
                        <td className="py-2 pr-3 text-xs text-slate-500">{isRest ? "—" : levelLabel(l.level)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{isRest ? "—" : l.duration_min}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {isRest ? "—" : l.rpe}
                          {l.low_energy_flag && <span className="ml-1 text-[#B45309]" title={`เบาแต่เหนื่อยมาก — ${rpeLabel(l.rpe)}`}>⚑</span>}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">
                          {l.kcal_est != null ? `~${l.kcal_est.toLocaleString("th-TH")}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[10px] text-slate-400 mt-2">พลังงานเป็นค่าประมาณการจากน้ำหนักเริ่มต้น (met × kg × ชม.) ไม่ใช่ค่าที่วัดจริง</p>
            </div>
          )}
        </Card>
      )}

      {/* Tab: Baseline */}
      {tab === "baseline" && (
        <Card title="ข้อมูลพื้นฐาน · Baseline Data"
          action={<button onClick={() => setShowEdit(true)} className="px-3 py-1.5 text-[12px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-slate-50">แก้ไข</button>}>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-200 border border-slate-200 rounded-2xl overflow-hidden">
            <Stat label="น้ำหนักเริ่มต้น" value={baseWeight != null ? baseWeight.toFixed(1) : "—"} unit="กก." />
            <Stat label="ส่วนสูง" value={baseHeight != null ? baseHeight.toFixed(0) : "—"} unit="ซม." />
            <Stat label="BMI" value={calcBMI(baseWeight, baseHeight)?.toFixed(1) ?? "—"} sub={bmiCat(calcBMI(baseWeight, baseHeight))} />
            <Stat label="HR baseline" value={num(baseline, "hr")?.toString() ?? "—"} unit="bpm" />
            <Stat label="BP baseline" value={(baseline.bp as string) || "—"} small />
            <Stat label="HbA1c baseline" value={num(baseline, "hba1c")?.toString() ?? "—"} unit="%" />
            <Stat label="เป้าหมายน้ำหนัก" value={num(baseline, "target")?.toString() ?? "—"} unit="กก." />
            <Stat label="รอบเอว" value={num(baseline, "waist")?.toString() ?? "—"} unit="ซม." />
          </div>
          <div className="grid sm:grid-cols-3 gap-4 mt-4">
            <FlagList title="โรคร่วม" labels={flagLabels(comorbidities, COMO_LABELS)} />
            <FlagList title="ยาที่ใช้ร่วม" labels={flagLabels(medications, MED_LABELS)} />
            <FlagList title="ข้อห้าม / สัญญาณเตือน" danger labels={flagLabels(contraindications, CONTRA_LABELS)} empty="ไม่พบ" />
          </div>
          {notes && (
            <div className="mt-5 bg-slate-50 border-l-[3px] border-[#a06820] px-4 py-3">
              <div className="text-[11px] text-slate-500 uppercase tracking-[0.08em] mb-1">หมายเหตุ</div>
              <div className="text-[13px] text-[#3a2716]">{notes}</div>
            </div>
          )}
        </Card>
      )}

      {/* Self-logs from the employee */}
      <Card title="บันทึกจากผู้ป่วย · Self-log">
        {selfLogs.length === 0 ? <p className="text-[13px] text-slate-400">ยังไม่มีบันทึกจากผู้ป่วย</p> :
          <div className="space-y-2.5">{selfLogs.slice(0, 12).map((l) => <SelfLogRow key={l.id} log={l} onReplied={() => router.refresh()} />)}</div>}
      </Card>

      {/* Footer actions */}
      <div className="flex justify-end gap-2.5 pt-1">
        <button onClick={() => window.print()} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-slate-50">พิมพ์เอกสาร</button>
        <button onClick={deletePatient} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#B91C1C] hover:bg-[#FEF2F2]">ลบผู้ป่วย</button>
      </div>

      {showVisit && <VisitModal patientId={patientId} defaultDose={currentDose} onClose={() => setShowVisit(false)} onSaved={() => { setShowVisit(false); router.refresh(); }} />}
      {showEdit && <PatientEditModal patientId={patientId} hn={hn} startDate={startDate} baseline={baseline}
        comorbidities={comorbidities} contraindications={contraindications} medications={medications} notes={notes}
        employeeDob={employeeDob} employeePhone={employeePhone}
        onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); router.refresh(); }} />}
    </div>
  );
}

// ── Presentational helpers ──────────────────────────────────────────
function Stat({ label, value, unit, sub, valueColor, small }: {
  label: string; value: string; unit?: string; sub?: string; valueColor?: string; small?: boolean;
}) {
  return (
    <div className="bg-white px-5 py-4">
      <div className="text-[10px] text-slate-500 uppercase tracking-[0.12em] mb-1.5">{label}</div>
      <div className={`font-bold text-[#3a2716] tabular-nums ${small ? "text-base" : "text-[22px]"}`} style={valueColor ? { color: valueColor } : undefined}>
        {value}{unit && <span className="text-[12px] text-slate-500 font-normal font-sans ml-1">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-5 pb-4 border-b border-slate-200">
        <div className="text-[15px] font-semibold text-[#3a2716] flex items-center">
          <span className="inline-block w-[3px] h-4 bg-[#a06820] mr-2.5" />{title}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function GoldBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className="px-3 py-1.5 text-[12px] bg-[#a06820] hover:bg-[#7a4f16] text-white rounded-xl font-medium">{children}</button>;
}

function AlertBox({ level, a }: { level: "danger" | "warning"; a: Alert }) {
  const cls = level === "danger" ? "border-[#B91C1C] bg-[#FEF2F2] text-[#7F1D1D]" : "border-[#B45309] bg-[#FEF3C7] text-[#78350F]";
  return (
    <div className={`flex gap-3 items-start px-4 py-3.5 border-l-[3px] text-[13px] ${cls}`}>
      <span className="font-bold text-base leading-none mt-0.5">!</span>
      <div><div className="font-semibold">{level === "danger" ? "เร่งด่วน" : "เฝ้าระวัง"}</div>{a.message}</div>
    </div>
  );
}

const COMO_LABELS: Array<[string, string]> = [["dm", "เบาหวานชนิดที่ 2"], ["htn", "ความดันโลหิตสูง"], ["dlp", "ไขมันในเลือดสูง"], ["cvd", "โรคหัวใจและหลอดเลือด"], ["ckd", "โรคไตเรื้อรัง"], ["panc", "ตับอ่อนอักเสบ"], ["gb", "นิ่วในถุงน้ำดี"]];
const MED_LABELS: Array<[string, string]> = [
  ["insulin", "อินซูลิน"],
  ["su", "ยากลุ่มซัลโฟนิลยูเรีย (Sulfonylurea)"],
  ["met", "เมตฟอร์มิน (Metformin)"],
  ["sglt2", "ยากลุ่มยับยั้ง SGLT-2 (Sodium-Glucose Cotransporter-2)"],
  ["ocp", "ยาเม็ดคุมกำเนิด"]
];
const CONTRA_LABELS: Array<[string, string]> = [
  ["mtc", "ประวัติมะเร็งต่อมไทรอยด์ชนิดเมดัลลารี (MTC)"],
  ["men2", "กลุ่มอาการเนื้องอกต่อมไร้ท่อหลายตำแหน่งชนิดที่ 2 (MEN 2)"],
  ["preg", "ตั้งครรภ์ / วางแผนตั้งครรภ์"],
  ["allergy", "แพ้ยา Tirzepatide"]
];
function flagLabels(state: Record<string, boolean>, labels: Array<[string, string]>): string[] {
  return labels.filter(([k]) => state[k]).map(([, v]) => v);
}
function FlagList({ title, labels, danger, empty }: { title: string; labels: string[]; danger?: boolean; empty?: string }) {
  return (
    <div>
      <div className={`text-[12px] font-semibold uppercase tracking-[0.08em] mb-2 ${danger ? "text-[#B91C1C]" : "text-[#3a2716]"}`}>{title}</div>
      {labels.length ? (
        <ul className={`space-y-1 ${danger ? "text-[#B91C1C] font-semibold" : "text-[#3a2716]"}`}>
          {labels.map((l) => (
            <li key={l} className="flex items-start gap-1.5 text-[13px]">
              <span className="text-[#a06820] font-bold mt-px flex-shrink-0">·</span>
              {l}
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-[13px] text-slate-400">{empty ?? "—"}</div>
      )}
    </div>
  );
}

// Visit row + inline delete (separate component to hold local busy state).
function FragmentRow({ v, se, patientId, onChange }: { v: Visit; se: string; patientId: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  async function del() {
    if (!window.confirm("ลบการนัดนี้?")) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/admin/mounjaro/visit/${v.id}`), { method: "DELETE" });
      if (res.ok) onChange();
    } finally { setBusy(false); }
  }
  void patientId;
  const decCls: Record<string, string> = {
    maintain: "border-slate-300 bg-slate-50 text-slate-500",
    increase: "border-[#047857] bg-[#ECFDF5] text-[#047857]",
    decrease: "border-[#B45309] bg-[#FEF3C7] text-[#78350F]",
    hold: "border-[#B91C1C] bg-[#FEF2F2] text-[#B91C1C]"
  };
  return (
    <>
      <tr className="border-b border-slate-200">
        <td className="py-3 px-4 font-medium text-[#3a2716]">{toBE(v.date)}</td>
        <td className="py-3 px-3 tabular-nums">{v.dose != null ? `${v.dose} mg` : "—"}</td>
        <td className="py-3 px-3 tabular-nums">{v.weight != null ? `${v.weight.toFixed(1)} กก.` : "—"}</td>
        <td className="py-3 px-3 tabular-nums">{v.bp || "—"} · {v.hr ?? "—"} bpm</td>
        <td className="py-3 px-3 text-[12px] text-slate-600">{se || "—"}</td>
        <td className="py-3 px-3">
          <span className={`inline-block px-2.5 py-0.5 text-[11px] font-medium rounded-xl border ${decCls[v.decision ?? "maintain"]}`}>
            {DECISION_LABEL[v.decision ?? "maintain"] ?? "—"}
          </span>
        </td>
        <td className="py-3 px-4 text-right">
          <button onClick={del} disabled={busy} className="text-[12px] text-[#B91C1C] hover:underline disabled:opacity-50">ลบ</button>
        </td>
      </tr>
      {v.notes && (
        <tr><td colSpan={7} className="bg-slate-50 text-[12px] text-slate-600 px-4 py-2 border-b border-slate-200">
          <b>บันทึก:</b> {v.notes}
        </td></tr>
      )}
    </>
  );
}

// ── SVG progress chart (weight + dose + HR) ─────────────────────────
function ProgressChart({ baseline, startDate, visits, selfLogs }: {
  baseline: { weight: number | null; hr: number | null }; startDate: string | null;
  visits: Visit[]; selfLogs: SelfLog[];
}) {
  type CP = { date: string | null; weight: number | null; dose: number | null; hr: number | null };
  const raw: CP[] = [
    { date: startDate, weight: baseline.weight, dose: 0, hr: baseline.hr },
    ...visits.map((v) => ({ date: v.date, weight: v.weight, dose: v.dose ?? null, hr: v.hr })),
    ...selfLogs.map((l) => ({ date: l.date, weight: l.weight, dose: null, hr: l.hr }))
  ].filter((p) => !!p.date);
  raw.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  // Forward-fill dose so the gold step line stays continuous across
  // self-log points (which carry no dose). Daily self-weigh-ins thus
  // densify the weight line without breaking the dose/HR series.
  let lastDose = 0;
  const pts = raw.map((p) => {
    if (p.dose != null) lastDose = p.dose;
    return { date: p.date, weight: p.weight, dose: lastDose, hr: p.hr };
  });
  const n = pts.length;
  const W = 760, H = 300, padL = 44, padR = 44, padT = 16, padB = 36;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const xAt = (i: number) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);

  const weights = pts.map((p) => p.weight).filter((w): w is number => w != null);
  const wMin = weights.length ? Math.min(...weights) : 0;
  const wMax = weights.length ? Math.max(...weights) : 1;
  const wLo = Math.floor(wMin - 2), wHi = Math.ceil(wMax + 2);
  const yW = (w: number) => padT + innerH - ((w - wLo) / Math.max(1, wHi - wLo)) * innerH;
  const yD = (d: number) => padT + innerH - (d / 15) * innerH;
  const hrs = pts.map((p) => p.hr).filter((h): h is number => h != null);
  const hLo = hrs.length ? Math.min(...hrs) - 5 : 0, hHi = hrs.length ? Math.max(...hrs) + 5 : 1;
  const yH = (h: number) => padT + innerH - ((h - hLo) / Math.max(1, hHi - hLo)) * innerH;

  const line = (vals: Array<number | null>, y: (v: number) => number) =>
    vals.map((v, i) => v == null ? null : `${xAt(i)},${y(v)}`).filter(Boolean).join(" ");
  const weightPts = line(pts.map((p) => p.weight), yW);
  const dosePts = pts.map((p, i) => `${xAt(i)},${yD(p.dose)}`).join(" ");
  const hrPts = line(pts.map((p) => p.hr), yH);

  return (
    <div>
      <div className="flex flex-wrap gap-4 justify-center text-[12px] text-slate-600 mb-2">
        <Legend color="#3a2716" label="น้ำหนัก (กก.)" />
        <Legend color="#a06820" label="ขนาดยา (mg)" />
        <Legend color="#B91C1C" label="HR (bpm)" dashed />
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 300 }}>
        {/* gridlines + left axis (weight) */}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const y = padT + innerH * t;
          const wv = (wHi - (wHi - wLo) * t).toFixed(0);
          const dv = (15 - 15 * t).toFixed(0);
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="#E5E0D5" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#9CA3AF">{wv}</text>
              <text x={W - padR + 6} y={y + 3} textAnchor="start" fontSize={9} fill="#a06820">{dv}</text>
            </g>
          );
        })}
        {/* x labels — thinned to ~6 so dense daily logs don't overlap */}
        {pts.map((p, i) => {
          const step = Math.max(1, Math.ceil(n / 6));
          if (i !== 0 && i !== n - 1 && i % step !== 0) return null;
          return <text key={i} x={xAt(i)} y={H - 10} textAnchor="middle" fontSize={9} fill="#9CA3AF">{toBE(p.date)}</text>;
        })}
        {/* dose (gold, stepped-ish) */}
        {n > 1 && <polyline points={dosePts} fill="none" stroke="#a06820" strokeWidth={2} />}
        {pts.map((p, i) => <circle key={`d${i}`} cx={xAt(i)} cy={yD(p.dose)} r={3} fill="#a06820" />)}
        {/* HR (red dashed) */}
        {hrPts && n > 1 && <polyline points={hrPts} fill="none" stroke="#B91C1C" strokeWidth={1.5} strokeDasharray="4 4" />}
        {pts.map((p, i) => p.hr != null ? <circle key={`h${i}`} cx={xAt(i)} cy={yH(p.hr)} r={2.5} fill="#B91C1C" /> : null)}
        {/* weight (navy) */}
        {weightPts && n > 1 && <polyline points={weightPts} fill="none" stroke="#3a2716" strokeWidth={2.5} />}
        {pts.map((p, i) => p.weight != null ? <circle key={`w${i}`} cx={xAt(i)} cy={yW(p.weight)} r={4} fill="#3a2716" /> : null)}
      </svg>
    </div>
  );
}
function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-5 h-0 border-t-2" style={{ borderColor: color, borderStyle: dashed ? "dashed" : "solid" }} />
      {label}
    </span>
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
      if (res.ok) onReplied();
    } finally { setBusy(false); }
  }
  return (
    <div className="text-[13px] border-b border-slate-200 last:border-0 pb-2.5">
      <div className="font-mono text-[12px] text-slate-500">{toBE(log.date)}
        {log.weight != null && <> · {log.weight} กก.</>}
        {log.bp && <> · BP {log.bp}</>}
        {log.hr != null && <> · HR {log.hr}</>}
        {log.fbs != null && <> · DTX {log.fbs}</>}
        {log.injection_done && <> · ฉีดแล้ว</>}</div>
      {log.diary && <div className="text-slate-600 mt-0.5">บันทึกประจำวัน: {log.diary}</div>}
      {log.notes_for_doctor && <div className="text-[#3a2716] mt-0.5">ผู้ป่วย: {log.notes_for_doctor}</div>}
      {log.doctor_reply ? (
        <div className="text-[#047857] bg-[#ECFDF5] rounded-xl px-2 py-1 mt-1">แพทย์: {log.doctor_reply}</div>
      ) : (
        <div className="flex gap-1.5 mt-1">
          <input className={inputCls + " !py-1 text-[12px]"} value={reply} placeholder="ตอบผู้ป่วย…" onChange={(e) => setReply(e.target.value)} />
          <button onClick={send} disabled={busy} className="px-3 text-[12px] bg-[#a06820] text-white rounded-xl disabled:opacity-50">ตอบ</button>
        </div>
      )}
    </div>
  );
}

// ── Visit modal ─────────────────────────────────────────────────────
function VisitModal({ patientId, defaultDose, onClose, onSaved }: {
  patientId: number; defaultDose: number; onClose: () => void; onSaved: () => void;
}) {
  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [dose, setDose] = useState(String(defaultDose));
  const [f, setF] = useState<Record<string, string>>({});
  const [se, setSe] = useState<Record<string, number>>({});
  const [hypo, setHypo] = useState("0");
  const [adh, setAdh] = useState("full");
  const [decision, setDecision] = useState("maintain");
  const [next, setNext] = useState(addDays(today, 28));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const numOf = (s: string) => (s.trim() === "" ? null : Number(s));
  async function save() {
    if (!date || !f.weight || !f.hr) { setErr("กรุณากรอกวันที่ น้ำหนัก และ HR"); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/mounjaro/visit"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId, date, dose: Number(dose),
          weight: numOf(f.weight ?? ""), waist: numOf(f.waist ?? ""), bp: f.bp || undefined,
          hr: numOf(f.hr ?? ""), hba1c: numOf(f.hba1c ?? ""), fbs: numOf(f.fbs ?? ""),
          side_effects: se, hypo_count: numOf(hypo) ?? 0, adherence: adh,
          decision, next_visit: next || null, notes: notes.trim() || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("บันทึกไม่สำเร็จ"); return; }
      onSaved();
    } finally { setBusy(false); }
  }
  const N = (k: string, label: string, req?: boolean) => (
    <div>
      <label className={labelCls}>{label}{req && <span className="text-[#B91C1C]"> *</span>}</label>
      <input type="number" step="0.1" className={inputCls + " mt-1"} value={f[k] ?? ""} onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))} />
    </div>
  );

  return (
    <ModalShell title="บันทึกการนัดติดตาม" sub="Follow-up Visit Entry" onClose={onClose}
      footer={<>
        <button onClick={onClose} disabled={busy} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-white">ยกเลิก</button>
        <button onClick={save} disabled={busy} className="px-5 py-2 text-[13px] bg-[#a06820] hover:bg-[#7a4f16] text-white rounded-xl disabled:opacity-50">{busy ? "กำลังบันทึก…" : "บันทึกการนัด"}</button>
      </>}>
      <Section title="ข้อมูลการนัด">
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className={labelCls}>วันที่นัด <span className="text-[#B91C1C]">*</span></label>
            <input type="date" className={inputCls + " mt-1"} value={date} max={today} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label className={labelCls}>ขนาดยาปัจจุบัน (mg) <span className="text-[#B91C1C]">*</span></label>
            <select className={inputCls + " mt-1"} value={dose} onChange={(e) => setDose(e.target.value)}>
              {DOSES.map((d) => <option key={d} value={d}>{d}{d === 2.5 ? " mg (starter)" : d === 15 ? " mg (max)" : " mg"}</option>)}
            </select></div>
        </div>
      </Section>

      <Section title="สัญญาณชีพและน้ำหนัก">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {N("weight", "น้ำหนัก (กก.)", true)}
          {N("waist", "รอบเอว (ซม.)")}
          <div><label className={labelCls}>BP (mmHg)</label><input className={inputCls + " mt-1"} value={f.bp ?? ""} onChange={(e) => setF((p) => ({ ...p, bp: e.target.value }))} placeholder="120/80" /></div>
          {N("hr", "HR (bpm)", true)}
          {N("hba1c", "HbA1c (%) — ทุก 3 เดือน")}
          {N("fbs", "FBS (mg/dL)")}
        </div>
      </Section>

      <Section title="ผลข้างเคียง · Side Effects (0=ไม่มี · 1=เล็กน้อย · 2=ปานกลาง · 3=รุนแรง)">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {SE_FIELDS.map(([k, label]) => (
            <div key={k} className="border border-slate-200 p-3">
              <div className="text-[12px] font-medium mb-2 text-[#3a2716]">{label}</div>
              <div className="flex gap-1">
                {[0, 1, 2, 3].map((lvl) => {
                  const active = (se[k] ?? 0) === lvl;
                  const colors = ["bg-[#047857] border-[#047857] text-white", "bg-[#FCD34D] border-[#F59E0B] text-[#78350F]", "bg-[#B45309] border-[#B45309] text-white", "bg-[#B91C1C] border-[#B91C1C] text-white"];
                  return (
                    <button key={lvl} type="button" onClick={() => setSe((p) => ({ ...p, [k]: lvl }))}
                      className={`flex-1 h-7 text-[11px] font-medium border ${active ? colors[lvl] : "bg-white border-slate-300 text-slate-500 hover:border-[#a06820]"}`}>{lvl}</button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="การปฏิบัติตามและภาวะแทรกซ้อน">
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className={labelCls}>จำนวนครั้งน้ำตาลต่ำ (ตั้งแต่นัดที่แล้ว)</label><input type="number" className={inputCls + " mt-1"} value={hypo} onChange={(e) => setHypo(e.target.value)} /></div>
          <div><label className={labelCls}>การฉีดยา (Adherence)</label>
            <select className={inputCls + " mt-1"} value={adh} onChange={(e) => setAdh(e.target.value)}>
              {Object.entries(ADH_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
        </div>
      </Section>

      <Section title="การตัดสินใจ · Decision">
        <div className="grid sm:grid-cols-2 gap-4">
          <div><label className={labelCls}>การปรับขนาดยา <span className="text-[#B91C1C]">*</span></label>
            <select className={inputCls + " mt-1"} value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="maintain">คงขนาดเดิม (Maintain)</option><option value="increase">ปรับขึ้น (Titrate up)</option>
              <option value="decrease">ปรับลง (Titrate down)</option><option value="hold">หยุดยาชั่วคราว (Hold)</option>
            </select></div>
          <div><label className={labelCls}>นัดครั้งถัดไป</label><input type="date" className={inputCls + " mt-1"} value={next} onChange={(e) => setNext(e.target.value)} /></div>
          <div className="sm:col-span-2"><label className={labelCls}>บันทึกแพทย์ / Notes</label>
            <textarea className={inputCls + " mt-1"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="อาการ การให้คำแนะนำ การปรับยา ฯลฯ" /></div>
        </div>
      </Section>
      {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
    </ModalShell>
  );
}

// ── Patient edit modal (baseline / flags) ───────────────────────────
function PatientEditModal(props: {
  patientId: number; hn: string | null; startDate: string | null;
  baseline: Record<string, number | string>; comorbidities: Record<string, boolean>;
  contraindications: Record<string, boolean>; medications: Record<string, boolean>;
  notes: string | null; employeeDob?: string | null; employeePhone?: string | null;
  onClose: () => void; onSaved: () => void;
}) {
  const { patientId, baseline } = props;
  const [hn, setHn] = useState(props.hn ?? "");
  const [start, setStart] = useState(props.startDate ?? "");
  // Prefill age/phone from the linked employee record when the baseline
  // override is blank (owner 2026-06-08).
  const [age, setAge] = useState(
    num(baseline, "age")?.toString() ?? (ageFromDob(props.employeeDob)?.toString() ?? ""));
  const [sex, setSex] = useState((baseline.sex as string) || "หญิง");
  const [phone, setPhone] = useState((baseline.phone as string) || props.employeePhone || "");
  const [bp, setBp] = useState((baseline.bp as string) || "");
  const [b, setB] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const k of ["weight", "height", "hr", "hba1c", "fbs", "waist", "target"]) {
      const v = num(baseline, k); if (v != null) init[k] = String(v);
    }
    return init;
  });
  const [como, setComo] = useState({ ...props.comorbidities });
  const [contra, setContra] = useState({ ...props.contraindications });
  const [meds, setMeds] = useState({ ...props.medications });
  const [notes, setNotes] = useState(props.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const numOf = (s: string) => (s.trim() === "" ? undefined : Number(s));
  async function save() {
    if (!hn.trim() || !b.weight || !b.height || !b.hr) { setErr("กรุณากรอก HN, น้ำหนัก, ส่วนสูง, HR"); return; }
    setBusy(true); setErr(null);
    try {
      const baselineOut: Record<string, number> = {};
      for (const k of ["weight", "height", "hr", "hba1c", "fbs", "waist", "target"]) {
        const v = numOf(b[k] ?? ""); if (v != null && !Number.isNaN(v)) baselineOut[k] = v;
      }
      const res = await fetch(apiUrl(`/api/admin/mounjaro/patient/${patientId}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hn: hn.trim() || undefined, baseline: baselineOut, bp: bp.trim() || undefined,
          age: age.trim() ? Number(age) : undefined, sex, phone: phone.trim() || undefined,
          comorbidities: como, contraindications: contra, medications: meds,
          notes: notes.trim() || undefined, start_date: start || undefined
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr("บันทึกไม่สำเร็จ"); return; }
      props.onSaved();
    } finally { setBusy(false); }
  }
  const Num = (k: string, label: string, req?: boolean) => (
    <div><label className={labelCls}>{label}{req && <span className="text-[#B91C1C]"> *</span>}</label>
      <input type="number" step="0.1" className={inputCls + " mt-1"} value={b[k] ?? ""} onChange={(e) => setB((p) => ({ ...p, [k]: e.target.value }))} /></div>
  );

  return (
    <ModalShell title="แก้ไขข้อมูลผู้ป่วย" sub="Edit Patient" onClose={props.onClose}
      footer={<>
        <button onClick={props.onClose} disabled={busy} className="px-4 py-2 text-[13px] border border-slate-300 rounded-xl text-[#3a2716] hover:bg-white">ยกเลิก</button>
        <button onClick={save} disabled={busy} className="px-5 py-2 text-[13px] bg-[#a06820] hover:bg-[#7a4f16] text-white rounded-xl disabled:opacity-50">{busy ? "กำลังบันทึก…" : "บันทึก"}</button>
      </>}>
      <Section title="ข้อมูลผู้ป่วย">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div><label className={labelCls}>HN <span className="text-[#B91C1C]">*</span></label><input className={inputCls + " mt-1"} value={hn} onChange={(e) => setHn(e.target.value)} /></div>
          <div><label className={labelCls}>อายุ (ปี)</label><input type="number" className={inputCls + " mt-1"} value={age} onChange={(e) => setAge(e.target.value)} /></div>
          <div><label className={labelCls}>เพศ</label><select className={inputCls + " mt-1"} value={sex} onChange={(e) => setSex(e.target.value)}><option value="หญิง">หญิง</option><option value="ชาย">ชาย</option><option value="อื่นๆ">อื่นๆ</option></select></div>
          <div><label className={labelCls}>เบอร์โทร</label><input className={inputCls + " mt-1"} value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div><label className={labelCls}>วันที่เริ่มยา</label><input type="date" className={inputCls + " mt-1"} value={start} onChange={(e) => setStart(e.target.value)} /></div>
        </div>
      </Section>
      <Section title="ข้อมูลพื้นฐาน (Baseline)">
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Num("weight", "น้ำหนัก (กก.)", true)}{Num("height", "ส่วนสูง (ซม.)", true)}{Num("waist", "รอบเอว (ซม.)")}
          <div><label className={labelCls}>BP baseline (mmHg)</label><input className={inputCls + " mt-1"} value={bp} onChange={(e) => setBp(e.target.value)} placeholder="120/80" /></div>
          {Num("hr", "HR baseline (bpm)", true)}{Num("hba1c", "HbA1c (%)")}{Num("fbs", "FBS (mg/dL)")}{Num("target", "เป้าหมายน้ำหนัก (กก.)")}
        </div>
      </Section>
      <Section title="ประวัติโรคและข้อห้าม">
        <CheckRow state={como} set={setComo} items={COMO_FORM} />
        <div className="mt-3 bg-[#FEF2F2] border-l-[3px] border-[#B91C1C] px-3 py-2.5">
          <div className="text-[12px] font-semibold text-[#B91C1C] mb-2">ข้อห้ามเด็ดขาด — ห้ามใช้หาก:</div>
          <CheckRow state={contra} set={setContra} items={CONTRA_FORM} />
        </div>
      </Section>
      <Section title="ยาที่ใช้ร่วม">
        <CheckRow state={meds} set={setMeds} items={MED_FORM} />
        <div className="mt-3"><label className={labelCls}>ยาอื่นๆ / หมายเหตุ</label><textarea className={inputCls + " mt-1"} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      </Section>
      {err && <p className="text-sm text-[#B91C1C]">✗ {err}</p>}
    </ModalShell>
  );
}

const COMO_FORM: Array<[string, string]> = [["dm", "เบาหวานชนิดที่ 2"], ["htn", "ความดันโลหิตสูง"], ["dlp", "ไขมันในเลือดสูง"], ["cvd", "โรคหัวใจและหลอดเลือด (CVD)"], ["ckd", "โรคไตเรื้อรัง"], ["panc", "ประวัติตับอ่อนอักเสบ"], ["gb", "นิ่วในถุงน้ำดี"]];
const CONTRA_FORM: Array<[string, string]> = [["mtc", "ประวัติครอบครัวเป็นมะเร็งต่อมไทรอยด์ชนิดเมดัลลารี"], ["men2", "กลุ่มอาการเนื้องอกต่อมไร้ท่อหลายตำแหน่งชนิดที่ 2 (MEN 2)"], ["preg", "ตั้งครรภ์ / วางแผนตั้งครรภ์"], ["allergy", "แพ้ยา tirzepatide"]];
const MED_FORM: Array<[string, string]> = [["insulin", "Insulin (เสี่ยงน้ำตาลต่ำ)"], ["su", "Sulfonylurea (เสี่ยงน้ำตาลต่ำ)"], ["met", "Metformin"], ["sglt2", "SGLT2 inhibitor"], ["ocp", "ยาเม็ดคุมกำเนิด"]];

// ── Shared bits reused from the registry side ───────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 last:mb-0">
      <div className="inline-block text-[12px] font-semibold text-[#3a2716] uppercase tracking-[0.1em] mb-3.5 pb-2 pr-10 border-b border-[#a06820]">{title}</div>
      {children}
    </div>
  );
}
function CheckRow({ state, set, items }: {
  state: Record<string, boolean>; set: React.Dispatch<React.SetStateAction<Record<string, boolean>>>; items: Array<[string, string]>;
}) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-3">
      {items.map(([k, label]) => (
        <label key={k} className="flex items-center gap-1.5 text-[13px] cursor-pointer">
          <input type="checkbox" className="w-4 h-4 accent-[#a06820]" checked={!!state[k]} onChange={(e) => set((p) => ({ ...p, [k]: e.target.checked }))} />
          {label}
        </label>
      ))}
    </div>
  );
}
function ModalShell({ title, sub, onClose, footer, children }: {
  title: string; sub: string; onClose: () => void; footer: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/50 backdrop-blur-[2px] p-4 sm:p-10 overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white w-full max-w-3xl rounded-2xl border-t-[3px] border-[#a06820] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between rounded-t-2xl">
          <div><div className="text-[#3a2716] font-semibold text-[16px]">{title}</div>
            <div className="text-[10px] text-[#a06820] tracking-[0.1em] uppercase mt-0.5">{sub}</div></div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg border border-slate-200 text-slate-400 text-lg hover:bg-slate-50">×</button>
        </div>
        <div className="p-6 max-h-[70vh] overflow-y-auto">{children}</div>
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-2.5">{footer}</div>
      </div>
    </div>
  );
}

function addDays(d: string, days: number): string {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
}
