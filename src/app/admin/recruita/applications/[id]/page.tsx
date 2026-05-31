import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { decryptSecret } from "@/lib/secret-vault";
import {
  STAGE_META, parseCustomQuestions, parseCustomAnswers,
  type ApplicationStage
} from "@/lib/recruita";
import ApplicationDetailClient from "./ApplicationDetailClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · ใบสมัคร" };

type AppRow = {
  id: number;
  candidate_id: number;
  position_id: number;
  stage: ApplicationStage;
  expected_salary: number | null;
  earliest_start_date: string | null;
  why_join: string | null;
  custom_answers: string;
  consent_at: string | null;
  consent_ip: string | null;
  info_source: string | null;
  can_travel: number | null;
  goals: string | null;
  truth_declaration_accepted: number | null;
  last_workplace: string | null;
  last_position: string | null;
  last_tenure: string | null;
  last_salary: string | null;
  last_reason_left: string | null;
  hired_user_id: number | null;
  hired_at: string | null;
  submitted_at: string;
};

type CandidateRow = {
  id: number;
  title_prefix: string | null;
  first_name_th: string | null; last_name_th: string | null;
  first_name_en: string | null; last_name_en: string | null;
  nickname_th: string | null;
  dob: string | null;
  gender: string | null;
  nationality: string | null;
  race: string | null;
  marital_status: string | null;
  military_status: string | null;
  religion: string | null;
  national_id_encrypted: string | null;
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
  education_json: string;
  experience_json: string;
  skills_language_json: string;
  skills_other: string | null;
};

type DocRow = {
  id: number;
  kind: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string;
};

type PositionRow = {
  id: number; title: string; code: string | null;
  branch_name: string | null; department: string | null;
  custom_questions: string;
};

export default function ApplicationDetailPage(
  { params }: { params: { id: string } }
) {
  requireSuperAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const app = db.prepare(
    "SELECT * FROM recruita_applications WHERE id = ?"
  ).get(id) as AppRow | undefined;
  if (!app) notFound();
  const candidate = db.prepare(
    "SELECT * FROM recruita_candidates WHERE id = ?"
  ).get(app.candidate_id) as CandidateRow | undefined;
  if (!candidate) notFound();
  const position = db.prepare(`
    SELECT p.id, p.title, p.code, p.department, p.custom_questions,
           b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(app.position_id) as PositionRow | undefined;
  if (!position) notFound();
  const docs = db.prepare(
    "SELECT id, kind, original_filename, mime_type, size_bytes, uploaded_at FROM recruita_documents WHERE candidate_id = ? ORDER BY uploaded_at"
  ).all(candidate.id) as DocRow[];

  const customQuestions = parseCustomQuestions(position.custom_questions);
  const customAnswers = parseCustomAnswers(app.custom_answers);

  // Decrypt national_id for the admin view (still encrypted on disk)
  const nationalIdPlain = decryptSecret(candidate.national_id_encrypted);

  // Parse JSON arrays for rendering
  const education = (() => {
    try { return JSON.parse(candidate.education_json) as Array<Record<string, string>>; }
    catch { return []; }
  })();
  const experience = (() => {
    try { return JSON.parse(candidate.experience_json) as Array<Record<string, string>>; }
    catch { return []; }
  })();
  const languages = (() => {
    try { return JSON.parse(candidate.skills_language_json) as Array<Record<string, string>>; }
    catch { return []; }
  })();

  return (
    <div className="space-y-4">
      <Link href="/admin/recruita/applications"
        className="text-xs text-brand hover:underline">
        ← กลับลิสต์ใบสมัคร
      </Link>
      <ApplicationDetailClient
        application={app}
        candidate={candidate}
        nationalIdPlain={nationalIdPlain}
        position={position}
        documents={docs}
        education={education}
        experience={experience}
        languages={languages}
        customQuestions={customQuestions}
        customAnswers={customAnswers}
        stageMeta={STAGE_META}
      />
    </div>
  );
}
