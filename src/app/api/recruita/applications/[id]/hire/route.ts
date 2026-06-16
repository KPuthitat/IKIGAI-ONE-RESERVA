import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { requireAdmin } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { createInvite } from "@/lib/invites";
import { decryptSecret } from "@/lib/secret-vault";
import { notifyHireWelcome } from "@/lib/recruita-notify";

// POST /api/recruita/applications/[id]/hire
//
// The bridge — turns a RECRUITA candidate into a PERSONA employee
// in one atomic transaction. Fixed-cost path so the owner can ship
// a hire with one click instead of re-keying the application into
// the employee form.
//
// What lands:
//   1. New row in `users` with status='pending_invite' + placeholder
//      username (the new hire sets their own on invite redemption).
//   2. All EmployeeProfile-shaped fields carried 1:1 from
//      recruita_candidates (identity, contact, emergency, etc.).
//      national_id stays encrypted via the same secret-vault path
//      PERSONA already uses (#41), no re-prompt.
//   3. user_branches row linking the new hire to the branch the
//      admin chose (defaults to position.branch_id; can override).
//   4. recruita_applications row updated: stage='hired',
//      hired_user_id, hired_at, hired_by — so the application stays
//      as audit trail + clickable both directions.
//   5. createInvite() onboard invite. Returned URL is the LIFF one
//      when configured (auto-binds LINE) or the direct token URL.
//
// What does NOT happen (yet):
//   • LINE notification (Phase 1c — waiting on "IKIGAI RECRUIT"
//     channel setup).
//   • Other applications by the same candidate get marked
//     "withdrawn — hired elsewhere" (Phase 1b polish).

