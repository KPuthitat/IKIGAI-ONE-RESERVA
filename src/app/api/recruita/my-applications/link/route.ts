import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { ApplicationStage } from "@/lib/recruita";

// POST /api/recruita/my-applications/link
//
// Self-service endpoint: a returning candidate who applied before the
// LINE-binding feature existed can link their existing candidate row to
// their current LINE account by providing their registered phone number.
//
// Rules:
//   • candidate found + line_user_id IS NULL         → link + return apps
//   • candidate found + line_user_id = same userId   → already linked (idempotent) + return apps
//   • candidate found + line_user_id = DIFFERENT uid → reject (prevent account takeover)
//   • candidate not found                            → not_found (don't leak existence)
//
// Phone matching is normalised on both sides (strip non-digits) to
// handle stored values like "082-345-6789" vs input "0823456789".
//
// Returns { ok: true, applications: [...] } on success
//      or { ok: false, error: "not_found" | "already_linked" }

const BodySchema = z.object({
  line_user_id: z.string().regex(/^U[0-9a-fA-F]{32}$/),
  mobile_phone: z.string().min(9).max(20)
});

type AppRow = {
  application_id: number;
  stage: ApplicationStage;
  submitted_at: string;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  department: string | null;
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
    SELECT id, line_user_id
    FROM recruita_candidates
    WHERE REPLACE(REPLACE(REPLACE(mobile_phone, '-', ''), ' ', ''), '.', '') = ?
       OR mobile_phone = ?
    LIMIT 1
  `).get(normalised, body.mobile_phone.trim()) as
    | { id: number; line_user_id: string | null }
    | undefined;

  if (!candidate) {
    // Don't distinguish "wrong phone" from "phone not in system" to
    // avoid leaking whether a number is registered.
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  if (
    candidate.line_user_id !== null &&
    candidate.line_user_id !== body.line_user_id
  ) {
    // Phone is already claimed by a different LINE account.
    return NextResponse.json({ ok: false, error: "already_linked" }, { status: 409 });
  }

  // Link if not already set
  if (candidate.line_user_id === null) {
    db.prepare(`
      UPDATE recruita_candidates
      SET line_user_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(body.line_user_id, candidate.id);
  }

  // Return the candidate's applications (may be empty — caller handles that)
  const rows = db.prepare(`
    SELECT a.id            AS application_id,
           a.stage         AS stage,
           a.submitted_at  AS submitted_at,
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
