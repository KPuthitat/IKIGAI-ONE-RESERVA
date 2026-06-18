import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { ApplicationStage } from "@/lib/recruita";

// POST /api/recruita/my-applications/link
//
// Phone SEARCH for the candidate-facing status page. Primary identity
// is the LINE binding (LIFF auto-detect); this is the fallback for when
// someone opens the page outside LINE, or their LINE isn't linked yet.
//
// Behaviour:
//   • find the candidate by their registered phone number
//   • return the matching applications (READ-ONLY search)
//
// IMPORTANT (owner 2026-06-13): this endpoint NO LONGER binds line_user_id.
// The old "opportunistic bind on phone search" wrote the searcher's LINE
// userId onto whatever candidate matched the typed phone — but phone is not
// unique or verified, so person B searching person A's number (shared/typo'd
// phone) bound B's LINE to A's candidate → A's stage notifications were
// delivered to B. Binding now comes only from a trustworthy source: LIFF
// auto-capture at apply time (the applicant's own LINE) and the admin
// link-line flow. Search is purely read-only.
//
// line_user_id is still accepted (optional) for backward compatibility with
// existing clients but is intentionally ignored here. Phone matching is
// normalised on both sides (strip non-digits) so stored "082-345-6789"
// matches input "0823456789".
//
// Returns { ok: true, applications: [...] } or { ok: false, error: "not_found" }.

const BodySchema = z.object({
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/).optional(),
  mobile_phone: z.string().min(9).max(20)
});

type AppRow = {
  application_id: number;
  stage: ApplicationStage;
  submitted_at: string;
  day_seq: number;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  department: string | null;
  interview_at: string | null;
  interview_location: string | null;
  interview_confirmed: number | null;
  offer_salary: number | null;
  offer_salary_type: "monthly" | "hourly" | null;
  offer_start_date: string | null;
  offer_conditions: string | null;
  health_cert_uploaded: number;
  health_cert_filename: string | null;
};

export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  const db = getDb();

  // Normalise: keep digits only, so "082-345-6789" == "0823456789"
  const normalised = body.mobile_phone.replace(/\D/g, "");

  // Find the candidate by phone (try normalised AND raw stored value)
  const candidate = db.prepare(`
    SELECT id
    FROM recruita_candidates
    WHERE REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), ' ', ''), '.', '') = ?
       OR mobile_phone = ?
    LIMIT 1
  `).get(normalised, body.mobile_phone.trim()) as { id: number } | undefined;

  if (!candidate) {
    // Don't distinguish "wrong phone" from "phone not in system" to
    // avoid leaking whether a number is registered.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // (No binding here — see header note. Phone search is read-only.)

  // Return the candidate's applications (may be empty — caller handles that)
  const rows = db.prepare(`
    SELECT a.id            AS application_id,
           a.stage         AS stage,
           a.submitted_at  AS submitted_at,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           a.interview_at        AS interview_at,
           a.interview_location  AS interview_location,
           a.interview_confirmed AS interview_confirmed,
           a.offer_salary        AS offer_salary,
           a.offer_salary_type   AS offer_salary_type,
           a.offer_start_date    AS offer_start_date,
           a.offer_conditions    AS offer_conditions,
           (SELECT COUNT(*) FROM recruita_documents d
             WHERE d.candidate_id = a.candidate_id AND d.kind = 'health_cert') AS health_cert_uploaded,
           (SELECT d.original_filename FROM recruita_documents d
             WHERE d.candidate_id = a.candidate_id AND d.kind = 'health_cert'
             ORDER BY d.id DESC LIMIT 1) AS health_cert_filename,
           p.title         AS position_title,
           p.code          AS position_code,
           p.department    AS department,
           b.name          AS branch_name
    FROM recruita_applications a
    JOIN recruita_positions p ON p.id = a.position_id
    LEFT JOIN branches b      ON b.id = p.branch_id
    WHERE a.candidate_id = ?
    ORDER BY a.submitted_at DESC
  `).all(candidate.id) as AppRow[];

  return NextResponse.json({ ok: true, applications: rows });
}
