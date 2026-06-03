import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin, getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { decryptSecret } from "@/lib/secret-vault";
import { getActivePendingRequest, type StageRequestRow } from "@/lib/recruita-stage-request";
import { hasAdminPin } from "@/lib/admin-pin";
import {
  STAGE_META, parseCustomQuestions, parseCustomAnswers,
  type ApplicationStage
} from "@/lib/recruita";
import { formatApplicationNo } from "@/lib/time";
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
  interview_at: string | null;
  interview_location: string | null;
  interview_note: string | null;
  hired_user_id: number | null;
  hired_at: string | null;
  submitted_at: string;
};

type CandidateRow = {
  id: number;
  /** LINE userId — set when LIFF captured during apply OR admin
   *  pasted in the manual link box. Drives stage-change push routing. */
  line_user_id: string | null;
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
  branch_id: number | null;
  branch_name: string | null; department: string | null;
  custom_questions: string;
};

export default function ApplicationDetailPage(
  { params }: { params: { id: string } }
) {
  requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const db = getDb();
  const app = db.prepare(
    "SELECT * FROM recruita_applications WHERE id = ?"
  ).get(id) as AppRow | undefined;
  if (!app) notFound();
  // Per-Thai-day sequence → #YYYYMMDD00x application number.
  const daySeq = (db.prepare(`
    SELECT COUNT(*) AS n FROM recruita_applications za
    WHERE date(za.submitted_at, '+7 hours') = date(?, '+7 hours')
      AND za.id <= ?
  `).get(app.submitted_at, app.id) as { n: number }).n;
  const applicationNo = formatApplicationNo(app.submitted_at, daySeq);
  const candidate = db.prepare(
    "SELECT * FROM recruita_candidates WHERE id = ?"
  ).get(app.candidate_id) as CandidateRow | undefined;
  if (!candidate) notFound();
  const position = db.prepare(`
    SELECT p.id, p.title, p.code, p.department, p.branch_id, p.custom_questions,
           b.name AS branch_name
    FROM recruita_positions p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(app.position_id) as PositionRow | undefined;
  if (!position) notFound();
  const docs = db.prepare(
    "SELECT id, kind, original_filename, mime_type, size_bytes, uploaded_at FROM recruita_documents WHERE candidate_id = ? ORDER BY uploaded_at"
  ).all(candidate.id) as DocRow[];

  // Bridge → PERSONA needs: branches list (for override + reassign)
  // and supervisor candidates (active employees who can manage staff).
  const branches = db.prepare(
    "SELECT id, name FROM branches ORDER BY name"
  ).all() as Pick<Branch, "id" | "name">[];
  const supervisors = db.prepare(`
    SELECT id, display_name
    FROM users
    WHERE status NOT IN ('disabled', 'resigned')
      AND role IN ('admin', 'super_admin', 'staff')
    ORDER BY display_name
  `).all() as Array<{ id: number; display_name: string }>;

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

  // Pending stage-change request (if any) + the viewer's PIN status.
  // The client uses these to render the "ขออนุมัติเปลี่ยน stage" vs
  // "อนุมัติ" vs "ตั้ง PIN ก่อน" branches without a second round-trip.
  const sessionUser = getSessionUser();
  const pendingRequest = getActivePendingRequest(id);
  const viewerHasPin = sessionUser ? hasAdminPin(sessionUser.id) : false;
  const viewerUserId = sessionUser?.id ?? 0;

  return (
    <div className="space-y-4">
      <Link href="/admin/recruita/applications"
        className="text-xs text-brand hover:underline">
        ← กลับลิสต์ใบสมัคร
      </Link>
      <ApplicationDetailClient
        application={app}
        applicationNo={applicationNo}
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
        branches={branches}
        supervisors={supervisors}
        pendingStageRequest={pendingRequest}
        viewerHasPin={viewerHasPin}
        viewerUserId={viewerUserId}
      />
    </div>
  );
}
