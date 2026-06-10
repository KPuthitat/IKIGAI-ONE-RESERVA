import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { notifyTimeCertDecision } from "@/lib/time-cert-notify";
import { recomputeLine } from "@/lib/payroll-compute";

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
  decision_note: z.string().trim().max(500).optional(),
  // Admin may adjust the time before approving — covers certs where the
  // staff left the proposed time unchanged or typed it wrong (owner
  // 2026-06-09). When present, this ISO instant is applied instead of the
  // cert's proposed_ts (create for 'missing', set ts for 'correction').
  override_ts: z.string().datetime().optional()
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
  // LEFT JOIN — a 'missing' cert has no entry yet (entry_id NULL); its
  // punch is described by the cert columns and CREATED on approval.
  const row = db.prepare(`
    SELECT c.id, c.entry_id, c.proposed_ts, c.status, c.kind, c.requested_by,
           c.entry_type AS cert_entry_type, c.work_date, c.branch_id AS cert_branch_id,
           e.user_id AS entry_user_id, e.type AS entry_type,
           e.ts AS entry_ts, e.branch_id AS entry_branch_id
    FROM time_certifications c
    LEFT JOIN time_entries e ON e.id = c.entry_id
    WHERE c.id = ?
  `).get(certId) as
    | {
        id: number; entry_id: number | null; proposed_ts: string; status: string;
        kind: "correction" | "missing"; requested_by: number;
        cert_entry_type: "in" | "out" | null; work_date: string | null; cert_branch_id: number | null;
        entry_user_id: number | null; entry_type: "in" | "out" | null;
        entry_ts: string | null; entry_branch_id: number | null;
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
  // For a missing cert the branch lives on the cert row; for a correction
  // it lives on the underlying entry.
  const guardBranch = row.kind === "missing" ? row.cert_branch_id : row.entry_branch_id;
  if (guardBranch != null && !userHasBranch(user, guardBranch)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const nowIso = new Date().toISOString();
  const note = parsed.data.decision_note?.trim() || null;
  // Effective time to apply — admin's override wins over the staff's proposal.
  const effectiveTs = parsed.data.override_ts ?? row.proposed_ts;
  const adjusted = parsed.data.override_ts != null && parsed.data.override_ts !== row.proposed_ts;
  const adjNote = adjusted ? " · เวลาปรับโดยผู้อนุมัติ" : "";

  // Defensive: approving a 'missing' cert CREATES a punch from cert_entry_type.
  // If that's somehow not 'in'/'out' we'd insert a NULL-type entry that the
  // timesheet + payroll can't read — exactly the "ไม่มีสักที่เลย" failure.
  // Refuse instead of writing a broken row.
  if (
    parsed.data.decision === "approved" &&
    row.kind === "missing" &&
    row.cert_entry_type !== "in" &&
    row.cert_entry_type !== "out"
  ) {
    return NextResponse.json({ error: "cert_missing_entry_type" }, { status: 422 });
  }

  const tx = db.transaction(() => {
    // Persist the applied time on the cert too, so staff history + the
    // audit reflect what was actually recorded (not the stale proposal).
    db.prepare(`
      UPDATE time_certifications
      SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?,
          proposed_ts = ?
      WHERE id = ?
    `).run(parsed.data.decision, user.id, nowIso, note, effectiveTs, certId);

    if (parsed.data.decision === "approved") {
      if (row.kind === "missing") {
        // CREATE the punch they forgot to record (owner 2026-06-08).
        const res = db.prepare(
          "INSERT INTO time_entries (user_id, type, ts, branch_id) VALUES (?, ?, ?, ?)"
        ).run(row.requested_by, row.cert_entry_type, effectiveTs, row.cert_branch_id);
        const newId = Number(res.lastInsertRowid);
        db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action,
             admin_id, reason, created_at)
          VALUES (?, ?, ?, ?, 'create', ?, ?, ?)
        `).run(
          newId, row.requested_by, row.cert_entry_type, effectiveTs,
          user.id, `cert#${certId} · เพิ่มเวลาที่ลืมลง${adjNote}` + (note ? ` · ${note}` : ""), nowIso
        );
        // Link the cert to the created entry for traceability.
        db.prepare("UPDATE time_certifications SET entry_id = ? WHERE id = ?").run(newId, certId);
      } else {
        // CORRECT an existing entry's timestamp. Audit so the original ts
        // is recoverable.
        db.prepare(`
          INSERT INTO time_entries_audit
            (entry_id, entry_user_id, entry_type, entry_ts, action,
             admin_id, reason, created_at)
          VALUES (?, ?, ?, ?, 'cert-approve', ?, ?, ?)
        `).run(
          row.entry_id, row.entry_user_id, row.entry_type, row.entry_ts,
          user.id, `cert#${certId}${adjNote}` + (note ? ` · ${note}` : ""), nowIso
        );
        db.prepare("UPDATE time_entries SET ts = ? WHERE id = ?")
          .run(effectiveTs, row.entry_id);
      }
    }
  });
  tx();

  // The certified time changed time_entries, but payroll lines are a
  // STORED snapshot — so refresh any DRAFT payroll period covering that
  // date for this employee, otherwise the corrected clock never reaches
  // payroll (owner 2026-06-08: "รับรองเวลาแล้วไม่ขึ้นในระบบเงินเดือน").
  // recomputeLine opens its own transaction, so it runs AFTER the cert tx
  // commits. It throws for finalized periods (admin must reopen) and for
  // users with no line in the period — both are safely ignored here.
  if (parsed.data.decision === "approved") {
    try {
      const dateBkk = new Date(new Date(effectiveTs).getTime() + 7 * 3600_000)
        .toISOString().slice(0, 10);
      const periods = db.prepare(`
        SELECT id FROM payroll_periods
        WHERE status = 'draft' AND period_start <= ? AND period_end >= ?
      `).all(dateBkk, dateBkk) as Array<{ id: number }>;
      for (const p of periods) {
        try { recomputeLine(db, p.id, row.requested_by); }
        catch { /* line_not_found / period_not_draft — skip */ }
      }
    } catch (e) {
      console.warn("[time-cert] payroll recompute after approve failed:", e);
    }
  }

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
