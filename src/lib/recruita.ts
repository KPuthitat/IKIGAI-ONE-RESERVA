// RECRUITA — recruitment module shared types + helpers.
//
// Module shape: applicants come through a standalone LINE OA ("IKIGAI
// RECRUIT") + a public web form fallback. Once admin clicks "รับเข้า
// ทำงาน", a bridge transaction creates the PERSONA users row + carries
// every personal/contact field so the new employee never re-enters
// data. See db.ts for the table layout.

import { createHash, randomBytes } from "crypto";

/** Stable random id for a CustomQuestion row. Client + server both
 *  use it; the value is opaque (we don't lookup or reference it
 *  outside its parent JSON blob). 16 hex chars = 64 bits — plenty
 *  for the few questions per position scale we operate at. */
export function genQuestionId(): string {
  return randomBytes(8).toString("hex");
}

// ── Custom-question schema ──────────────────────────────────────
// Admin defines per-position questions. Four supported types:
//   text   — short or multiline free text
//   single — radio / dropdown (one answer)
//   multi  — checkbox group (multiple answers)
//   rating — numeric scale (1..N stars or numbers)
//
// The shape is intentionally flat + JSON-serialisable so it stores
// cleanly in recruita_positions.custom_questions and survives
// admin edits without migration churn.

export type CustomQuestionType =
  | "text"    // free text
  | "single"  // radio / dropdown
  | "multi"   // checkbox group; supports "Other: ___" via config.allow_other
  | "rating"  // 1..N stars/numbers
  | "grid";   // rows × cols matrix (e.g. language ability × proficiency)

export type CustomQuestion = {
  /** Stable id (uuid-like) used as the key in custom_answers. Never
   *  reuse an id after deletion — the admin editor mints a fresh
   *  one each time a row is added, so old answers stay anchored. */
  id: string;
  order: number;
  required: boolean;
  type: CustomQuestionType;
  label: string;
  /** Optional helper text below the label. */
  hint?: string;
  config?: {
    // text:
    multiline?: boolean;
    max_length?: number;
    // single / multi:
    options?: Array<{ value: string; label: string }>;
    /** multi only — render an "Other: ___" row that captures free
     *  text alongside the boxes. Matches Google Forms semantics. */
    allow_other?: boolean;
    // rating:
    scale?: number;       // default 5
    icon?: "star" | "number";
    // grid (matrix):
    rows?: Array<{ value: string; label: string }>;
    cols?: Array<{ value: string; label: string }>;
  };
};

/** What lands in recruita_applications.custom_answers — keyed by
 *  question.id so admin reorders/edits don't break old applications. */
export type CustomAnswer =
  | { type: "text"; value: string }
  | { type: "single"; value: string }
  | { type: "multi"; value: string[]; other?: string | null }
  | { type: "rating"; value: number }
  | { type: "grid"; value: Record<string, string> };  // { rowValue: colValue }

export type CustomAnswers = Record<string, CustomAnswer>;

/** Parse + validate the JSON we read out of positions.custom_questions.
 *  Malformed rows (legacy seeds, manual SQL edits) fall through to an
 *  empty list so the form still renders. */
export function parseCustomQuestions(json: string | null | undefined): CustomQuestion[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((q): q is CustomQuestion =>
        q && typeof q === "object"
        && typeof q.id === "string"
        && typeof q.type === "string"
        && ["text", "single", "multi", "rating", "grid"].includes(q.type)
        && typeof q.label === "string")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  } catch {
    return [];
  }
}

export function parseCustomAnswers(json: string | null | undefined): CustomAnswers {
  if (!json) return {};
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    return obj as CustomAnswers;
  } catch {
    return {};
  }
}

// ── Lifecycle stages ────────────────────────────────────────────
// Phase 0 only writes 'applied'. The rest land in phase 1 (kanban
// + screening + interview) and phase 2 (offer + bridge). Kept on
// the enum now so client filters can compile against the final
// shape from day one.

export type ApplicationStage =
  | "applied"      // submitted form
  | "screening"    // admin reviewing qualifications
  | "interview"    // interview scheduled / done
  | "offered"      // offer letter sent
  | "accepted"     // candidate said yes
  | "hired"        // bridged into PERSONA, user created
  | "rejected"     // not moving forward
  | "withdrawn";   // candidate pulled out

// ── Info source (where did you hear about us) ───────────────────
// Stable value keys (English) + Thai labels. Stored as the KEY in
// recruita_applications.info_source so the dashboard rolls up
// cleanly ("facebook" + "เฟสบุ๊ค" no longer split the count). The
// apply form renders these as a dropdown; legacy free-text rows from
// before the dropdown still display via infoSourceLabel()'s fallback.

