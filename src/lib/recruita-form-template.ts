// RECRUITA standard application form template.
//
// The candidate-facing apply form at /recruita/apply/[positionId] is
// driven by this template. Each "section" maps to a visual block on
// the form; each "field" is a single input. Admin edits the template
// at /admin/recruita/form-template:
//   - toggle a field/section on or off
//   - rename the visible label (label_th + label_en)
//   - mark a field required (true) or optional (false)
//   - reorder fields within a section
//
// The KEY of each section/field is IMMUTABLE — it maps to a column on
// recruita_candidates or recruita_applications. Renaming the LABEL
// doesn't change which DB column receives the data.
//
// Persistence: serialised JSON in system_settings.recruita_form_template_json.
// NULL = use DEFAULT_TEMPLATE (this file). When admin saves, we merge
// their overrides over the default so adding new fields in a future
// release doesn't lose user customisation.

import { getDb } from "./db";

// ── Types ───────────────────────────────────────────────────────────

export type FormFieldKey =
  // Identity
  | "title_prefix" | "first_name_th" | "last_name_th"
  | "first_name_en" | "last_name_en" | "nickname_th"
  | "dob" | "gender" | "nationality" | "race"
  | "marital_status" | "military_status" | "religion" | "national_id"
  // Contact
  | "personal_email" | "mobile_phone" | "line_id"
  | "house_address" | "housing_type"
  // Education / Experience / Skills are multi-row, toggled at the
  // SECTION level (whole block on/off); individual sub-fields live
  // inside the section but aren't separately toggleable in v1.
  | "professional_license_status"
  | "skills_other"
  | "introduction"
  // References
  | "emergency_name" | "emergency_relationship" | "emergency_phone"
  | "referee_external_text"
  // Application-level
  | "expected_salary" | "earliest_start_date"
  | "goals" | "why_join" | "info_source"
  | "can_travel" | "prior_illness" | "prior_illness_detail"
  | "prior_application_at"
  // Documents
  | "doc_photo" | "doc_resume" | "doc_id_copy";

export type FormSectionKey =
  | "identity"
  | "contact"
  | "education"   // multi-row block
  | "license"
  | "experience"  // multi-row block
  | "skills"
  | "introduction"
  | "references"
  | "application"
  | "documents";

export type FormField = {
  /** Stable key — maps to a DB column. Never change. */
  key: FormFieldKey;
  /** Visible labels. Editable by admin. */
  label_th: string;
  label_en: string;
  /** Show on the form. false = hide. */
  enabled: boolean;
  /** Block submit when empty. */
  required: boolean;
  /** Lower numbers render first within their section. */
  display_order: number;
};

export type FormSection = {
  key: FormSectionKey;
  label_th: string;
  label_en: string;
  enabled: boolean;
  display_order: number;
  fields: FormField[];
};

export type FormTemplate = {
  /** Bumped whenever the DEFAULT_TEMPLATE shape changes — lets us
   *  migrate user-saved overrides forward by remerging. */
  version: number;
  sections: FormSection[];
};

// ── Default template ─────────────────────────────────────────────────
// Mirrors the hardcoded form in src/app/recruita/apply/[positionId]/
// ApplyClient.tsx. When the admin hasn't saved overrides yet, this is
// what the form renders.

export const TEMPLATE_VERSION = 1;

