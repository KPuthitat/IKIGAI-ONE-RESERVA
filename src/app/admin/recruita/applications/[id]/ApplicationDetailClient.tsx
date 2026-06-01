"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type {
  ApplicationStage, CustomQuestion, CustomAnswers
} from "@/lib/recruita";

type StageMeta = Record<ApplicationStage, { label: string; chip: string }>;

type AppShape = {
  id: number; candidate_id: number; position_id: number;
  stage: ApplicationStage; submitted_at: string;
  expected_salary: number | null; earliest_start_date: string | null;
  why_join: string | null; goals: string | null;
  info_source: string | null; can_travel: number | null;
  truth_declaration_accepted: number | null;
  consent_at: string | null; consent_ip: string | null;
  last_workplace: string | null; last_position: string | null;
  last_tenure: string | null; last_salary: string | null;
  last_reason_left: string | null;
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
type Supervisor = { id: number; display_name: string };

type HireResult = {
  user_id: number;
  invite_id: number;
  url: string;
  liff_url: string | null;
  direct_url: string;
  expires_at: string;
};

const ALL_STAGES: ApplicationStage[] = [
  "applied", "screening", "interview", "offered",
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
  ft: "เต็มเวลา",
  pt: "นอกเวลา (PT)",
  contract: "สัญญาจ้าง"
};

export default function ApplicationDetailClient({
  application, candidate, nationalIdPlain, position, documents,
  education, experience, languages,
  customQuestions, customAnswers, stageMeta,
  branches, supervisors
}: {
  application: AppShape;
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
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [showId, setShowId] = useState(false);
  const [stage, setStage] = useState<ApplicationStage>(application.stage);
  const [showHire, setShowHire] = useState(false);
  const [hireResult, setHireResult] = useState<HireResult | null>(null);

  const name = [candidate.title_prefix, candidate.first_name_th, candidate.last_name_th]
    .filter(Boolean).join(" ") || "—";
  const nameEn = [candidate.first_name_en, candidate.last_name_en]
    .filter(Boolean).join(" ");

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
          <span className="text-xs text-slate-400 font-mono">#{application.id}</span>
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
          ส่งใบสมัคร {application.submitted_at.slice(0, 16).replace("T", " ")}
        </p>
      </div>

      {/* Stage controls */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">เปลี่ยนสถานะ</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
          {ALL_STAGES.map((s) => {
            const m = stageMeta[s];
            const active = s === stage;
            return (
              <button key={s} type="button"
                onClick={() => setStageOnServer(s)}
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

      {/* Hire bridge — appears only when not yet hired. Stage doesn't
          have to be 'accepted' to enable; admin may want to fast-track
          (e.g. interview → hire directly). */}
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
            <li>ส่ง invite link ให้แชร์กับพนักงานใหม่ตั้งรหัสผ่าน + ผูก LINE</li>
          </ul>
          <button type="button" onClick={() => setShowHire(true)}
            disabled={busy}
            className="btn-primary w-full text-base py-3 mt-2">
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
          <Row label="ทราบข่าวจาก" value={application.info_source} />
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
        {documents.length === 0 ? <Empty /> : (
          <div className="space-y-1.5">
            {documents.map((d) => (
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
  // branch in the list. Admin can override.
  const defaultBranch = position.branch_id ?? branches[0]?.id ?? null;
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const [branchId, setBranchId] = useState<string>(
    defaultBranch != null ? String(defaultBranch) : ""
  );
  const [employmentType, setEmploymentType] = useState<"ft" | "pt">("ft");
  const [employmentStatus, setEmploymentStatus] = useState<"probation" | "permanent">("probation");
  const [hireMode, setHireMode] = useState<"monthly" | "daily" | "hourly">("monthly");
  const [hireDate, setHireDate] = useState(todayBkk);
  const [salary, setSalary] = useState(
    application.expected_salary != null ? String(application.expected_salary) : ""
  );
  const [hourlyRate, setHourlyRate] = useState("");
  const [jobTitle, setJobTitle] = useState(position.title);
  const [supervisorId, setSupervisorId] = useState<string>("");
  const [employeeCode, setEmployeeCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        setErr(j.error ?? "รับเข้าทำงานไม่สำเร็จ");
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold text-slate-800 text-lg">รับ {candidateName} เข้าทำงาน</h3>
        <p className="text-xs text-slate-500">
          ระบบจะสร้าง user ใน PERSONA + carry ข้อมูลจากใบสมัครครบทุก field
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">สาขา *</label>
            <select className="input" value={branchId}
              onChange={(e) => setBranchId(e.target.value)}>
              <option value="">— เลือกสาขา —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">ตำแหน่งงาน</label>
            <input className="input" value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)} />
          </div>
          <div>
            <label className="label">รูปแบบงาน *</label>
            <select className="input" value={employmentType}
              onChange={(e) => setEmploymentType(e.target.value as "ft" | "pt")}>
              <option value="ft">เต็มเวลา</option>
              <option value="pt">นอกเวลา (PT)</option>
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
            <select className="input" value={hireMode}
              onChange={(e) => setHireMode(e.target.value as "monthly" | "daily" | "hourly")}>
              <option value="monthly">รายเดือน</option>
              <option value="daily">รายวัน</option>
              <option value="hourly">รายชั่วโมง</option>
            </select>
          </div>
          <div>
            <label className="label">วันเริ่มงาน *</label>
            <input className="input" type="date" value={hireDate}
              onChange={(e) => setHireDate(e.target.value)} />
          </div>
          {hireMode === "monthly" && (
            <div className="sm:col-span-2">
              <label className="label">เงินเดือน (฿)</label>
              <input className="input" type="number" min="0" value={salary}
                onChange={(e) => setSalary(e.target.value)} />
              {application.expected_salary != null && (
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
              <input className="input" type="number" min="0" value={hourlyRate}
                onChange={(e) => setHourlyRate(e.target.value)} />
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
                <option key={s.id} value={s.id}>{s.display_name}</option>
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
        📨 แชร์ลิงก์ด้านล่างให้พนักงานใหม่เพื่อตั้งรหัสผ่าน + ผูก LINE
      </p>
      <p className="text-[10px] text-slate-500">
        ลิงก์หมดอายุ {new Date(result.expires_at).toLocaleString("th-TH")}
      </p>
      {result.liff_url && (
        <div className="bg-white border border-slate-200 rounded p-2 text-xs space-y-1">
          <div className="font-bold text-slate-700">🔗 ลิงก์ LINE (แนะนำ — ผูก LINE อัตโนมัติ)</div>
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

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/recruita/applications/${applicationId}/link-line`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_user_id: input.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.message ?? j.error ?? "บันทึกไม่สำเร็จ" });
        return;
      }
      setMsg({ kind: "ok", text: input.trim() ? "✓ ผูก LINE เรียบร้อย" : "✓ ยกเลิกการผูกแล้ว" });
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
            {currentValue ? "แก้ไข / ยกเลิก" : "ผูก LINE"}
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
              ยังไม่ได้ผูก — ผู้สมัคร copy userId ของตัวเองจากหน้า /recruita/status แล้วส่งให้แอดมิน
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
            ขึ้นต้นด้วย U ตามด้วย 32 ตัวอักษร hex. ปล่อยว่าง = ยกเลิกการผูก
          </p>
          {msg && (
            <p className={`text-xs ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
              {msg.text}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(false)} disabled={busy}
              className="flex-1 py-2 rounded border border-slate-300 text-sm font-medium hover:bg-slate-50">
              ยกเลิก
            </button>
            <button type="button" onClick={save} disabled={busy}
              className="flex-1 py-2 rounded bg-brand text-white text-sm font-bold disabled:opacity-50">
              {busy ? "กำลังบันทึก…" : "บันทึก"}
            </button>
          </div>
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