export const INFO_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "line",      label: "LINE / LINE OA" },
  { value: "facebook",  label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "tiktok",    label: "TikTok" },
  { value: "jobboard",  label: "เว็บหางาน (JobThai ฯลฯ)" },
  { value: "referral",  label: "เพื่อน / คนรู้จักแนะนำ" },
  { value: "poster",    label: "ป้าย / โปสเตอร์หน้าร้าน" },
  { value: "walk_in",   label: "เดินเข้ามาสอบถามเอง" },
  { value: "other",     label: "อื่นๆ" }
];

const INFO_SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  INFO_SOURCE_OPTIONS.map((o) => [o.value, o.label])
);

/** Human label for an info_source value. Falls back to the raw value
 *  (covers legacy free-text rows) and "ไม่ระบุ" for empty. */
export function infoSourceLabel(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  if (!v) return "ไม่ระบุ";
  return INFO_SOURCE_LABELS[v] ?? v;
}

// ── Default PDPA notice (recruitment) ───────────────────────────
// Rendered inline in the apply form's consent section when the admin
// hasn't authored their own text in /admin/system-settings. Editable
// there → stored in system_settings.recruita_pdpa_text. Newlines are
// preserved on render (whitespace-pre-line).

export const DEFAULT_RECRUITA_PDPA_TEXT = `บริษัทในเครือ IKIGAI ONE เก็บรวบรวมข้อมูลส่วนบุคคลในใบสมัครนี้ (เช่น ชื่อ-นามสกุล เลขบัตรประชาชน ข้อมูลติดต่อ ประวัติการศึกษาและการทำงาน) เพื่อใช้พิจารณารับสมัครงานเท่านั้น

• ข้อมูลถูกเก็บเป็นความลับตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 (PDPA)
• เลขบัตรประชาชนถูกเข้ารหัสในระบบ
• หากไม่ได้รับการพิจารณา ข้อมูลจะถูกลบภายใน 30 วัน
• ท่านมีสิทธิ์ขอเข้าถึง แก้ไข หรือลบข้อมูลของท่านได้ทุกเมื่อ
• เราจะไม่เปิดเผยข้อมูลของท่านแก่บุคคลภายนอกเพื่อการตลาด`;

export const STAGE_META: Record<ApplicationStage, { label: string; chip: string }> = {
  applied:   { label: "ใหม่",         chip: "bg-slate-100 text-slate-700" },
  screening: { label: "คัดกรอง",      chip: "bg-sky-100 text-sky-700" },
  interview: { label: "สัมภาษณ์",     chip: "bg-amber-100 text-amber-700" },
  offered:   { label: "เสนองาน",      chip: "bg-violet-100 text-violet-700" },
  accepted:  { label: "ตอบรับ",       chip: "bg-emerald-100 text-emerald-700" },
  hired:     { label: "รับเข้าทำงาน",  chip: "bg-emerald-200 text-emerald-900 font-bold" },
  rejected:  { label: "ไม่ผ่าน",       chip: "bg-rose-100 text-rose-700" },
  withdrawn: { label: "ถอนตัว",       chip: "bg-slate-200 text-slate-600 line-through" }
};

// ── Candidate dedupe ────────────────────────────────────────────
// Same person applying to multiple roles → one candidates row, two
// applications rows. Key: sha256(national_id) when known, else
// sha256(lower(email) + normalised_phone). Hashed so even a SQL leak
// doesn't reveal the PII directly.

const HASH_NS = "recruita-dedupe-v1";

function sha256Hex(input: string): string {
  return createHash("sha256").update(HASH_NS + ":" + input).digest("hex");
}

/** Best-effort phone normalisation for dedupe — strip everything
 *  except digits, keep last 9 (TH mobiles ignoring leading 0). */
function normalisePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-9);
}

export function buildDedupeHash(
  national_id: string | null | undefined,
  email: string | null | undefined,
  phone: string | null | undefined
): string | null {
  const nid = (national_id ?? "").replace(/\D/g, "");
  if (nid.length >= 10) return sha256Hex("nid:" + nid);
  const e = (email ?? "").trim().toLowerCase();
  const p = phone ? normalisePhone(phone) : "";
  if (e && p) return sha256Hex("ep:" + e + "|" + p);
  return null; // no reliable key — treat as new candidate
}

// ── Position / form types (DB row shape) ────────────────────────

export type RecruitaPosition = {
  id: number;
  branch_id: number | null;
  code: string | null;
  title: string;
  department: string | null;
  employment_type: "ft" | "pt" | "contract" | null;
  jd_summary: string | null;
  jd_full: string | null;
  requirements: string | null;
  benefits: string | null;
  salary_min: number | null;
  salary_max: number | null;
  vacancies: number;
  custom_questions: string;   // JSON, parse with parseCustomQuestions
  status: "open" | "closed" | "draft";
  opened_at: string;
  closed_at: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string | null;
};