export const DEFAULT_TEMPLATE: FormTemplate = {
  version: TEMPLATE_VERSION,
  sections: [
    {
      key: "identity",
      label_th: "ข้อมูลส่วนตัว",
      label_en: "Personal Information",
      enabled: true,
      display_order: 10,
      fields: [
        { key: "title_prefix",   label_th: "คำนำหน้า",          label_en: "Title",             enabled: true, required: true,  display_order: 10 },
        { key: "first_name_th",  label_th: "ชื่อ (ไทย)",         label_en: "First name (TH)",   enabled: true, required: true,  display_order: 20 },
        { key: "last_name_th",   label_th: "นามสกุล (ไทย)",      label_en: "Last name (TH)",    enabled: true, required: true,  display_order: 30 },
        { key: "first_name_en",  label_th: "ชื่อ (อังกฤษ)",       label_en: "First name (EN)",   enabled: true, required: false, display_order: 40 },
        { key: "last_name_en",   label_th: "นามสกุล (อังกฤษ)",    label_en: "Last name (EN)",    enabled: true, required: false, display_order: 50 },
        { key: "nickname_th",    label_th: "ชื่อเล่น",           label_en: "Nickname",          enabled: true, required: false, display_order: 60 },
        { key: "dob",            label_th: "วันเกิด",            label_en: "Date of birth",      enabled: true, required: true,  display_order: 70 },
        { key: "gender",         label_th: "เพศ",                label_en: "Gender",             enabled: true, required: true,  display_order: 80 },
        { key: "nationality",    label_th: "สัญชาติ",            label_en: "Nationality",        enabled: true, required: true,  display_order: 90 },
        { key: "race",           label_th: "เชื้อชาติ",          label_en: "Race",               enabled: true, required: false, display_order: 100 },
        { key: "marital_status", label_th: "สถานภาพสมรส",        label_en: "Marital status",     enabled: true, required: false, display_order: 110 },
        { key: "military_status", label_th: "สถานภาพทางทหาร",     label_en: "Military status",    enabled: true, required: false, display_order: 120 },
        { key: "religion",       label_th: "ศาสนา",              label_en: "Religion",           enabled: true, required: false, display_order: 130 },
        { key: "national_id",    label_th: "เลขบัตรประชาชน",     label_en: "National ID",        enabled: true, required: true,  display_order: 140 }
      ]
    },
    {
      key: "contact",
      label_th: "ข้อมูลติดต่อ",
      label_en: "Contact",
      enabled: true,
      display_order: 20,
      fields: [
        { key: "personal_email", label_th: "อีเมล",              label_en: "Email",              enabled: true, required: true,  display_order: 10 },
        { key: "mobile_phone",   label_th: "เบอร์มือถือ",        label_en: "Mobile phone",       enabled: true, required: true,  display_order: 20 },
        { key: "line_id",        label_th: "LINE ID",            label_en: "LINE ID",            enabled: true, required: false, display_order: 30 },
        { key: "house_address",  label_th: "ที่อยู่ปัจจุบัน",     label_en: "Current address",    enabled: true, required: true,  display_order: 40 },
        { key: "housing_type",   label_th: "ประเภทที่พัก",        label_en: "Housing type",       enabled: true, required: false, display_order: 50 }
      ]
    },
    {
      key: "education",
      label_th: "การศึกษา",
      label_en: "Education",
      enabled: true,
      display_order: 30,
      // Multi-row block — sub-fields (level/institution/faculty/major/year/gpa)
      // render together. v1 toggles the whole section, not individual columns.
      fields: []
    },
    {
      key: "license",
      label_th: "ใบประกอบวิชาชีพ",
      label_en: "Professional license",
      enabled: true,
      display_order: 40,
      fields: [
        { key: "professional_license_status", label_th: "สถานะใบประกอบวิชาชีพ", label_en: "License status", enabled: true, required: false, display_order: 10 }
      ]
    },
    {
      key: "experience",
      label_th: "ประสบการณ์ทำงาน",
      label_en: "Work experience",
      enabled: true,
      display_order: 50,
      fields: []
    },
    {
      key: "skills",
      label_th: "ทักษะ",
      label_en: "Skills",
      enabled: true,
      display_order: 60,
      fields: [
        { key: "skills_other", label_th: "ทักษะอื่นๆ", label_en: "Other skills", enabled: true, required: false, display_order: 10 }
      ]
    },
    {
      key: "introduction",
      label_th: "แนะนำตัว",
      label_en: "Introduction",
      enabled: true,
      display_order: 70,
      fields: [
        { key: "introduction", label_th: "เล่าเกี่ยวกับตัวคุณ", label_en: "About yourself", enabled: true, required: false, display_order: 10 }
      ]
    },
    {
      key: "references",
      label_th: "ผู้ที่ติดต่อได้",
      label_en: "References",
      enabled: true,
      display_order: 80,
      fields: [
        { key: "emergency_name",         label_th: "ชื่อผู้ติดต่อฉุกเฉิน",  label_en: "Emergency contact name",       enabled: true, required: true,  display_order: 10 },
        { key: "emergency_relationship", label_th: "ความสัมพันธ์",          label_en: "Relationship",                 enabled: true, required: true,  display_order: 20 },
        { key: "emergency_phone",        label_th: "เบอร์โทร",              label_en: "Phone",                        enabled: true, required: true,  display_order: 30 },
        { key: "referee_external_text",  label_th: "ผู้รับรองภายนอก",        label_en: "External referees",            enabled: true, required: false, display_order: 40 }
      ]
    },
    {
      key: "application",
      label_th: "ข้อมูลการสมัคร",
      label_en: "Application details",
      enabled: true,
      display_order: 90,
      fields: [
        { key: "expected_salary",      label_th: "เงินเดือนที่คาดหวัง",   label_en: "Expected salary",   enabled: true, required: false, display_order: 10 },
        { key: "earliest_start_date",  label_th: "วันที่เริ่มงานได้เร็วสุด", label_en: "Earliest start date", enabled: true, required: false, display_order: 20 },
        { key: "goals",                label_th: "เป้าหมายในการทำงาน",    label_en: "Career goals",       enabled: true, required: false, display_order: 30 },
        { key: "why_join",             label_th: "ทำไมจึงสนใจร่วมงานกับเรา", label_en: "Why join us",       enabled: true, required: false, display_order: 40 },
        { key: "info_source",          label_th: "ทราบข่าวรับสมัครจาก",   label_en: "How did you hear about us", enabled: true, required: false, display_order: 50 },
        { key: "can_travel",           label_th: "สะดวกเดินทาง/ย้ายที่ทำงาน", label_en: "Willing to travel", enabled: true, required: false, display_order: 60 },
        { key: "prior_illness",        label_th: "โรคประจำตัว",          label_en: "Prior illness",      enabled: true, required: false, display_order: 70 },
        { key: "prior_illness_detail", label_th: "รายละเอียดโรคประจำตัว", label_en: "Illness detail",     enabled: true, required: false, display_order: 80 },
        { key: "prior_application_at", label_th: "เคยสมัครงานกับเราเมื่อใด", label_en: "Prior application date", enabled: true, required: false, display_order: 90 }
      ]
    },
    {
      key: "documents",
      label_th: "เอกสารแนบ",
      label_en: "Documents",
      enabled: true,
      display_order: 100,
      fields: [
        { key: "doc_photo",   label_th: "รูปถ่าย",      label_en: "Photo",   enabled: true, required: false, display_order: 10 },
        { key: "doc_resume",  label_th: "เรซูเม่",     label_en: "Resume",   enabled: true, required: false, display_order: 20 },
        { key: "doc_id_copy", label_th: "สำเนาบัตรประชาชน", label_en: "ID copy", enabled: true, required: false, display_order: 30 }
      ]
    }
  ]
};

