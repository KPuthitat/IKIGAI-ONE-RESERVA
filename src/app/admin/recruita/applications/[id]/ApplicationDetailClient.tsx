"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import PinPromptModal from "@/app/components/PinPromptModal";
import type {
  ApplicationStage, CustomQuestion, CustomAnswers
} from "@/lib/recruita";
import { infoSourceLabel } from "@/lib/recruita";
import { formatBkkDateTime } from "@/lib/time";
import { nameWithPrefix } from "@/lib/name";

type StageMeta = Record<ApplicationStage, { label: string; chip: string }>;

type AppShape = {
  id: number; candidate_id: number; position_id: number;
  stage: ApplicationStage; submitted_at: string;
  expected_salary: number | null; earliest_start_date: string | null;
  /** Offer terms captured at the 'offered' stage (owner 2026-06-15). The
   *  hire form pre-fills + locks salary / start-date / mode to these. */
  offer_salary: number | null;
  offer_salary_type: "monthly" | "hourly" | null;
  offer_start_date: string | null;
  why_join: string | null; goals: string | null;
  info_source: string | null; can_travel: number | null;
  truth_declaration_accepted: number | null;
  consent_at: string | null; consent_ip: string | null;
  last_workplace: string | null; last_position: string | null;
  last_tenure: string | null; last_salary: string | null;
  last_reason_left: string | null;
  /** Interview schedule (naive Bangkok-local "YYYY-MM-DDTHH:MM"). */
  interview_at: string | null;
  interview_location: string | null;
  interview_note: string | null;
  /** Post-interview medical check (owner 2026-06-04). Hiring is blocked
   *  until health_check_status = 'passed'. */
  health_check_status: "pending" | "passed" | "failed" | null;
  health_check_provider: "self" | "at_home" | null;
  health_check_at: string | null;
  health_check_note: string | null;
  /** Set once the hire bridge runs — points at users.id in PERSONA. */
  hired_user_id: number | null;
  hired_at: string | null;
};

type CandidateShape = {
  id: number;
  /** LINE userId once the candidate has been linked — either via
   *  LIFF capture during apply, or pasted by an admin in the manual-
   *  link box on this page. NULL when not linked. */
  line_user_id: string | null;
  title_prefix: string | null;
  first_name_th: string | null; last_name_th: string | null;
  first_name_en: string | null; last_name_en: string | null;
  nickname_th: string | null;
  dob: string | null; gender: string | null;
  nationality: string | null; race: string | null;
  marital_status: string | null;
  military_status: string | null;
  religion: string | null;
  housing_type: string | null;
  professional_license_status: string | null;
  prior_illness: number | null;
  prior_illness_detail: string | null;
  prior_application_at: string | null;
  referee_external_text: string | null;
  personal_email: string | null;
  mobile_phone: string | null;
  line_id: string | null;
  house_address: string | null;
  emergency_name: string | null;
  emergency_relationship: string | null;
  emergency_phone: string | null;
  skills_other: string | null;
};

type DocShape = {
  id: number; kind: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string;
};

type PositionShape = {
  id: number; title: string; code: string | null;
  branch_id: number | null;
  branch_name: string | null; department: string | null;
};

type Branch = { id: number; name: string };
type Supervisor = { id: number; display_name: string; title_prefix: string | null };

type HireResult = {
  user_id: number;
  invite_id: number;
  url: string;
  liff_url: string | null;
  direct_url: string;
  expires_at: string;
};

const ALL_STAGES: ApplicationStage[] = [
  "applied", "screening", "interview", "health_check", "offered",
  "accepted", "hired", "rejected", "withdrawn"
];

const GENDER_LABEL: Record<string, string> = {
  male: "ชาย", female: "หญิง", other: "อื่นๆ"
};
const MARITAL_LABEL: Record<string, string> = {
  single: "โสด", married: "สมรส", divorced: "หย่าร้าง", widowed: "หม้าย"
};
const HOUSING_LABEL: Record<string, string> = {
  family: "อาศัยกับครอบครัว", own_home: "บ้านตัวเอง",
  rental: "บ้านเช่า", dormitory: "หอพัก", other: "อื่นๆ"
};
const MILITARY_LABEL: Record<string, string> = {
  exempt: "ได้รับการยกเว้น", reservist: "ปลดเป็นทหารกองหนุน",
  pending: "ยังไม่ได้รับการเกณฑ์"
};
const LICENSE_LABEL: Record<string, string> = {
  has_license: "มีใบประกอบวิชาชีพ",
  no_license: "ไม่มีใบประกอบวิชาชีพ",
  not_applicable: "ไม่ได้สมัครตำแหน่งดังกล่าว"
};
// Education level + language proficiency — admin detail used to show
// the raw enum value ("bachelor" / "good") which leaked English into
// a Thai-mode UI. Map back to the same labels the apply form showed
// the candidate so what they typed equals what admin sees.
const EDUCATION_LABEL: Record<string, string> = {
  primary: "ประถมศึกษา",
  middle: "มัธยมต้น",
  high: "มัธยมปลาย",
  vocational: "ปวช.",
  diploma: "ปวส. / อนุปริญญา",
  bachelor: "ปริญญาตรี",
  master: "ปริญญาโท",
  doctorate: "ปริญญาเอก"
};
const LANG_LEVEL_LABEL: Record<string, string> = {
  native: "เจ้าของภาษา",
  fluent: "คล่อง",
  good: "ดี",
  basic: "พอใช้",
  beginner: "เริ่มต้น"
};
// Employment-type chips on positions list / detail / pipeline. Owner
// 2026-06-01: pure-Thai display in TH mode. Loanword Full-time/
// Part-time felt familiar but inconsistent with the rest of the
// labels (ตำแหน่ง / สาขา / ค่าตอบแทน etc.) and read as English-y
// to a customer-facing audience.
const EMP_TYPE_LABEL: Record<string, string> = {
  ft: "พนักงานประจำ",
  pt: "พนักงานพาร์ทไทม์",
  contract: "พนักงานสัญญาจ้างระยะสั้น"
};

// Server-derived shape from getActivePendingRequest(). We model it
// locally so the client doesn't import server-only modules.
export type PendingStageRequest = {
  id: number;
  application_id: number;
  from_stage: ApplicationStage;
  to_stage: ApplicationStage;
  requested_by: number;
  requested_at: string;
  expires_at: string;
  requester_name: string | null;
  requester_prefix: string | null;
};

