import { NextResponse } from "next/server";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { encryptSecret } from "@/lib/secret-vault";
import {
  buildDedupeHash,
  type CustomAnswers
} from "@/lib/recruita";
import { notifyExecGroupNewApplication } from "@/lib/recruita-notify";

// POST /api/recruita/applications — public submit endpoint. No
// auth required; PDPA consent fields gate the actual write. Body
// arrives as multipart form data:
//   payload : JSON string (FormState from ApplyClient + position_id)
//   photo   : optional File
//   resume  : optional File
//   id_copy : optional File
//
// Server-side responsibilities:
//   1. Validate JSON body against the schema below.
//   2. Validate uploaded files (size ≤ 10MB, allowed mime).
//   3. Dedupe candidate via buildDedupeHash() — same person
//      applying to multiple positions reuses one candidates row.
//   4. Encrypt national_id at rest (secret-vault).
//   5. Persist candidate (or update existing), insert application,
//      save files under data/recruita/<candidateId>/.
//   6. Stamp consent_at / consent_ip / consent_user_agent.
//
// Returns { ok: true, application_id }. Client redirects to
// /recruita/apply/[id]/thanks?aid=<application_id>.

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic"
]);
const DATA_ROOT = process.env.RECRUITA_DATA_ROOT
  ?? path.join(process.cwd(), "data", "recruita");

const EducationRowSchema = z.object({
  level: z.string().max(60),
  institution: z.string().max(200),
  faculty: z.string().max(200),
  major: z.string().max(200),
  year_finished: z.string().max(20),
  gpa: z.string().max(20)
});
const ExperienceRowSchema = z.object({
  company: z.string().max(200),
  position: z.string().max(200),
  started: z.string().max(20),
  ended: z.string().max(20),
  salary: z.string().max(60),
  reason_left: z.string().max(500)
});
const LanguageRowSchema = z.object({
  language: z.string().max(60),
  level: z.string().max(20)
});

const Payload = z.object({
  position_id: z.number().int().positive(),
  pdpa_consent: z.literal(true), // hard gate
  truth_declaration_accepted: z.literal(true),
  /** LINE userId — only set when the form is opened via LIFF (the
   *  IKIGAI Recruit OA). Web-form applicants send null. Capturing
   *  here lets the stage-change push reach the candidate directly. */
  line_user_id: z.string().max(80).nullable().optional(),
  // Identity
  title_prefix: z.string().max(20).optional().default(""),
  first_name_th: z.string().trim().min(1).max(80),
  last_name_th: z.string().trim().min(1).max(80),
  first_name_en: z.string().max(80).optional().default(""),
  last_name_en: z.string().max(80).optional().default(""),
  nickname_th: z.string().max(40).optional().default(""),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  gender: z.string().max(20).optional().default(""),
  nationality: z.string().max(40).optional().default(""),
  race: z.string().max(40).optional().default(""),
  marital_status: z.string().max(20).optional().default(""),
  military_status: z.string().max(20).optional().default(""),
  religion: z.string().max(40).optional().default(""),
  national_id: z.string().regex(/^\d{0,13}$/).optional().default(""),
  // Contact
  personal_email: z.string().max(200).optional().default(""),
  mobile_phone: z.string().trim().min(1).max(40),
  line_id: z.string().max(80).optional().default(""),
  house_address: z.string().max(500).optional().default(""),
  housing_type: z.string().max(20).optional().default(""),
  // History
  education: z.array(EducationRowSchema).max(10).default([]),
  professional_license_status: z.string().max(20).optional().default(""),
  experience: z.array(ExperienceRowSchema).max(10).default([]),
  // Skills
  skills_language: z.array(LanguageRowSchema).max(10).default([]),
  skills_other: z.string().max(1000).optional().default(""),
  introduction: z.string().max(2000).optional().default(""),
  // References
  emergency_name: z.string().max(120).optional().default(""),
  emergency_relationship: z.string().max(80).optional().default(""),
  emergency_phone: z.string().max(40).optional().default(""),
  referee_external_text: z.string().max(500).optional().default(""),
  // Application-level
  expected_salary: z.string().max(20).optional().default(""),
  earliest_start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  goals: z.string().max(2000).optional().default(""),
  why_join: z.string().max(2000).optional().default(""),
  info_source: z.string().max(200).optional().default(""),
  can_travel: z.string().max(10).optional().default(""),
  prior_illness: z.string().max(10).optional().default(""),
  prior_illness_detail: z.string().max(500).optional().default(""),
  prior_application_at: z.string().max(40).optional().default(""),
  custom: z.record(z.unknown()).default({})
});

