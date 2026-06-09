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
//   • if a LINE userId is supplied AND the candidate isn't bound yet,
//     bind it opportunistically (so future stage pushes reach them) —
//     but NEVER re-bind a candidate already linked to another LINE
//     account (no takeover; we just show their applications)
//   • always return the matching applications (search semantics)
//
// line_user_id is OPTIONAL — present only when the page was opened via
// LIFF. Phone matching is normalised on both sides (strip non-digits)
// so stored "082-345-6789" matches input "0823456789".
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

  // Opportunistic bind: only when we have a LINE userId AND this
  // candidate isn't already linked to someone. Search never claims an
  // account that's already bound to a different LINE user — it just
  // returns their applications below.
  if (body.line_user_id && candidate.line_user_id === null) {
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
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           a.interview_at        AS interview_at,
           a.interview_location  AS interview_location,
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
