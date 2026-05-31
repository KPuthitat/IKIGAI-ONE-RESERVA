"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type {
  ApplicationStage, CustomQuestion, CustomAnswers
} from "@/lib/recruita";

type StageMeta = Record<ApplicationStage, { label: string; chip: string }>;

type AppShape = {
  id: number; stage: ApplicationStage; submitted_at: string;
  expected_salary: number | null; earliest_start_date: string | null;
  why_join: string | null; goals: string | null;
  info_source: string | null; can_travel: number | null;
  truth_declaration_accepted: number | null;
  consent_at: string | null; consent_ip: string | null;
  last_workplace: string | null; last_position: string | null;
  last_tenure: string | null; last_salary: string | null;
  last_reason_left: string | null;
};

type CandidateShape = {
  id: number;
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
  branch_name: string | null; department: string | null;
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

export default function ApplicationDetailClient({
  application, candidate, nationalIdPlain, position, documents,
  education, experience, languages,
  customQuestions, customAnswers, stageMeta
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
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [showId, setShowId] = useState(false);
  const [stage, setStage] = useState<ApplicationStage>(application.stage);

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
          📋 {position.code ? `[${position.code}] ` : ""}{position.title}
          {position.branch_name && <> · 📍 {position.branch_name}</>}
          {position.department && <> · 🏷 {position.department}</>}
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

      {/* Quick contact */}
      <div className="card grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <Row label="📞 มือถือ" value={candidate.mobile_phone}
          link={candidate.mobile_phone ? `tel:${candidate.mobile_phone}` : null} />
        <Row label="✉ อีเมล" value={candidate.personal_email}
          link={candidate.personal_email ? `mailto:${candidate.personal_email}` : null} />
        <Row label="LINE ID" value={candidate.line_id} />
        <Row label="📍 ที่อยู่" value={candidate.house_address} />
      </div>

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
                <div className="font-bold text-slate-800">{row.level || "—"}</div>
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
                  {l.language || "—"}: <b>{l.level || "—"}</b>
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
                <span>{d.kind === "photo" ? "📸" : d.kind === "resume" ? "📄" : "🪪"}</span>
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