async function saveFile(
  file: File,
  candidateDir: string,
  kind: "photo" | "resume" | "id_copy"
): Promise<{ stored_path: string; original_filename: string; mime_type: string; size_bytes: number } | null> {
  if (file.size === 0) return null;
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${kind}: ไฟล์เกิน 10 MB`);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    throw new Error(`${kind}: ประเภทไฟล์ไม่รองรับ (${file.type})`);
  }
  await fs.mkdir(candidateDir, { recursive: true });
  const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] ?? "").slice(0, 8) || ".bin";
  const filename = `${kind}-${randomBytes(8).toString("hex")}${ext}`;
  const fullPath = path.join(candidateDir, filename);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(fullPath, buf);
  return {
    stored_path: fullPath,
    original_filename: file.name.slice(0, 200),
    mime_type: file.type,
    size_bytes: file.size
  };
}

export async function POST(req: Request) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected_multipart" }, { status: 400 });
  }
  const raw = formData.get("payload");
  if (typeof raw !== "string") {
    return NextResponse.json({ error: "missing_payload" }, { status: 400 });
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(raw); }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }

  const parsed = Payload.safeParse(parsedJson);
  if (!parsed.success) {
    // Surface the first failing field path + message in a form the
    // candidate-facing UI can render directly — "invalid_body" alone
    // is useless when the form has 40+ fields and the gate is a
    // single regex on (say) prior_application_at. We still ship the
    // full flatten() under `detail` for ops debugging.
    const first = parsed.error.issues[0];
    const pathStr = first?.path.join(".") || "(unknown)";
    const message = first
      ? `ข้อมูลในช่อง ${pathStr} ไม่ถูกต้อง — ${first.message}`
      : "ข้อมูลในแบบฟอร์มไม่ถูกต้อง";
    return NextResponse.json(
      {
        error: "invalid_body",
        message,
        field: pathStr,
        detail: parsed.error.flatten()
      },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const db = getDb();
  const position = db.prepare(
    "SELECT id FROM recruita_positions WHERE id = ? AND status = 'open'"
  ).get(d.position_id);
  if (!position) {
    return NextResponse.json({ error: "position_not_open" }, { status: 400 });
  }

  // ── Dedupe candidate ──────────────────────────────────────
  const dedupeHash = buildDedupeHash(
    d.national_id || null, d.personal_email || null, d.mobile_phone
  );
  let candidateId: number | null = null;
  if (dedupeHash) {
    const existing = db.prepare(
      "SELECT id FROM recruita_candidates WHERE dedupe_hash = ?"
    ).get(dedupeHash) as { id: number } | undefined;
    if (existing) candidateId = existing.id;
  }

  // Capture consent metadata (PDPA audit trail)
  const consent_at = new Date().toISOString();
  const consent_ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip") ?? null;
  const consent_user_agent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  // Pre-apply auto-link: candidate may have added the IKIGAI Recruit
  // OA BEFORE submitting (followed → browsed → applied via direct URL).
  // The follow event stashed their userId in line_oa_recent_followers.
  // If the payload has no line_user_id of its own, claim the most-recent
  // unclaimed follower from the last 7 days. Single follower window so
  // we don't accidentally cross-link two simultaneous applicants.
  // Pairs with the post-apply follow path in api/line/webhook (when
  // they add the OA AFTER applying).
  let effectiveLineUserId: string | null = d.line_user_id || null;
  if (!effectiveLineUserId) {
    try {
      const seven = new Date(Date.now() - 7 * 86400_000).toISOString();
      const follower = db.prepare(`
        SELECT line_user_id FROM line_oa_recent_followers
        WHERE channel_scope = 'recruita'
          AND consumed_at IS NULL
          AND followed_at >= ?
        ORDER BY followed_at DESC
        LIMIT 1
      `).get(seven) as { line_user_id: string } | undefined;
      if (follower) {
        effectiveLineUserId = follower.line_user_id;
        db.prepare(
          "UPDATE line_oa_recent_followers SET consumed_at = CURRENT_TIMESTAMP WHERE line_user_id = ? AND channel_scope = 'recruita'"
        ).run(follower.line_user_id);
        console.info(
          `[recruita] pre-apply recency-link: claimed follower ${follower.line_user_id} for the upcoming application`
        );
      }
    } catch (e) {
      console.warn("[recruita] pre-apply recency-link failed:", e);
    }
  }

  // Helpers
  const enc = (s: string) => s ? encryptSecret(s) : null;
  const toJsonArr = (arr: unknown[]) => JSON.stringify(arr ?? []);
  const yn = (v: string): number | null =>
    v === "yes" ? 1 : v === "no" ? 0 : null;

  // ── Insert / update candidate ─────────────────────────────
  if (candidateId == null) {
    const info = db.prepare(`
      INSERT INTO recruita_candidates
        (dedupe_hash, line_user_id,
         title_prefix, first_name_th, last_name_th,
         first_name_en, last_name_en, nickname_th,
         dob, gender, nationality, race, marital_status,
         military_status, religion, national_id_encrypted,
         housing_type, professional_license_status,
         prior_illness, prior_illness_detail, prior_application_at,
         referee_external_text,
         personal_email, mobile_phone, line_id, house_address,
         emergency_name, emergency_relationship, emergency_phone,
         education_json, experience_json, skills_language_json,
         skills_other, references_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      dedupeHash,
      effectiveLineUserId,
      d.title_prefix || null,
      d.first_name_th, d.last_name_th,
      d.first_name_en || null, d.last_name_en || null, d.nickname_th || null,
      d.dob || null, d.gender || null, d.nationality || null,
      d.race || null, d.marital_status || null,
      d.military_status || null, d.religion || null,
      enc(d.national_id),
      d.housing_type || null,
      d.professional_license_status || null,
      yn(d.prior_illness), d.prior_illness_detail || null,
      d.prior_application_at || null,
      d.referee_external_text || null,
      d.personal_email || null, d.mobile_phone, d.line_id || null,
      d.house_address || null,
      d.emergency_name || null, d.emergency_relationship || null,
      d.emergency_phone || null,
      toJsonArr(d.education), toJsonArr(d.experience), toJsonArr(d.skills_language),
      d.skills_other || null,
      JSON.stringify([])  // references_json reserved for future explicit-list UI
    );
    candidateId = Number(info.lastInsertRowid);
  } else {
    // Same applicant returning — refresh the editable fields so
    // pipeline filters see current values; keep created_at stable.
    // line_user_id is set ONLY when null (don't overwrite a known
    // binding with a new LIFF session's userId — which can happen
    // if the candidate later opens the form in a different LINE
    // session somehow).
    if (effectiveLineUserId) {
      db.prepare(
        "UPDATE recruita_candidates SET line_user_id = ? WHERE id = ? AND line_user_id IS NULL"
      ).run(effectiveLineUserId, candidateId);
    }
    db.prepare(`
      UPDATE recruita_candidates SET
        title_prefix = COALESCE(?, title_prefix),
        first_name_th = ?, last_name_th = ?,
        first_name_en = COALESCE(?, first_name_en),
        last_name_en = COALESCE(?, last_name_en),
        nickname_th = COALESCE(?, nickname_th),
        dob = COALESCE(?, dob),
        gender = COALESCE(?, gender),
        nationality = COALESCE(?, nationality),
        race = COALESCE(?, race),
        marital_status = COALESCE(?, marital_status),
        military_status = COALESCE(?, military_status),
        religion = COALESCE(?, religion),
        national_id_encrypted = COALESCE(?, national_id_encrypted),
        housing_type = COALESCE(?, housing_type),
        professional_license_status = COALESCE(?, professional_license_status),
        prior_illness = COALESCE(?, prior_illness),
        prior_illness_detail = COALESCE(?, prior_illness_detail),
        prior_application_at = COALESCE(?, prior_application_at),
        referee_external_text = COALESCE(?, referee_external_text),
        personal_email = COALESCE(?, personal_email),
        mobile_phone = ?,
        line_id = COALESCE(?, line_id),
        house_address = COALESCE(?, house_address),
        emergency_name = COALESCE(?, emergency_name),
        emergency_relationship = COALESCE(?, emergency_relationship),
        emergency_phone = COALESCE(?, emergency_phone),
        education_json = ?, experience_json = ?, skills_language_json = ?,
        skills_other = COALESCE(?, skills_other),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      d.title_prefix || null, d.first_name_th, d.last_name_th,
      d.first_name_en || null, d.last_name_en || null, d.nickname_th || null,
      d.dob || null, d.gender || null, d.nationality || null,
      d.race || null, d.marital_status || null,
      d.military_status || null, d.religion || null,
      enc(d.national_id),
      d.housing_type || null, d.professional_license_status || null,
      yn(d.prior_illness), d.prior_illness_detail || null,
      d.prior_application_at || null,
      d.referee_external_text || null,
      d.personal_email || null, d.mobile_phone, d.line_id || null,
      d.house_address || null,
      d.emergency_name || null, d.emergency_relationship || null,
      d.emergency_phone || null,
      toJsonArr(d.education), toJsonArr(d.experience), toJsonArr(d.skills_language),
      d.skills_other || null,
      candidateId
    );
  }

  // ── Save files (after we know candidateId) ────────────────
  const candidateDir = path.join(DATA_ROOT, String(candidateId));
  const docs: Array<{ kind: string; file: File }> = [];
  const photo  = formData.get("photo");
  const resume = formData.get("resume");
  const idCopy = formData.get("id_copy");
  if (photo  instanceof File && photo.size  > 0) docs.push({ kind: "photo",  file: photo });
  if (resume instanceof File && resume.size > 0) docs.push({ kind: "resume", file: resume });
  if (idCopy instanceof File && idCopy.size > 0) docs.push({ kind: "id_copy", file: idCopy });

  try {
    for (const { kind, file } of docs) {
      const saved = await saveFile(file, candidateDir, kind as "photo" | "resume" | "id_copy");
      if (!saved) continue;
      db.prepare(`
        INSERT INTO recruita_documents
          (candidate_id, kind, original_filename, mime_type, size_bytes, stored_path)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(candidateId, kind, saved.original_filename,
             saved.mime_type, saved.size_bytes, saved.stored_path);
    }
  } catch (e) {
    return NextResponse.json(
      { error: "file_upload_failed", detail: (e as Error).message },
      { status: 400 }
    );
  }

  // ── Insert application ────────────────────────────────────
  // Snapshot latest experience row into the dedicated columns so
  // pipeline filters can hit them without parsing JSON per row.
  const lastExp = d.experience[0] ?? null;
  const customAnswers: CustomAnswers = {};
  // Light pass-through — the editor types lift into a shape the
  // server doesn't need to re-verify per question (already trusted
  // via Payload schema). We just JSON.stringify the whole thing.

  const appInfo = db.prepare(`
    INSERT INTO recruita_applications
      (candidate_id, position_id, stage,
       expected_salary, earliest_start_date, why_join,
       custom_answers, consent_at, consent_ip, consent_user_agent,
       info_source, can_travel, goals, truth_declaration_accepted,
       last_workplace, last_position, last_tenure, last_salary, last_reason_left)
    VALUES (?, ?, 'applied', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId, d.position_id,
    d.expected_salary ? Number(d.expected_salary) : null,
    d.earliest_start_date || null,
    d.why_join || null,
    JSON.stringify({ ...d.custom, ...customAnswers }),
    consent_at, consent_ip, consent_user_agent,
    d.info_source || null,
    yn(d.can_travel),
    d.goals || null,
    1, // truth_declaration_accepted — gated by literal(true)
    lastExp?.company || null, lastExp?.position || null,
    lastExp ? `${lastExp.started || "?"} - ${lastExp.ended || "?"}` : null,
    lastExp?.salary || null, lastExp?.reason_left || null
  );

  const newApplicationId = Number(appInfo.lastInsertRowid);

  // Fire-and-forget exec group notification. Settles on a background
  // microtask so the candidate sees their /thanks redirect with no
  // wait on LINE's API. notifyExecGroupNewApplication is a no-op if
  // the group id or platform OA isn't configured — see its docstring.
  void notifyExecGroupNewApplication(newApplicationId).catch((e) => {
    console.warn("[recruita] exec group notify failed:", e);
  });

  return NextResponse.json({
    ok: true,
    application_id: newApplicationId,
    candidate_id: candidateId
  });
}
