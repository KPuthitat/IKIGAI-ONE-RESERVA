import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import type { ApplicationStage } from "@/lib/recruita";

// POST /api/recruita/my-applications
//
// Public lookup endpoint used by the candidate-facing /recruita/status
// page. The candidate authenticated through LIFF (LINE's in-app
// browser) and we pass their line_user_id here. We return every
// application tied to that LINE account — across positions and
// branches — so the candidate can see what the company has done with
// each submission.
//
// We trust line_user_id from the client because:
//   1. Inside LIFF, LINE proves the userId via the access token before
//      the SDK hands it to us. A spoofed userId in a normal browser
//      simply matches nothing (no row in recruita_candidates →
//      empty list).
//   2. The data returned is the candidate's own — stage/title/branch
//      of their own applications. Worst case a curious party guesses
//      another userId and sees what stage that candidate is at, with
//      no PII (no name, email, phone, national id).
//
// Returns { ok, applications: [...] }. Never returns 4xx for "not
// found" — the page renders an empty state instead, which is
// friendlier than an error.

const BodySchema = z.object({
  line_user_id: z.string().min(1).max(64)
});

type Row = {
  application_id: number;
  stage: ApplicationStage;
  submitted_at: string;
  day_seq: number;
  position_title: string;
  position_code: string | null;
  branch_name: string | null;
  department: string | null;
  /** Current interview booking (naive Bangkok-local), null if unbooked.
   *  Drives the self-service slot picker on the status page. */
  interview_at: string | null;
  interview_location: string | null;
  /** Offer detail — shown on the status card at the 'offered' stage so the
   *  candidate can accept/reject an informed offer (owner 2026-06-15). */
  offer_salary: number | null;
  offer_salary_type: "monthly" | "hourly" | null;
  offer_start_date: string | null;
};

export async function POST(req: Request) {
  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }

  const db = getDb();
  const rows = db.prepare(`
    SELECT a.id            AS application_id,
           a.stage         AS stage,
           a.submitted_at  AS submitted_at,
           (SELECT COUNT(*) FROM recruita_applications za
             WHERE date(za.submitted_at, '+7 hours') = date(a.submitted_at, '+7 hours')
               AND za.id <= a.id) AS day_seq,
           a.interview_at        AS interview_at,
           a.interview_location  AS interview_location,
           a.offer_salary        AS offer_salary,
           a.offer_salary_type   AS offer_salary_type,
           a.offer_start_date    AS offer_start_date,
           p.title         AS position_title,
           p.code          AS position_code,
           p.department    AS department,
           b.name          AS branch_name
    FROM recruita_candidates c
    JOIN recruita_applications a ON a.candidate_id = c.id
    JOIN recruita_positions p    ON p.id = a.position_id
    LEFT JOIN branches b         ON b.id = p.branch_id
    WHERE c.line_user_id = ?
    ORDER BY a.submitted_at DESC
  `).all(body.line_user_id) as Row[];

  return NextResponse.json({ ok: true, applications: rows });
}