const Body = z.object({
  // Branch the new hire reports to. Default = position.branch_id,
  // but admin can override (e.g. position is "ทุกสาขา" but they're
  // assigning to NAMA).
  branch_id: z.number().int().positive(),
  // HR fields. role defaults to 'staff' — admin role requires
  // super_admin path elsewhere; we don't promote here.
  role: z.enum(["staff", "admin"]).default("staff"),
  employment_type: z.enum(["pt", "ft"]).default("ft"),
  employment_status: z.enum(["probation", "permanent"]).default("probation"),
  hire_mode: z.enum(["monthly", "daily", "hourly"]).default("monthly"),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monthly_salary: z.number().min(0).nullable().optional(),
  hourly_rate: z.number().min(0).nullable().optional(),
  job_title: z.string().trim().max(120).optional(),
  supervisor_user_id: z.number().int().positive().nullable().optional(),
  // Optional fixed employee code (left null → admin sets later)
  employee_code: z.string().max(40).nullable().optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const adminUser = requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;
  const db = getDb();

  // Load everything we need in one go
  const app = db.prepare(`
    SELECT id, candidate_id, position_id, stage, hired_user_id, health_check_status
    FROM recruita_applications WHERE id = ?
  `).get(id) as {
    id: number; candidate_id: number; position_id: number;
    stage: string; hired_user_id: number | null;
    health_check_status: string | null;
  } | undefined;
  if (!app) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (app.stage === "hired" || app.hired_user_id != null) {
    return NextResponse.json({ error: "already_hired" }, { status: 409 });
  }
  // Offer-acceptance gate (owner 2026-06-15): no skipping straight to hire —
  // the candidate must have accepted the offer first (stage = 'accepted').
  // The UI disables the button too, but the server is the ground truth.
  if (app.stage !== "accepted") {
    return NextResponse.json({
      error: "not_accepted",
      message: "ผู้สมัครต้องตอบรับข้อเสนองานก่อน (สถานะต้องเป็น \"ตอบรับข้อเสนอ\")"
    }, { status: 400 });
  }
  // Medical clearance gate (owner 2026-06-04): no hire until the health
  // check is recorded as 'passed'. The UI disables the button too, but
  // the server is the ground truth.
  if (app.health_check_status !== "passed") {
    return NextResponse.json({
      error: "health_check_not_passed",
      message: "ต้องบันทึกผลตรวจสุขภาพเป็น \"ผ่าน\" ก่อนจึงจะรับเข้าทำงานได้"
    }, { status: 400 });
  }

  const candidate = db.prepare(`
    SELECT * FROM recruita_candidates WHERE id = ?
  `).get(app.candidate_id) as Record<string, unknown> | undefined;
  if (!candidate) return NextResponse.json({ error: "candidate_missing" }, { status: 404 });

  const position = db.prepare(`
    SELECT id, title, branch_id, department FROM recruita_positions WHERE id = ?
  `).get(app.position_id) as {
    id: number; title: string; branch_id: number | null; department: string | null;
  } | undefined;
  if (!position) return NextResponse.json({ error: "position_missing" }, { status: 404 });

  // Make sure branch exists
  const branch = db.prepare("SELECT id FROM branches WHERE id = ?").get(d.branch_id);
  if (!branch) return NextResponse.json({ error: "invalid_branch" }, { status: 400 });

  const first = String(candidate.first_name_th ?? "").trim();
  const last  = String(candidate.last_name_th ?? "").trim();
  if (!first || !last) {
    return NextResponse.json({ error: "candidate_missing_name" }, { status: 400 });
  }

  // Resolve national_id back to plaintext for the PERSONA users.national_id
  // column. PERSONA stores it the same encrypted format (#41) so we
  // re-wrap it via secret-vault — but the upload-time helper here
  // just keeps the encrypted blob as-is since it's already in our
  // secret-vault format.
  const nationalIdEncrypted = (candidate.national_id_encrypted as string | null) ?? null;
  // We don't actually need plaintext — PERSONA's national_id column
  // accepts the same enc:v1: format. Keep the blob.
  void decryptSecret;

  // Build display_name = NAME ONLY ("<first> <last>"). The title prefix
  // lives in its own column (title_prefix below) and the UI prepends it via
  // nameWithPrefix() everywhere a name is shown. Baking the prefix in here
  // too doubled it ("นางสาว นางสาว ...") in every employee list (owner
  // 2026-06-16).
  const titlePrefix = (candidate.title_prefix as string | null) ?? null;
  const displayName = [first, last].filter(Boolean).join(" ").trim();

  // Placeholder credentials — replaced on invite redemption.
  const placeholderUsername = `invite.${Math.random().toString(36).slice(2, 10)}`;
  const placeholderHash = `!pending!${bcrypt.hashSync(crypto.randomUUID(), 4)}`;

  let newUserId = 0;
  try {
    const tx = db.transaction(() => {
      // ── Create users row with full EmployeeProfile carry ──
      const r = db.prepare(`
        INSERT INTO users (
          username, password_hash, display_name, role, status,
          title_prefix,
          first_name_th, last_name_th, first_name_en, last_name_en,
          nickname_th, nickname_en,
          dob, gender, nationality,
          religion, marital_status, military_status,
          national_id,
          personal_email, mobile_phone, line_id,
          house_address,
          emergency_name, emergency_relationship, emergency_phone,
          job_title, hire_date, employment_status, employment_type,
          hire_mode, monthly_salary, hourly_rate,
          supervisor_user_id, employee_code
        ) VALUES (
          ?, ?, ?, ?, 'pending_invite',
          ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?,
          ?, ?, ?,
          ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?
        )
      `).run(
        placeholderUsername, placeholderHash, displayName, d.role,
        titlePrefix,
        first, last,
        (candidate.first_name_en as string | null) ?? null,
        (candidate.last_name_en  as string | null) ?? null,
        (candidate.nickname_th   as string | null) ?? null,
        (candidate.nickname_en   as string | null) ?? null,
        (candidate.dob           as string | null) ?? null,
        (candidate.gender        as string | null) ?? null,
        (candidate.nationality   as string | null) ?? null,
        (candidate.religion      as string | null) ?? null,
        (candidate.marital_status   as string | null) ?? null,
        (candidate.military_status  as string | null) ?? null,
        nationalIdEncrypted,
        (candidate.personal_email as string | null) ?? null,
        (candidate.mobile_phone   as string | null) ?? null,
        (candidate.line_id        as string | null) ?? null,
        (candidate.house_address  as string | null) ?? null,
        (candidate.emergency_name         as string | null) ?? null,
        (candidate.emergency_relationship as string | null) ?? null,
        (candidate.emergency_phone        as string | null) ?? null,
        d.job_title?.trim() || position.title,
        d.hire_date,
        d.employment_status,
        d.employment_type,
        d.hire_mode,
        d.monthly_salary ?? null,
        d.hourly_rate ?? null,
        d.supervisor_user_id ?? null,
        d.employee_code ?? null
      );
      newUserId = Number(r.lastInsertRowid);

      // Link to branch
      db.prepare(
        "INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)"
      ).run(newUserId, d.branch_id);

      // Update the application
      db.prepare(`
        UPDATE recruita_applications
        SET stage = 'hired',
            hired_user_id = ?,
            hired_at = CURRENT_TIMESTAMP,
            hired_by = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newUserId, adminUser.id, app.id);
    });
    tx();
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return NextResponse.json({ error: "duplicate_user" }, { status: 409 });
    }
    console.error("[recruita-hire] tx failed:", e);
    return NextResponse.json({ error: "hire_failed" }, { status: 500 });
  }

  // ── Create the onboard invite ─────────────────────────────
  // Same kind / lifetime as the existing PERSONA onboard flow so
  // the redemption page (/persona/invite/<token>) handles it
  // without changes — staff sets username + password + binds LINE.
  const invite = createInvite({
    userId: newUserId, kind: "onboard", createdBy: adminUser.id
  });
  logPersonaAction(adminUser.id, "recruita.hire", invite.id);

  const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const directUrl = `${base}/persona/invite/${invite.token}`;
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID_INVITE;
  const liffUrl = liffId
    ? `https://liff.line.me/${liffId}?token=${invite.token}`
    : null;

  // Fire-and-forget: send the new hire the welcome card via the IKIGAI Recruit
  // OA — its only action is "เพิ่มเพื่อน IKIGAI OS PORTAL" (so they add the
  // staff OA). Account setup + LINE binding are handled by the admin manually
  // afterward (owner 2026-06-16). The onboard invite still exists below for the
  // admin to send from the application detail page. No-op when the applicant
  // has no linked LINE userId / OA isn't set.
  void notifyHireWelcome(app.id).catch((e) =>
    console.warn("[recruita-hire] hire welcome notify failed", e)
  );

  return NextResponse.json({
    ok: true,
    user_id: newUserId,
    invite_id: invite.id,
    token: invite.token,
    expires_at: invite.expires_at,
    url: liffUrl ?? directUrl,
    liff_url: liffUrl,
    direct_url: directUrl
  });
}