export default function ApplicationDetailClient({
  application, applicationNo, candidate, nationalIdPlain, position, documents,
  education, experience, languages,
  customQuestions, customAnswers, stageMeta,
  branches, supervisors,
  pendingStageRequest, viewerHasPin, viewerUserId
}: {
  application: AppShape;
  /** Pre-formatted #YYYYMMDD00x display number (computed server-side). */
  applicationNo: string;
  candidate: CandidateShape;
  nationalIdPlain: string | null;
  position: PositionShape;
  documents: DocShape[];
  education: Array<Record<string, string>>;
  experience: Array<Record<string, string>>;
  languages: Array<Record<string, string>>;
  customQuestions: CustomQuestion[];
  customAnswers: CustomAnswers;
  stageMeta: StageMeta;
  branches: Branch[];
  supervisors: Supervisor[];
  /** Pending stage-change request loaded server-side. NULL means
   *  this application has no live request — the "เปลี่ยนสถานะ"
   *  card renders the stage-pick UI. When set, the card flips to
   *  "อยู่ระหว่างขออนุมัติ" with approve/cancel buttons. */
  pendingStageRequest: PendingStageRequest | null;
  /** Whether the logged-in admin has a PIN configured. If false we
   *  disable the request + approve actions and link to /staff/persona. */
  viewerHasPin: boolean;
  /** Logged-in admin's id — used to enforce "approver ≠ requester"
   *  on the client (server enforces it too). 0 when not logged in
   *  (which the page redirect already filters out, but keep typed). */
  viewerUserId: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [showId, setShowId] = useState(false);
  const [stage, setStage] = useState<ApplicationStage>(application.stage);
  const [showHire, setShowHire] = useState(false);
  const [hireResult, setHireResult] = useState<HireResult | null>(null);

  // Dual-admin stage flow state. Owner 2026-06-01: every stage change
  // requires two different admins, each entering their PIN.
  //   - requestStageTarget: when set, opens the "Admin A enters PIN
  //     to request" modal targeting that stage.
  //   - approveModalOpen: when true, opens the "Admin B enters PIN
  //     to approve the current pending request" modal.
  //   - cancelModalOpen: when true, opens the cancel-request prompt
  //     (no PIN — only the requester or a super_admin can cancel).
  const [requestStageTarget, setRequestStageTarget] = useState<ApplicationStage | null>(null);
  // First work day + compensation captured in the offer popup (owner 2026-06-15).
  const [offerStartDate, setOfferStartDate] = useState("");
  const [offerSalary, setOfferSalary] = useState("");
  const [offerSalaryType, setOfferSalaryType] = useState<"monthly" | "hourly">("monthly");
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);

  const name = [candidate.title_prefix, candidate.first_name_th, candidate.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const nameEn = [candidate.first_name_en, candidate.last_name_en]
    .filter(Boolean).join(" ");

  // Legacy direct-stage write — kept for the hire-bridge code path
  // that still flips stage='hired' as part of its own atomic
  // transaction. Stage CHANGES through the user-facing buttons now
  // go through the request/approve flow below.
  async function setStageOnServer(s: ApplicationStage) {
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${application.id}/stage`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: s })
      });
      if (res.ok) {
        setStage(s);
        startTransition(() => router.refresh());
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="card space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-400 font-mono">{applicationNo}</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${stageMeta[stage].chip}`}>
            {stageMeta[stage].label}
          </span>
        </div>
        <h1 className="text-2xl font-bold text-slate-800">{name}</h1>
        {nameEn && <p className="text-sm text-slate-500">{nameEn}{candidate.nickname_th ? ` · ชื่อเล่น ${candidate.nickname_th}` : ""}</p>}
        <p className="text-xs text-slate-500">
          {position.code ? `[${position.code}] ` : ""}{position.title}
          {position.branch_name && <> · <span className="font-semibold text-slate-700">{position.branch_name}</span></>}
          {position.department && <> · {position.department}</>}
        </p>
        <p className="text-[11px] text-slate-400">
          ส่งใบสมัคร {formatBkkDateTime(application.submitted_at)}
        </p>
      </div>

      {/* Interview scheduling — admin sets a date/time; the candidate
          gets a LINE push (if linked). Independent of the stage flow. */}
      <InterviewSection
        applicationId={application.id}
        initialAt={application.interview_at}
        initialLocation={application.interview_location}
        initialNote={application.interview_note}
      />

      {/* Post-interview health check (owner 2026-06-04) — admin records
          the medical-clearance result; hiring is blocked until 'passed'. */}
      <HealthCheckSection
        applicationId={application.id}
        status={application.health_check_status}
        provider={application.health_check_provider}
        at={application.health_check_at}
        note={application.health_check_note}
        resultDoc={documents.find((d) => d.kind === "health_result") ?? null}
        certDoc={documents.find((d) => d.kind === "health_cert") ?? null}
      />

      {/* Stage controls — dual-admin gated.
          Three states:
            1. pendingStageRequest !== null
               → render approve/cancel banner. Approver must be a
                 different user from requester (server enforces too).
            2. !viewerHasPin → render "Set PIN first" prompt with link.
            3. Otherwise → render the stage buttons. Each click opens
               the request modal asking for PIN.
      */}
      {pendingStageRequest ? (
        <div className="card space-y-3 border-amber-300 bg-amber-50">
          <div>
            <h2 className="font-bold text-amber-900 text-sm">
              อยู่ระหว่างขออนุมัติเปลี่ยนสถานะ
            </h2>
            <p className="text-xs text-amber-800 mt-1">
              ผู้ขอ:&nbsp;
              <span className="font-bold">
                {[pendingStageRequest.requester_prefix, pendingStageRequest.requester_name]
                  .filter(Boolean).join(" ") || "—"}
              </span>
              &nbsp;· เปลี่ยน&nbsp;
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${stageMeta[pendingStageRequest.from_stage].chip}`}>
                {stageMeta[pendingStageRequest.from_stage].label}
              </span>
              &nbsp;→&nbsp;
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${stageMeta[pendingStageRequest.to_stage].chip}`}>
                {stageMeta[pendingStageRequest.to_stage].label}
              </span>
            </p>
            <p className="text-[10px] text-amber-700 mt-1">
              คำขอเลขที่ #{pendingStageRequest.id} ·
              สิ้นสุดเวลาอนุมัติ {formatBkkDateTime(pendingStageRequest.expires_at)}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {pendingStageRequest.requested_by !== viewerUserId && (
              <button type="button"
                onClick={() => setApproveModalOpen(true)}
                disabled={busy || !viewerHasPin}
                className="flex-1 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold disabled:opacity-50">
                ✓ อนุมัติ (ใส่ PIN)
              </button>
            )}
            {pendingStageRequest.requested_by === viewerUserId && (
              <div className="flex-1 py-2.5 rounded-lg bg-slate-100 text-slate-600 text-sm text-center">
                คุณเป็นผู้ขอ — ต้องให้แอดมินคนอื่นอนุมัติ
              </div>
            )}
            <button type="button"
              onClick={() => setCancelModalOpen(true)}
              disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-slate-700 text-sm font-bold">
              ยกเลิกคำขอ
            </button>
          </div>
          {!viewerHasPin && pendingStageRequest.requested_by !== viewerUserId && (
            <a href="/staff/persona" className="text-xs text-rose-600 underline">
              คุณยังไม่ได้ตั้ง PIN — กดที่นี่เพื่อตั้งก่อนอนุมัติ
            </a>
          )}
        </div>
      ) : !viewerHasPin ? (
        <div className="card bg-rose-50 border-rose-200 space-y-2">
          <h2 className="font-bold text-rose-900 text-sm">ต้องตั้ง PIN ก่อนเปลี่ยนสถานะ</h2>
          <p className="text-xs text-rose-800">
            ใช้ PIN ตัวเดียวกับลงเวลา (Time Clock) — ยังไม่ตั้ง ไปตั้งที่หน้าลงเวลาก่อน
          </p>
          <a href="/staff/persona"
            className="inline-block text-xs bg-rose-600 hover:bg-rose-700 text-white font-bold px-4 py-2 rounded">
            ไปหน้าลงเวลา → ตั้ง PIN
          </a>
        </div>
      ) : (
        <div className="card space-y-2">
          <h2 className="font-bold text-slate-800 text-sm">เปลี่ยนสถานะ</h2>
          <p className="text-[11px] text-slate-500">
            การกดปุ่ม = ขออนุมัติ. ต้องมีแอดมินคนที่ 2 อนุมัติด้วย PIN
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {ALL_STAGES.map((s) => {
              const m = stageMeta[s];
              const active = s === stage;
              return (
                <button key={s} type="button"
                  onClick={() => setRequestStageTarget(s)}
                  disabled={busy || active}
                  className={`text-xs py-2 rounded-md border font-bold ${
                    active
                      ? `${m.chip} ring-2 ring-offset-1 ring-slate-400`
                      : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  } disabled:cursor-default`}>
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {requestStageTarget && (() => {
        // Only ใบสมัครใหม่ → คัดกรอง needs a 2nd admin (owner 2026-06-11);
        // any other transition applies immediately with this admin's PIN.
        const isDual = stage === "applied" && requestStageTarget === "screening";
        return (
        <PinPromptModal
          title={isDual ? "ขออนุมัติเปลี่ยนสถานะ (2 แอดมิน)" : requestStageTarget === "offered" ? "เสนองาน" : "ยืนยันเปลี่ยนสถานะ"}
          description={
            <>
              จาก <b>{stageMeta[stage].label}</b> ไป
              {" "}<b>{stageMeta[requestStageTarget].label}</b>
              {requestStageTarget === "offered" && (
                <div className="mt-2">
                  <label className="label">วันเริ่มงานวันแรก</label>
                  <input type="date" className="input text-sm" value={offerStartDate}
                    onChange={(e) => setOfferStartDate(e.target.value)} />
                  <label className="label mt-2">ค่าตอบแทนที่เสนอ</label>
                  <div className="flex gap-2">
                    <input type="number" min={0} className="input text-sm flex-1" placeholder="จำนวน"
                      value={offerSalary} onChange={(e) => setOfferSalary(e.target.value)} />
                    <select className="input text-sm !w-auto" value={offerSalaryType}
                      onChange={(e) => setOfferSalaryType(e.target.value as "monthly" | "hourly")}>
                      <option value="monthly">บาท/เดือน</option>
                      <option value="hourly">บาท/ชม.</option>
                    </select>
                  </div>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    ตำแหน่ง + ค่าตอบแทน + วันเริ่มงาน จะแสดงในการ์ดข้อเสนอที่ส่งให้ผู้สมัคร
                  </p>
                </div>
              )}
              <div className="mt-2">{isDual
                ? "ใส่ PIN ของคุณเพื่อสร้างคำขอ (ต้องมีแอดมินคนที่ 2 อนุมัติ)"
                : "ใส่ PIN ของคุณเพื่อเปลี่ยนสถานะทันที"}</div>
            </>
          }
          submitLabel={isDual ? "ส่งคำขอ" : requestStageTarget === "offered" ? "เสนองาน" : "เปลี่ยนสถานะ"}
          onClose={() => { setRequestStageTarget(null); setOfferStartDate(""); setOfferSalary(""); }}
          onSubmit={async (pin) => {
            const target = requestStageTarget;
            if (target === "offered" && !/^\d{4}-\d{2}-\d{2}$/.test(offerStartDate)) {
              return { ok: false, message: "กรุณาเลือกวันเริ่มงานวันแรกก่อนเสนองาน" };
            }
            if (target === "offered" && !(Number(offerSalary) > 0)) {
              return { ok: false, message: "กรุณากรอกค่าตอบแทนที่เสนอ" };
            }
            const res = await fetch(
              apiUrl(`/api/recruita/applications/${application.id}/stage-request`),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  to_stage: target, pin,
                  ...(target === "offered" ? {
                    offer_start_date: offerStartDate,
                    offer_salary: Number(offerSalary),
                    offer_salary_type: offerSalaryType
                  } : {})
                })
              }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.message ?? j.error ?? "เปลี่ยนสถานะไม่สำเร็จ" };
            }
            // Single-admin path applied the change immediately → reflect it.
            if (j.applied) setStage(target);
            setRequestStageTarget(null);
            setOfferStartDate("");
            setOfferSalary("");
            startTransition(() => router.refresh());
            return { ok: true };
          }} />
        );
      })()}

      {approveModalOpen && pendingStageRequest && (
        <PinPromptModal
          title="อนุมัติการเปลี่ยนสถานะ"
          description={
            <>
              อนุมัติเปลี่ยน <b>{stageMeta[pendingStageRequest.from_stage].label}</b>
              {" "}→ <b>{stageMeta[pendingStageRequest.to_stage].label}</b>
              <br />ใส่ PIN ของคุณเพื่อยืนยัน
            </>
          }
          submitLabel="อนุมัติ"
          onClose={() => setApproveModalOpen(false)}
          onSubmit={async (pin) => {
            const res = await fetch(
              apiUrl(`/api/recruita/applications/${application.id}/stage-request/${pendingStageRequest.id}`),
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pin })
              }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.message ?? j.error ?? "อนุมัติไม่สำเร็จ" };
            }
            setApproveModalOpen(false);
            setStage(pendingStageRequest.to_stage);
            startTransition(() => router.refresh());
            return { ok: true };
          }} />
      )}

      {cancelModalOpen && pendingStageRequest && (
        <CancelPromptModal
          onClose={() => setCancelModalOpen(false)}
          onConfirm={async (reason) => {
            const res = await fetch(
              apiUrl(`/api/recruita/applications/${application.id}/stage-request/${pendingStageRequest.id}`),
              {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason })
              }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok || !j.ok) {
              return { ok: false, message: j.error ?? "ยกเลิกไม่สำเร็จ" };
            }
            setCancelModalOpen(false);
            startTransition(() => router.refresh());
            return { ok: true };
          }} />
      )}

      {/* Hire bridge — appears only when not yet hired. The button stays
          DISABLED until the candidate has ACCEPTED the offer (stage =
          'accepted') AND the health check is 'passed' (owner 2026-06-15:
          no skipping straight to hire). Server enforces the same. */}
      {stage !== "hired" && !hireResult && (
        <div className="card bg-emerald-50 border-2 border-emerald-200 space-y-2">
          <h2 className="font-bold text-emerald-900 text-sm">
            พร้อมรับเข้าทำงาน?
          </h2>
          <p className="text-xs text-emerald-800 leading-relaxed">
            กดปุ่มด้านล่างเพื่อสร้างบัญชี PERSONA ให้พนักงานใหม่ทันที — ระบบจะ:
          </p>
          <ul className="text-xs text-emerald-800 list-disc list-inside space-y-0.5">
            <li>สร้าง user ใน PERSONA โดยใช้ข้อมูลจากใบสมัครทุก field (ไม่ต้องคีย์ใหม่)</li>
            <li>ผูกเข้าสาขาที่เลือก + ลงตำแหน่งงานให้</li>
            <li>เปลี่ยน stage ใบสมัครนี้เป็น "รับเข้าทำงาน" อัตโนมัติ</li>
            <li>ส่ง invite link ให้แชร์กับพนักงานใหม่ตั้งรหัสผ่าน + เชื่อมต่อ LINE</li>
          </ul>
          {stage !== "accepted" && (
            <p className="text-xs text-rose-700 font-bold bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
              ⚠ ผู้สมัครต้องตอบรับข้อเสนองานก่อน — สถานะต้องเป็น &quot;ตอบรับข้อเสนอ&quot;
              (เลื่อนไป &quot;เสนองาน&quot; แล้วให้ผู้สมัครกดตอบรับในการ์ด LINE)
            </p>
          )}
          {application.health_check_status !== "passed" && (
            <p className="text-xs text-rose-700 font-bold bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
              ⚠ ต้องบันทึกผลตรวจสุขภาพเป็น &quot;ผ่าน&quot; ก่อนจึงจะรับเข้าทำงานได้ (ดูส่วน &quot;ผลตรวจสุขภาพ&quot; ด้านบน)
            </p>
          )}
          <button type="button" onClick={() => setShowHire(true)}
            disabled={busy || stage !== "accepted" || application.health_check_status !== "passed"}
            className="btn-primary w-full text-base py-3 mt-2 disabled:opacity-50 disabled:cursor-not-allowed">
            ✓ รับเข้าทำงาน
          </button>
        </div>
      )}

      {/* Already hired — show the link to the new PERSONA user */}
      {(stage === "hired" || hireResult) && application.hired_user_id != null && (
        <div className="card bg-emerald-50 border-2 border-emerald-200 space-y-2">
          <h2 className="font-bold text-emerald-900 text-sm">
            ✓ รับเข้าทำงานแล้ว
          </h2>
          <p className="text-xs text-emerald-800">
            user_id ใน PERSONA: <span className="font-mono">#{application.hired_user_id ?? hireResult?.user_id}</span>
          </p>
          {hireResult && (
            <InviteLinkBox result={hireResult} />
          )}
        </div>
      )}

      {/* Quick contact */}
      <div className="card grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <Row label="มือถือ" value={candidate.mobile_phone}
          link={candidate.mobile_phone ? `tel:${candidate.mobile_phone}` : null} />
        <Row label="อีเมล" value={candidate.personal_email}
          link={candidate.personal_email ? `mailto:${candidate.personal_email}` : null} />
        <Row label="LINE ID" value={candidate.line_id} />
        <Row label="ที่อยู่" value={candidate.house_address} />
      </div>

      {/* LINE userId binding — drives whether stage-change pushes
          reach the candidate AND whether they can see this on
          /recruita/status. Populated automatically when they apply
          via LIFF; for direct-URL applicants, admin pastes the
          userId the candidate copied from the status page. */}
      <LineLinkBox
        applicationId={application.id}
        currentValue={candidate.line_user_id} />


      {/* Personal */}
      <Card title="ข้อมูลส่วนตัว">
        <Grid2>
          <Row label="วันเกิด" value={candidate.dob} />
          <Row label="เพศ" value={candidate.gender ? GENDER_LABEL[candidate.gender] ?? candidate.gender : null} />
          <Row label="สัญชาติ" value={candidate.nationality} />
          <Row label="เชื้อชาติ" value={candidate.race} />
          <Row label="ศาสนา" value={candidate.religion} />
          <Row label="สถานภาพ" value={candidate.marital_status ? MARITAL_LABEL[candidate.marital_status] ?? candidate.marital_status : null} />
          {candidate.gender === "male" && (
            <Row label="ภาวะทางทหาร" value={candidate.military_status ? MILITARY_LABEL[candidate.military_status] ?? candidate.military_status : null} />
          )}
          <Row label="ลักษณะที่อยู่" value={candidate.housing_type ? HOUSING_LABEL[candidate.housing_type] ?? candidate.housing_type : null} />
        </Grid2>
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-slate-500">เลขบัตรประชาชน:</span>
          {showId ? (
            <span className="text-sm font-mono">{nationalIdPlain ?? "—"}</span>
          ) : (
            <span className="text-sm font-mono text-slate-400">••••••••••••• 🔒</span>
          )}
          <button type="button" onClick={() => setShowId(!showId)}
            className="text-xs text-brand hover:underline ml-auto">
            {showId ? "ซ่อน" : "แสดง (audit)"}
          </button>
        </div>
      </Card>

      {/* Education */}
      <Card title="ประวัติการศึกษา">
        {education.length === 0 ? <Empty /> : (
          <div className="space-y-2">
            {education.map((row, i) => (
              <div key={i} className="border border-slate-200 rounded-lg p-2 bg-slate-50 text-sm">
                <div className="font-bold text-slate-800">
                  {row.level ? (EDUCATION_LABEL[row.level] ?? row.level) : "—"}
                </div>
                <div className="text-xs text-slate-600">
                  {row.institution || "—"}
                  {row.faculty && ` · ${row.faculty}`}
                  {row.major && ` · ${row.major}`}
                </div>
                <div className="text-[11px] text-slate-400">
                  {row.year_finished && `จบปี ${row.year_finished}`}
                  {row.gpa && ` · GPA ${row.gpa}`}
                </div>
              </div>
            ))}
          </div>
        )}
        {candidate.professional_license_status && (
          <Row label="ใบประกอบวิชาชีพ"
            value={LICENSE_LABEL[candidate.professional_license_status] ?? candidate.professional_license_status} />
        )}
      </Card>

      {/* Experience */}
      <Card title="ประสบการณ์การทำงาน">
        {experience.length === 0 ? <Empty /> : (
          <div className="space-y-2">
            {experience.map((row, i) => (
              <div key={i} className="border border-slate-200 rounded-lg p-2 bg-slate-50 text-sm">
                <div className="font-bold text-slate-800">
                  {row.position || "—"}
                  {row.company && <> · <span className="text-slate-600 font-normal">{row.company}</span></>}
                </div>
                <div className="text-xs text-slate-500">
                  {row.started || "?"} – {row.ended || "?"}
                  {row.salary && ` · ${row.salary}`}
                </div>
                {row.reason_left && (
                  <div className="text-[11px] text-slate-500 mt-0.5">เหตุผลที่ออก: {row.reason_left}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Skills */}
      <Card title="ทักษะ & ภาษา">
        {languages.length > 0 && (
          <div className="space-y-1 mb-3">
            <div className="text-xs font-bold text-slate-600">ภาษา</div>
            <div className="flex flex-wrap gap-1.5">
              {languages.map((l, i) => (
                <span key={i} className="text-xs bg-slate-100 text-slate-700 px-2 py-1 rounded">
                  {l.language || "—"}: <b>{
                    l.level ? (LANG_LEVEL_LABEL[l.level] ?? l.level) : "—"
                  }</b>
                </span>
              ))}
            </div>
          </div>
        )}
        {candidate.skills_other && (
          <Row label="ทักษะอื่นๆ" value={candidate.skills_other} />
        )}
      </Card>

      {/* References */}
      <Card title="บุคคลอ้างอิง & ฉุกเฉิน">
        <Grid2>
          <Row label="ผู้ติดต่อฉุกเฉิน" value={candidate.emergency_name} />
          <Row label="ความสัมพันธ์" value={candidate.emergency_relationship} />
          <Row label="เบอร์โทร" value={candidate.emergency_phone}
            link={candidate.emergency_phone ? `tel:${candidate.emergency_phone}` : null} />
        </Grid2>
        {candidate.referee_external_text && (
          <Row label="บุคคลอ้างอิง (ไม่ใช่ญาติ/นายจ้าง)" value={candidate.referee_external_text} />
        )}
      </Card>

      {/* Application-level */}
      <Card title="ความคาดหวัง & การสมัคร">
        <Grid2>
          <Row label="เงินเดือนที่คาดหวัง"
            value={application.expected_salary != null ? `฿${application.expected_salary.toLocaleString("th-TH")}` : null} />
          <Row label="พร้อมเริ่มงาน" value={application.earliest_start_date} />
          <Row label="ไปต่างจังหวัด"
            value={application.can_travel === 1 ? "ได้" : application.can_travel === 0 ? "ไม่ได้" : null} />
          <Row label="ทราบข่าวจาก" value={application.info_source ? infoSourceLabel(application.info_source) : null} />
        </Grid2>
        {application.why_join && <Row label="ทำไมอยากร่วมงาน" value={application.why_join} />}
        {application.goals && <Row label="เป้าหมาย" value={application.goals} />}
      </Card>

      {/* Health */}
      {(candidate.prior_illness != null || candidate.prior_application_at) && (
        <Card title="ประวัติสุขภาพ & การสมัครก่อนหน้า">
          <Grid2>
            <Row label="เคยป่วยหนัก/โรคติดต่อ"
              value={candidate.prior_illness === 1 ? "เคย" : candidate.prior_illness === 0 ? "ไม่เคย" : null} />
            {candidate.prior_illness === 1 && (
              <Row label="รายละเอียด" value={candidate.prior_illness_detail} />
            )}
            <Row label="เคยสมัครเมื่อ" value={candidate.prior_application_at} />
          </Grid2>
        </Card>
      )}

      {/* Documents */}
      <Card title="เอกสารแนบ">
        {/* Health-check result has its own section above — keep it out of
            the generic attachments list so it isn't mislabeled. */}
        {documents.filter((d) => d.kind !== "health_result" && d.kind !== "health_cert").length === 0 ? <Empty /> : (
          <div className="space-y-1.5">
            {documents.filter((d) => d.kind !== "health_result" && d.kind !== "health_cert").map((d) => (
              <a key={d.id} href={`/api/recruita/documents/${d.id}`}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm border border-slate-200 rounded-lg p-2 hover:bg-slate-50">
                <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                  {d.kind === "photo" ? "รูป" : d.kind === "resume" ? "CV" : "ID"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-slate-800 truncate">
                    {d.original_filename || "(ไม่มีชื่อ)"}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {d.kind} · {d.mime_type ?? "?"} · {d.size_bytes != null ? `${(d.size_bytes / 1024).toFixed(0)} KB` : "?"}
                  </div>
                </div>
                <span className="text-xs text-brand">เปิด ↗</span>
              </a>
            ))}
          </div>
        )}
      </Card>

      {/* Custom answers */}
      {customQuestions.length > 0 && (
        <Card title="คำตอบ — คำถามเฉพาะตำแหน่ง">
          <div className="space-y-3">
            {customQuestions.map((q) => {
              const ans = customAnswers[q.id];
              return (
                <div key={q.id}>
                  <div className="text-xs font-bold text-slate-600">{q.label}</div>
                  <div className="text-sm text-slate-800 mt-0.5">
                    {renderAnswer(q, ans)}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Hire dialog */}
      {showHire && (
        <HireDialog
          application={application}
          candidate={candidate}
          position={position}
          branches={branches}
          supervisors={supervisors}
          onClose={() => setShowHire(false)}
          onHired={(res) => {
            setHireResult(res);
            setStage("hired");
            setShowHire(false);
            startTransition(() => router.refresh());
          }}
        />
      )}

      {/* PDPA audit */}
      <Card title="PDPA Audit">
        <div className="text-xs space-y-1 text-slate-600">
          <div>
            ✓ ยินยอม PDPA เมื่อ:
            <span className="ml-1 font-mono">{application.consent_at ?? "—"}</span>
          </div>
          <div>
            ✓ รับรองความถูกต้อง:
            <span className="ml-1 font-bold text-emerald-700">
              {application.truth_declaration_accepted === 1 ? "ยอมรับ" : "—"}
            </span>
          </div>
          {application.consent_ip && (
            <div>
              IP ที่ส่งใบสมัคร:
              <span className="ml-1 font-mono">{application.consent_ip}</span>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function HealthCheckSection({
  applicationId, status, provider, at, note, resultDoc, certDoc
}: {
  applicationId: number;
  status: "pending" | "passed" | "failed" | null;
  provider: "self" | "at_home" | null;
  at: string | null;
  note: string | null;
  resultDoc: DocShape | null;
  /** Certificate the APPLICANT uploaded from their status page
   *  (kind='health_cert'), distinct from the admin's own resultDoc. */
  certDoc: DocShape | null;
}) {
  const router = useRouter();
  const [st, setSt] = useState<"pending" | "passed" | "failed">(status ?? "pending");
  const [prov, setProv] = useState<"self" | "at_home">(provider ?? "self");
  const [date, setDate] = useState(at ?? "");
  const [n, setN] = useState(note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const badge = status === "passed" ? { t: "ผ่าน", c: "bg-emerald-100 text-emerald-700" }
    : status === "failed" ? { t: "ไม่ผ่าน", c: "bg-rose-100 text-rose-700" }
    : status === "pending" ? { t: "รอผล", c: "bg-amber-100 text-amber-700" }
    : { t: "ยังไม่ได้บันทึก", c: "bg-slate-100 text-slate-500" };

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("status", st);
      fd.append("provider", prov);
      fd.append("checked_at", date);
      fd.append("note", n.trim());
      if (file) fd.append("result", file);
      const res = await fetch(apiUrl(`/api/recruita/applications/${applicationId}/health`), {
        method: "POST", body: fd
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "✓ บันทึกผลตรวจสุขภาพแล้ว" });
      setFile(null);
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 border-teal-200">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-bold text-slate-800 text-sm">ตรวจสุขภาพก่อนการจ้างงาน (Pre-employment)</h2>
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${badge.c}`}>{badge.t}</span>
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        หลังสัมภาษณ์ผ่าน ผู้สมัครต้องตรวจสุขภาพกับสถานพยาบาล (คลินิกหรือโรงพยาบาล)
        แล้วนำใบรับรองแพทย์มายื่น · บันทึกผลที่นี่ · ต้องเป็น &quot;ผ่าน&quot; จึงจะกดรับเข้าทำงานได้
      </p>
      <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 leading-relaxed">
        ใบรับรองแพทย์ 5 โรค (ตามที่กฎหมายกำหนด): (1) โรคเรื้อน · (2) วัณโรคในระยะอันตราย ·
        (3) โรคเท้าช้างในระยะที่ปรากฏอาการ · (4) โรคติดยาเสพติดให้โทษ · (5) โรคพิษสุราเรื้อรัง
      </div>
      {certDoc && (
        <a href={apiUrl(`/api/recruita/documents/${certDoc.id}`)} target="_blank" rel="noopener"
          className="block text-xs text-teal-700 underline">
          ใบรับรองแพทย์ที่ผู้สมัครอัพโหลด{certDoc.original_filename ? ` (${certDoc.original_filename})` : ""}
        </a>
      )}
      {resultDoc && (
        <a href={apiUrl(`/api/recruita/documents/${resultDoc.id}`)} target="_blank" rel="noopener"
          className="inline-block text-xs text-teal-700 underline">
          ไฟล์ผลตรวจที่บันทึกไว้{resultDoc.original_filename ? ` (${resultDoc.original_filename})` : ""}
        </a>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <label className="label">ผลตรวจ</label>
          <select className="input text-sm" value={st}
            onChange={(e) => setSt(e.target.value as "pending" | "passed" | "failed")}>
            <option value="pending">รอผล</option>
            <option value="passed">ผ่าน</option>
            <option value="failed">ไม่ผ่าน</option>
          </select>
        </div>
        <div>
          <label className="label">ตรวจที่</label>
          <select className="input text-sm" value={prov}
            onChange={(e) => setProv(e.target.value as "self" | "at_home")}>
            <option value="self">ใบรับรองจากภายนอก</option>
            <option value="at_home">ตรวจที่สถานพยาบาลในเครือ</option>
          </select>
        </div>
        <div>
          <label className="label">วันที่ตรวจ</label>
          <input type="date" className="input text-sm" value={date}
            onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div>
        <label className="label">หมายเหตุ (ทางเลือก)</label>
        <input className="input text-sm" value={n} maxLength={500}
          onChange={(e) => setN(e.target.value)}
          placeholder="เช่น ผลปกติทุกรายการ / รอผลเลือดเพิ่มเติม" />
      </div>
      <div>
        <label className="label">แนบไฟล์ผลตรวจ — PDF/รูป (ทางเลือก)</label>
        <input type="file" accept=".pdf,image/*" className="text-xs"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {file && <span className="ml-2 text-[11px] text-emerald-700">{file.name}</span>}
      </div>
      {msg && (
        <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>{msg.text}</p>
      )}
      <button type="button" onClick={save} disabled={busy}
        className="btn-primary w-full text-sm py-2.5 disabled:opacity-50">
        {busy ? "กำลังบันทึก…" : "บันทึกผลตรวจสุขภาพ"}
      </button>
    </div>
  );
}

function InterviewSection({
  applicationId, initialAt, initialLocation, initialNote
}: {
  applicationId: number;
  initialAt: string | null;
  initialLocation: string | null;
  initialNote: string | null;
}) {
  const router = useRouter();
  const [at, setAt] = useState(initialAt ?? "");
  const [location, setLocation] = useState(initialLocation ?? "");
  const [note, setNote] = useState(initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function save() {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(at)) {
      setMsg({ kind: "err", text: "กรุณาเลือกวันและเวลาสัมภาษณ์" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${applicationId}/interview`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interview_at: at, location: location.trim(), note: note.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: "✓ บันทึกแล้ว + แจ้งผู้สมัครทาง LINE (ถ้าเชื่อมต่อ LINE ไว้)" });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3">
      <div>
        <h2 className="font-bold text-slate-800 text-sm">นัดสัมภาษณ์</h2>
        <p className="text-[11px] text-slate-500 mt-0.5">
          เลือกวัน-เวลา แล้วระบบจะส่งแจ้งเตือนให้ผู้สมัครทาง LINE (ถ้าเชื่อมต่อ LINE ไว้)
        </p>
      </div>
      {initialAt && (
        <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
          นัดปัจจุบัน: {initialAt.replace("T", " ")} น.
          {initialLocation ? ` · ${initialLocation}` : ""}
        </p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div>
          <label className="label">วัน-เวลา</label>
          <input type="datetime-local" className="input text-sm"
            value={at} onChange={(e) => setAt(e.target.value)} />
        </div>
        <div>
          <label className="label">สถานที่ (ทางเลือก)</label>
          <input className="input text-sm" value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="เช่น สาขา NAMA / Google Meet" maxLength={300} />
        </div>
      </div>
      <div>
        <label className="label">หมายเหตุถึงผู้สมัคร (ทางเลือก)</label>
        <input className="input text-sm" value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="เช่น เตรียมเอกสาร / แต่งกายสุภาพ" maxLength={500} />
      </div>
      {msg && (
        <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.text}
        </p>
      )}
      <button type="button" onClick={save} disabled={busy}
        className="btn-primary w-full text-sm py-2.5 disabled:opacity-50">
        {busy ? "กำลังบันทึก…" : initialAt ? "อัปเดตนัดสัมภาษณ์ + แจ้งผู้สมัคร" : "บันทึกนัดสัมภาษณ์ + แจ้งผู้สมัคร"}
      </button>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card space-y-2">
      <h2 className="font-bold text-slate-800 text-sm border-b border-slate-100 pb-2">{title}</h2>
      {children}
    </div>
  );
}
function Grid2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5">{children}</div>;
}
function Row({ label, value, link }: {
  label: string; value: string | null | undefined; link?: string | null;
}) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-2 text-sm">
      <span className="text-[12px] font-semibold text-slate-500 flex-shrink-0">{label}:</span>
      {link ? (
        <a href={link} className="text-slate-800 hover:underline break-all">{value}</a>
      ) : (
        <span className="text-slate-800 break-all">{value}</span>
      )}
    </div>
  );
}
function Empty() {
  return <div className="text-xs text-slate-400 italic">ไม่มีข้อมูล</div>;
}

function renderAnswer(q: CustomQuestion, ans: unknown): React.ReactNode {
  if (ans == null) return <span className="text-slate-400 italic">ไม่ได้ตอบ</span>;
  if (q.type === "text" || q.type === "single") {
    if (q.type === "single") {
      const opt = q.config?.options?.find((o) => o.value === ans);
      return opt?.label ?? String(ans);
    }
    return String(ans);
  }
  if (q.type === "multi") {
    if (!Array.isArray(ans) || ans.length === 0) {
      return <span className="text-slate-400 italic">ไม่ได้ตอบ</span>;
    }
    return (
      <ul className="list-disc list-inside text-sm">
        {(ans as string[]).map((v, i) => {
          const opt = q.config?.options?.find((o) => o.value === v);
          return <li key={i}>{opt?.label ?? v}</li>;
        })}
      </ul>
    );
  }
  if (q.type === "rating") {
    const n = typeof ans === "number" ? ans : 0;
    const scale = q.config?.scale ?? 5;
    return <span className="font-bold">{n}/{scale} {q.config?.icon === "number" ? "" : "⭐".repeat(n)}</span>;
  }
  if (q.type === "grid") {
    if (typeof ans !== "object" || Array.isArray(ans)) return <Empty />;
    const obj = ans as Record<string, string>;
    return (
      <ul className="list-disc list-inside text-xs space-y-0.5">
        {(q.config?.rows ?? []).map((r) => {
          const colVal = obj[r.value];
          const col = q.config?.cols?.find((c) => c.value === colVal);
          if (!col) return null;
          return <li key={r.value}><b>{r.label}</b>: {col.label}</li>;
        })}
      </ul>
    );
  }
  return <span className="text-slate-400 italic">—</span>;
}

// ── Hire dialog — bridge to PERSONA ────────────────────────────────
function HireDialog({
  application, candidate, position, branches, supervisors, onClose, onHired
}: {
  application: AppShape;
  candidate: CandidateShape;
  position: PositionShape;
  branches: Branch[];
  supervisors: Supervisor[];
  onClose: () => void;
  onHired: (res: HireResult) => void;
}) {
  // Default branch — the one the position is pinned to, else first
  // branch in the list. Admin can override (PIN-gated, see `locked`).
  const defaultBranch = position.branch_id ?? branches[0]?.id ?? null;
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  // Offer terms captured at the 'offered' stage (owner 2026-06-15). The hire
  // must match what the candidate applied for (branch + position) and what
  // was offered (salary + start date + mode) BY DEFAULT — these fields are
  // locked, and changing them is a deliberate, PIN-gated override.
  const offerMode: "monthly" | "hourly" = application.offer_salary_type ?? "monthly";

  const [branchId, setBranchId] = useState<string>(
    defaultBranch != null ? String(defaultBranch) : ""
  );
  const [employmentType, setEmploymentType] = useState<"ft" | "pt">("ft");
  const [employmentStatus, setEmploymentStatus] = useState<"probation" | "permanent">("probation");
  const [hireMode, setHireMode] = useState<"monthly" | "daily" | "hourly">(offerMode);
  const [hireDate, setHireDate] = useState(
    application.offer_start_date && /^\d{4}-\d{2}-\d{2}$/.test(application.offer_start_date)
      ? application.offer_start_date
      : todayBkk
  );
  const [salary, setSalary] = useState(
    application.offer_salary != null && offerMode === "monthly"
      ? String(application.offer_salary) : ""
  );
  const [hourlyRate, setHourlyRate] = useState(
    application.offer_salary != null && offerMode === "hourly"
      ? String(application.offer_salary) : ""
  );
  const [jobTitle, setJobTitle] = useState(position.title);
  const [supervisorId, setSupervisorId] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The offer-matched fields (branch / position / salary / start date / mode)
  // start locked; unlocking needs the admin's PIN (intent gate, not a
  // security boundary — the hire route is already requireAdmin).
  const [locked, setLocked] = useState(true);
  const [pinOpen, setPinOpen] = useState(false);

  const candidateName = [
    candidate.title_prefix, candidate.first_name_th, candidate.last_name_th
  ].filter(Boolean).join(" ") || "—";

  async function confirm() {
    setErr(null);
    if (!branchId) { setErr("กรุณาเลือกสาขา"); return; }
    if (!hireDate) { setErr("กรุณาระบุวันที่เริ่มงาน"); return; }
    setBusy(true);
    try {
      const res = await fetch(`/api/recruita/applications/${application.id}/hire`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: Number(branchId),
          employment_type: employmentType,
          employment_status: employmentStatus,
          hire_mode: hireMode,
          hire_date: hireDate,
          monthly_salary: salary ? Number(salary) : null,
          hourly_rate: hourlyRate ? Number(hourlyRate) : null,
          job_title: jobTitle.trim() || undefined,
          supervisor_user_id: supervisorId ? Number(supervisorId) : null,
          employee_code: employeeCode.trim() || null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setErr(j.message ?? j.error ?? "รับเข้าทำงานไม่สำเร็จ");
        return;
      }
      onHired({
        user_id: Number(j.user_id),
        invite_id: Number(j.invite_id),
        url: String(j.url),
        liff_url: j.liff_url ?? null,
        direct_url: String(j.direct_url),
        expires_at: String(j.expires_at)
      });
    } finally { setBusy(false); }
  }

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">รับ {candidateName} เข้าทำงาน</h3>
        <p className="text-xs text-slate-500">
          ระบบจะสร้าง user ใน PERSONA + carry ข้อมูลจากใบสมัครครบทุก field
        </p>

        {/* Lock banner — the offer-matched fields are read-only until the
            admin unlocks with a PIN (owner 2026-06-15). */}
        <div className={`rounded-lg p-3 text-xs flex items-center justify-between gap-2 ${
          locked ? "bg-slate-50 border border-slate-200 text-slate-600"
                 : "bg-amber-50 border border-amber-200 text-amber-900"
        }`}>
          <span>
            {locked
              ? "🔒 สาขา / ตำแหน่ง / ค่าตอบแทน / วันเริ่มงาน ดึงจากใบสมัคร + ข้อเสนอ และถูกล็อกไว้"
              : "🔓 ปลดล็อกแล้ว — แก้ไขได้ (ค่าจะไม่ตรงกับข้อเสนอเดิม)"}
          </span>
          {locked && (
            <button type="button" onClick={() => setPinOpen(true)}
              className="shrink-0 px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-700 font-semibold hover:bg-slate-50">
              แก้ไข (PIN)
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">สาขา *</label>
            <select className="input" value={branchId} disabled={locked}
              onChange={(e) => setBranchId(e.target.value)}>
              <option value="">— เลือกสาขา —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">ตำแหน่งงาน</label>
            <input className="input" value={jobTitle} disabled={locked}
              onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div>
            <label className="label">รูปแบบงาน *</label>
            <select className="input" value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as "ft" | "pt")}>
              <option value="ft">พนักงานประจำ</option>
              <option value="pt">พนักงานพาร์ทไทม์</option>
            </select>
          </div>
          <div>
            <label className="label">สถานะการจ้าง</label>
            <select className="input" value={employmentStatus}
              onChange={(e) => setEmploymentStatus(e.target.value as "probation" | "permanent")}>
              <option value="probation">ทดลองงาน</option>
              <option value="permanent">ประจำ</option>
            </select>
          </div>
          <div>
            <label className="label">วิธีคิดค่าจ้าง</label>
            <select className="input" value={hireMode} disabled={locked}
              onChange={(e) => setHireMode(e.target.value as "monthly" | "daily" | "hourly")}>
              <option value="monthly">รายเดือน</option>
              <option value="daily">รายวัน</option>
              <option value="hourly">รายชั่วโมง</option>
            </select>
          </div>
          <div>
            <label className="label">วันเริ่มงาน *</label>
            <input className="input" type="date" value={hireDate} disabled={locked}
              onChange={(e) => setHireDate(e.target.value)} />
          </div>
          {hireMode === "monthly" && (
            <div className="sm:col-span-2">
              <label className="label">เงินเดือน (฿)</label>
              <input className="input" type="number" min="0" value={salary} disabled={locked}
                onChange={(e) => setSalary(e.target.value)} />
              {application.offer_salary != null && application.offer_salary_type === "monthly" ? (
                <p className="text-[10px] text-emerald-600 mt-0.5">
                  ✓ ตรงกับข้อเสนอ ฿{application.offer_salary.toLocaleString("th-TH")}/เดือน
                </p>
              ) : application.expected_salary != null && (
                <p className="text-[10px] text-slate-400 mt-0.5">
                  💡 ผู้สมัครตั้งความคาดหวังไว้ที่ ฿{application.expected_salary.toLocaleString("th-TH")}
                </p>
              )}
            </div>
          )}
          {(hireMode === "hourly" || hireMode === "daily") && (
            <div className="sm:col-span-2">
              <label className="label">
                {hireMode === "hourly" ? "ค่าจ้างต่อชั่วโมง (฿)" : "ค่าจ้างต่อวัน (฿)"}
              </label>
              <input className="input" type="number" min="0" value={hourlyRate} disabled={locked}
                onChange={(e) => setHourlyRate(e.target.value)} />
              {hireMode === "hourly" && application.offer_salary != null && application.offer_salary_type === "hourly" && (
                <p className="text-[10px] text-emerald-600 mt-0.5">
                  ✓ ตรงกับข้อเสนอ ฿{application.offer_salary.toLocaleString("th-TH")}/ชม.
                </p>
              )}
            </div>
          )}
          <div>
            <label className="label">รหัสพนักงาน (ถ้ามี)</label>
            <input className="input" value={employeeCode}
              onChange={(e) => setEmployeeCode(e.target.value)}
              placeholder="เช่น EMP-014" />
          </div>
          <div>
            <label className="label">หัวหน้างาน</label>
            <select className="input" value={supervisorId}
              onChange={(e) => setSupervisorId(e.target.value)}>
              <option value="">— ยังไม่กำหนด —</option>
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>{nameWithPrefix(s.title_prefix, s.display_name)}</option>
              ))}
            </select>
          </div>
        </div>

        {err && <div className="text-rose-600 text-sm">✗ {err}</div>}

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
          ⚠️ การกระทำนี้สร้าง user ใน PERSONA ทันที — หลังจากนี้ขั้นตอนการเลิกจ้าง
          จะต้องผ่านระบบ resignation ปกติ ตรวจสอบข้อมูลให้แน่ใจก่อนยืนยัน
        </div>

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700">
            ยกเลิก
          </button>
          <button type="button" onClick={confirm} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white font-bold disabled:opacity-50">
            {busy ? "กำลังสร้าง user…" : "✓ ยืนยันรับเข้าทำงาน"}
          </button>
        </div>
      </div>
    </div>
    {pinOpen && (
      <PinPromptModal
        title="ปลดล็อกแก้ไขข้อมูลการจ้าง"
        description={
          <>
            ข้อมูลสาขา / ตำแหน่ง / ค่าตอบแทน / วันเริ่มงาน ดึงจากใบสมัคร + ข้อเสนอ
            ที่ผู้สมัครตอบรับไว้ — ใส่ PIN ของคุณเพื่อปลดล็อกและแก้ไข
          </>
        }
        submitLabel="ปลดล็อก"
        onClose={() => setPinOpen(false)}
        onSubmit={async (pin) => {
          const res = await fetch(apiUrl("/api/auth/verify-pin"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pin })
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok) {
            return {
              ok: false,
              message: j.error === "no_pin"
                ? "คุณยังไม่ได้ตั้ง PIN — ตั้งที่หน้าโปรไฟล์ก่อน"
                : "PIN ไม่ถูกต้อง"
            };
          }
          setLocked(false);
          setPinOpen(false);
          return { ok: true };
        }} />
    )}
    </>
  );
}

// ── Invite link display (after successful hire) ───────────────────
function InviteLinkBox({ result }: { result: HireResult }) {
  const [copied, setCopied] = useState<"liff" | "direct" | null>(null);

  async function copy(text: string, kind: "liff" | "direct") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-2 mt-2">
      <p className="text-xs font-bold text-emerald-900">
        แชร์ลิงก์ด้านล่างให้พนักงานใหม่เพื่อตั้งรหัสผ่าน + เชื่อมต่อ LINE
      </p>
      <p className="text-[10px] text-slate-500">
        ถ้าผู้สมัครเชื่อมต่อ LINE ไว้แล้ว ระบบได้ส่งการ์ดต้อนรับ
        (ปุ่มเพิ่มเพื่อน IKIGAI OS PORTAL + ลิงก์ตั้งค่าบัญชี) ให้อัตโนมัติแล้ว —
        ลิงก์ด้านล่างไว้ใช้สำรองกรณีส่งเองด้วยมือ
      </p>
      <p className="text-[10px] text-slate-500">
        ลิงก์หมดอายุ {formatBkkDateTime(result.expires_at)}
      </p>
      {result.liff_url && (
        <div className="bg-white border border-slate-200 rounded p-2 text-xs space-y-1">
          <div className="font-bold text-slate-700">🔗 ลิงก์ LINE (แนะนำ — เชื่อมต่อ LINE อัตโนมัติ)</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-[10px] text-slate-600">{result.liff_url}</code>
            <button type="button" onClick={() => copy(result.liff_url!, "liff")}
              className="text-[10px] px-2 py-1 rounded bg-brand text-white font-bold">
              {copied === "liff" ? "✓ คัดลอกแล้ว" : "คัดลอก"}
            </button>
          </div>
        </div>
      )}
      <div className="bg-white border border-slate-200 rounded p-2 text-xs space-y-1">
        <div className="font-bold text-slate-700">🌐 ลิงก์เบราว์เซอร์ปกติ (สำรอง)</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate font-mono text-[10px] text-slate-600">{result.direct_url}</code>
          <button type="button" onClick={() => copy(result.direct_url, "direct")}
            className="text-[10px] px-2 py-1 rounded bg-slate-600 text-white font-bold">
            {copied === "direct" ? "✓ คัดลอกแล้ว" : "คัดลอก"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LINE userId link box ──────────────────────────────────────────
//
// Surfaces the candidate's currently-bound LINE userId and lets
// admin paste a new one (or clear it). Empty input = clear. The
// API validates the U-prefix shape + rejects duplicates across
// candidates so we can't accidentally redirect another person's
// stage-change pushes.
function LineLinkBox({
  applicationId, currentValue
}: {
  applicationId: number;
  currentValue: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(currentValue ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // Set when the API reports the userId is already on another candidate
  // (409 userid_in_use). Shows the "ย้ายมาเชื่อมต่อที่นี่" confirm button.
  const [conflict, setConflict] = useState(false);

  async function save(force = false) {
    setBusy(true);
    setMsg(null);
    if (!force) setConflict(false);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${applicationId}/link-line`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_user_id: input.trim(), force })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        if (j.error === "userid_in_use") setConflict(true);
        setMsg({ kind: "err", text: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      setConflict(false);
      setMsg({
        kind: "ok",
        text: j.moved_from
          ? `✓ ย้าย LINE มาเชื่อมต่อที่ใบสมัครนี้แล้ว (ถอดจาก candidate #${j.moved_from})`
          : input.trim() ? "✓ เชื่อมต่อ LINE เรียบร้อย" : "✓ ยกเลิกการเชื่อมต่อแล้ว"
      });
      setEditing(false);
      router.refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="card space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-slate-800 text-sm">LINE userId</h3>
          <p className="text-[11px] text-slate-500">
            ใช้ส่งแจ้งเตือนเปลี่ยนสถานะ + ให้ผู้สมัครเห็นใบสมัครในหน้า เช็คสถานะ
          </p>
        </div>
        {!editing && (
          <button type="button" onClick={() => { setEditing(true); setInput(currentValue ?? ""); }}
            className="text-xs px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-50 font-semibold">
            {currentValue ? "แก้ไข / ยกเลิก" : "เชื่อมต่อ LINE"}
          </button>
        )}
      </div>
      {!editing && (
        <div className="text-xs">
          {currentValue ? (
            <code className="font-mono bg-slate-100 px-2 py-1 rounded text-slate-700 break-all">
              {currentValue}
            </code>
          ) : (
            <span className="text-slate-400 italic">
              ยังไม่ได้เชื่อมต่อ — ผู้สมัคร copy userId ของตัวเองจากหน้า /recruita/status แล้วส่งให้แอดมิน
              paste ที่นี่
            </span>
          )}
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <input
            type="text"
            className="input font-mono text-xs"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            maxLength={80} />
          <p className="text-[10px] text-slate-400">
            ขึ้นต้นด้วย U ตามด้วย 32 ตัวอักษร hex. ปล่อยว่าง = ยกเลิกการเชื่อมต่อ
          </p>
          {msg && (
            <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.text}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => { setEditing(false); setConflict(false); }} disabled={busy}
              className="flex-1 py-2 rounded border border-slate-300 text-sm font-medium hover:bg-slate-50">
              ยกเลิก
            </button>
            <button type="button" onClick={() => save(false)} disabled={busy}
              className="flex-1 py-2 rounded bg-brand text-white text-sm font-bold disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
          {/* Shown when the userId is already on another candidate — one
              click moves it here (clears the other binding). */}
          {conflict && (
            <button type="button" onClick={() => save(true)} disabled={busy}
              className="w-full py-2 rounded bg-amber-600 text-white text-sm font-bold disabled:opacity-50">
              ย้ายมาเชื่อมต่อที่นี่ (ยืนยันว่าเป็นบุคคลเดียวกัน)
            </button>
          )}
        </div>
      )}
      {!editing && msg && (
        <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ── Cancel prompt — no PIN, just an optional reason ───────────────
function CancelPromptModal({
  onConfirm, onClose
}: {
  onConfirm: (reason: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const res = await onConfirm(reason.trim());
      if (!res.ok) setErr(res.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-bold text-slate-800">ยกเลิกคำขอเปลี่ยน stage</h3>
          <p className="text-xs text-slate-600 mt-1">
            สามารถสร้างคำขอใหม่ได้ทีหลัง — เหตุผลจะถูกเก็บใน audit log
          </p>
        </div>
        <div>
          <label className="label">เหตุผล (ไม่บังคับ)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            className="input text-sm"
            placeholder="เช่น ขอข้อมูลเพิ่มเติมก่อนตัดสินใจ" />
        </div>
        {err && <p className="text-rose-600 text-xs">✗ {err}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            ปิด
          </button>
          <button type="button" onClick={submit} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold disabled:opacity-50">
            {busy ? "กำลังยกเลิก…" : "ยกเลิกคำขอ"}
          </button>
        </div>
      </div>
    </div>
  );
}