// ── Persistence ─────────────────────────────────────────────────────

/** Pull the saved template (or DEFAULT_TEMPLATE if admin hasn't
 *  customised). Always validates the parsed JSON has the expected
 *  shape — on any parse error we fall back to default so a corrupt
 *  row doesn't break the public apply form. */
export function getFormTemplate(): FormTemplate {
  const row = getDb().prepare(
    "SELECT recruita_form_template_json FROM system_settings WHERE id = 1"
  ).get() as { recruita_form_template_json: string | null } | undefined;
  if (!row?.recruita_form_template_json) return DEFAULT_TEMPLATE;
  try {
    const parsed = JSON.parse(row.recruita_form_template_json) as unknown;
    if (!isValidTemplate(parsed)) {
      console.warn("[recruita] form template shape invalid — falling back to default");
      return DEFAULT_TEMPLATE;
    }
    return parsed;
  } catch (e) {
    console.warn("[recruita] form template JSON parse failed:", e);
    return DEFAULT_TEMPLATE;
  }
}

/** Overwrite the saved template. The caller is responsible for
 *  passing a well-formed FormTemplate — the API layer validates with
 *  Zod before calling this. */
export function saveFormTemplate(template: FormTemplate, updatedBy: number | null): void {
  const json = JSON.stringify(template);
  getDb().prepare(`
    UPDATE system_settings
       SET recruita_form_template_json = ?,
           updated_at = CURRENT_TIMESTAMP,
           updated_by = ?
     WHERE id = 1
  `).run(json, updatedBy);
}

// ── Validation ──────────────────────────────────────────────────────

function isValidTemplate(v: unknown): v is FormTemplate {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  if (typeof t.version !== "number") return false;
  if (!Array.isArray(t.sections)) return false;
  for (const s of t.sections) {
    if (!s || typeof s !== "object") return false;
    const sec = s as Record<string, unknown>;
    if (typeof sec.key !== "string") return false;
    if (typeof sec.label_th !== "string") return false;
    if (typeof sec.label_en !== "string") return false;
    if (typeof sec.enabled !== "boolean") return false;
    if (typeof sec.display_order !== "number") return false;
    if (!Array.isArray(sec.fields)) return false;
    for (const f of sec.fields) {
      if (!f || typeof f !== "object") return false;
      const field = f as Record<string, unknown>;
      if (typeof field.key !== "string") return false;
      if (typeof field.label_th !== "string") return false;
      if (typeof field.label_en !== "string") return false;
      if (typeof field.enabled !== "boolean") return false;
      if (typeof field.required !== "boolean") return false;
      if (typeof field.display_order !== "number") return false;
    }
  }
  return true;
}
