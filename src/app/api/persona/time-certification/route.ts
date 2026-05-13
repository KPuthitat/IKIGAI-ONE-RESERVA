import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/persona/time-certification
//
// Staff files a certification request for a past clock entry that's
// outside the 5-minute self-correction window. They supply:
//   • entry_id      — the time_entries row to fix
//   • proposed_ts   — the time it should have been (ISO)
//   • reason        — free text shown to admin
//
// On approval (a separate admin endpoint) the entry's `ts` is
// UPDATEd to proposed_ts and a row lands in time_entries_audit so
// the change is traceable.
//
// Guards:
//   • Only the entry's owner can request certification for it.
//   • No double-up — if a pending request already exists for the
//     same entry, reject with 409 so the inbox doesn't fill with
//     duplicates from impatient retries.

const Body = z.object({
  entry_id: z.number().int().positive(),
  proposed_ts: z.string().datetime(),
  reason: z.string().trim().min(3).max(500)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const db = getDb();
  const entry = db.prepare(
    "SELECT id, user_id, ts FROM time_entries WHERE id = ?"
  ).get(parsed.data.entry_id) as
    | { id: number; user_id: number; ts: string }
    | undefined;

  if (!entry) {
    return NextResponse.json({ error: "entry_not_found" }, { status: 404 });
  }
  if (entry.user_id !== user.id) {
    // Don't reveal the entry exists — same as 404 from the caller's
    // perspective. Staff can only certify their own entries.
    return NextResponse.json({ error: "entry_not_found" }, { status: 404 });
  }

  const existingPending = db.prepare(`
    SELECT id FROM time_certifications
    WHERE entry_id = ? AND status = 'pending'
  `).get(entry.id) as { id: number } | undefined;
  if (existingPending) {
    return NextResponse.json(
      { error: "already_pending", existingId: existingPending.id },
      { status: 409 }
    );
  }

  const nowIso = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO time_certifications
      (entry_id, requested_by, reason, proposed_ts, original_ts,
       status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(entry.id, user.id, parsed.data.reason, parsed.data.proposed_ts,
        entry.ts, nowIso);

  logPersonaAction(user.id, "time_certification.request", entry.id);

  return NextResponse.json({
    ok: true,
    id: result.lastInsertRowid
  });
}
