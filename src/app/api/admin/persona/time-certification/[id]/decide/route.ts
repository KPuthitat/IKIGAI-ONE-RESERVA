import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { notifyTimeCertDecision } from "@/lib/time-cert-notify";

// POST /api/admin/persona/time-certification/[id]/decide
//
// Admin approves or rejects a staff's time-certification request.
// On approve:
//   1. UPDATE time_entries.ts to the proposed value
//   2. INSERT a row in time_entries_audit ('cert-approve', admin)
//   3. Mark the certification row 'approved'
// On reject:
//   1. Mark 'rejected' (decision_note optional)
//   2. The time_entries row is left untouched
//
// All three steps in (1) run inside a single SQLite transaction so
// the entry / audit / certification state can never split.

const Body = z.object({
  decision: z.enum(["approved", "rejected"]),
  decision_note: z.string().trim().max(500).optional()
});

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const certId = Number(params.id);
  if (!Number.isInteger(certId) || certId <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getDb();

  // Pull the cert + its underlying entry so we can branch-guard and
  // capture pre-update values for the audit row.
  const row = db.prepare(`
    SELECT c.id, c.entry_id, c.proposed_ts, c.status,
           e.user_id AS entry_user_id, e.type AS entry_type,
           e.ts AS entry_ts, e.branch_id AS entry_branch_id
    FROM time_certifications c
    JOIN time_entries e ON e.id = c.entry_id
    WHERE c.id = ?
  `).get(certId) as
    | {
        id: number; entry_id: number; proposed_ts: string; status: string;
        entry_user_id: number; entry_type: "in" | "out";
        entry_ts: string; entry_branch_id: number;
      }
    | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "already_decided", currentStatus: row.status },
      { status: 409 }
    );
  }
  // Admin can only act on entries from a branch they're assigned to.
  // userHasBranch guards admin scope to their branches (multi-branch
  // admin pattern used elsewhere in the app).
  if (!userHasBranch(user, row.entry_branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const nowIso = new Date().toISOString();
  const note = parsed.data.decision_note?.trim() || null;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE time_certifications
      SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?
      WHERE id = ?
    `).run(parsed.data.decision, user.id, nowIso, note, certId);

    if (parsed.data.decision === "approved") {
      // Audit the change so the original ts is recoverable if needed.
      db.prepare(`
        INSERT INTO time_entries_audit
          (entry_id, entry_user_id, entry_type, entry_ts, action,
           admin_id, reason, created_at)
        VALUES (?, ?, ?, ?, 'cert-approve', ?, ?, ?)
      `).run(
        row.entry_id, row.entry_user_id, row.entry_type, row.entry_ts,
        user.id,
        `cert#${certId}` + (note ? ` · ${note}` : ""),
        nowIso
      );
      db.prepare("UPDATE time_entries SET ts = ? WHERE id = ?")
        .run(row.proposed_ts, row.entry_id);
    }
  });
  tx();

  logPersonaAction(
    user.id,
    parsed.data.decision === "approved"
      ? "time_certification.approve"
      : "time_certification.reject",
    certId
  );

  // Push a LINE message to the requester so they don't have to
  // re-check the persona menu to discover the outcome. Fire-and-
  // forget — a notification failure is not worth surfacing here
  // (admin's decision already landed in the DB). The helper logs
  // its own warnings.
  notifyTimeCertDecision({
    certId,
    decision: parsed.data.decision,
    decisionNote: note
  }).catch((e) => console.warn("[time-cert] notify failed:", e));

  return NextResponse.json({ ok: true, decision: parsed.data.decision });
}