export type RecruitaCandidate = {
  id: number;
  dedupe_hash: string | null;
  line_user_id: string | null;
  title_prefix: string | null;
  first_name_th: string | null;
  last_name_th: string | null;
  first_name_en: string | null;
  last_name_en: string | null;
  nickname_th: string | null;
  nickname_en: string | null;
  dob: string | null;
  gender: "male" | "female" | null;
  nationality: string | null;
  /** เชื้อชาติ — distinct from nationality (สัญชาติ). Both kept
   *  because the existing recruitment form (and Thai HR docs) ask
   *  them separately. */
  race: string | null;
  marital_status: string | null;
  military_status: string | null;
  religion: string | null;
  national_id_encrypted: string | null;
  /** 'family' | 'own_home' | 'rental' | 'dormitory' | 'other' */
  housing_type: string | null;
  /** 'has_license' | 'no_license' | 'not_applicable' — for the
   *  medical roster (nurse / med-tech / public health). Other
   *  positions ignore this. */
  professional_license_status: string | null;
  /** "เคยป่วยหนัก/โรคติดต่อร้ายแรงมาก่อนหรือไม่" + detail */
  prior_illness: number | null;        // 0/1
  prior_illness_detail: string | null;
  /** "ถ้าเคยสมัครกับบริษัทมาก่อน เคยสมัครเมื่อไหร่" — free text;
   *  applicant may write "2566", "ปี 2024", "ปลายปีที่แล้ว", etc. */
  prior_application_at: string | null;
  /** Free text describing the 1 non-relative, non-prior-employer
   *  reference (name + phone + occupation in one block). */
  referee_external_text: string | null;
  personal_email: string | null;
  mobile_phone: string | null;
  line_id: string | null;
  house_address: string | null;
  house_subdistrict: string | null;
  house_district: string | null;
  house_province: string | null;
  house_postcode: string | null;
  contact_address: string | null;
  contact_subdistrict: string | null;
  contact_district: string | null;
  contact_province: string | null;
  contact_postcode: string | null;
  contact_same_as_house: number;
  emergency_name: string | null;
  emergency_relationship: string | null;
  emergency_phone: string | null;
  education_json: string;
  experience_json: string;
  skills_language_json: string;
  skills_other: string | null;
  references_json: string;
  created_at: string;
  updated_at: string | null;
};

export type RecruitaApplication = {
  id: number;
  candidate_id: number;
  position_id: number;
  stage: ApplicationStage;
  expected_salary: number | null;
  earliest_start_date: string | null;
  why_join: string | null;
  custom_answers: string;     // JSON
  consent_at: string | null;
  consent_ip: string | null;
  consent_user_agent: string | null;
  /** "ทราบข่าวสารการสมัครจากช่องทางใด" — used for source
   *  attribution in the recruitment dashboard. Free text in v1;
   *  later we'll switch to a dropdown so analytics roll up. */
  info_source: string | null;
  /** 0/1 from "สามารถไปปฏิบัติงานต่างจังหวัดได้หรือไม่" */
  can_travel: number | null;
  /** "คุณมีความคาดหวัง/เป้าหมายอะไรกับการสมัครเข้ามาทำงานกับเรา" */
  goals: string | null;
  /** 0/1 — Section 8 (truth declaration). Required to submit. */
  truth_declaration_accepted: number | null;
  /** Snapshot of latest work experience pulled out of the JSON so
   *  pipeline filters can run in SQL ("show me everyone whose
   *  last role was 'พยาบาล'") without parsing JSON per row. */
  last_workplace: string | null;
  last_position: string | null;
  last_tenure: string | null;
  last_salary: string | null;
  last_reason_left: string | null;
  hired_user_id: number | null;
  hired_at: string | null;
  hired_by: number | null;
  submitted_at: string;
  updated_at: string | null;
};

export type RecruitaDocumentKind =
  | "photo" | "resume" | "id_copy" | "education_cert"
  | "house_reg" | "other";

export type RecruitaDocument = {
  id: number;
  candidate_id: number;
  kind: RecruitaDocumentKind;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  stored_path: string;
  uploaded_at: string;
};

// ── Sub-row JSON types (education / experience / etc.) ──────────
// All optional fields use null instead of undefined so the JSON
// shape is stable in storage.

export type EducationRow = {
  level: string;          // "ม.ปลาย" | "ปวช" | "ปวส" | "ปริญญาตรี" | …
  institution: string;
  faculty: string | null;
  major: string | null;
  year_finished: string | null;  // e.g. "2566"
  gpa: string | null;            // string so leading zeros / "" survive
};

export type ExperienceRow = {
  company: string;
  position: string;
  started: string | null;        // YYYY-MM
  ended: string | null;          // YYYY-MM or "ปัจจุบัน"
  salary: string | null;
  reason_left: string | null;
};

export type LanguageRow = {
  language: string;
  level: "native" | "fluent" | "good" | "basic";
};

export type ReferenceRow = {
  name: string;
  relationship: string;
  phone: string;
};
