// Approving / rejecting OT and shift-change requests from the LINE group (owner 2026-11-21).
// Same effect as the web routes (ot-requests/[id] PATCH without a time edit, shift-request/[id]/decide),
// plus a branch guard the OT web route does not have. Nothing here edits a pay-affecting time.

import { getDb, logPersonaAction } from "./db";
import { decideShiftRequest } from "./shift-requests";
import type { Actor } from "./leave-decide";

export type SimpleCheck =
  | { ok: true; branchId: number | null }
  | { ok: false; error: "not_found" | "branch_forbidden" | "already_decided" };

const inBranch = (actor: Actor, branchId: number | null) => branchId == null || actor.branchIds.includes(branchId);

// ── OT: a day's row has a late-end segment (status) and an early-start segment (early_status) ──

export function checkOtDecision(id: number, actor: Actor): SimpleCheck {
  const row = getDb().prepare("SELECT branch_id, status, requested_from, early_status FROM ot_requests WHERE id = ?").get(id) as
    { branch_id: number | null; status: string; requested_from: string | null; early_status: string | null } | undefined;
  if (!row) return { ok: false, error: "not_found" };
  if (!inBranch(actor, row.branch_id)) return { ok: false, error: "branch_forbidden" };
  const latePending = row.status === "pending";
  const earlyPending = row.requested_from != null && row.early_status === "pending";
  if (!latePending && !earlyPending) return { ok: false, error: "already_decided" };
  return { ok: true, branchId: row.branch_id };
}

/** Decides every segment that is still pending (a plain approve/reject, never a time edit). */
export function applyOtDecision(id: number, actor: Actor, decision: "approved" | "rejected"): void {
  const db = getDb();
  const now = new Date().toISOString();
  const verb = decision === "approved" ? "approve" : "reject";
  db.transaction(() => {
    const row = db.prepare("SELECT status, requested_from, early_status FROM ot_requests WHERE id = ?").get(id) as { status: string; requested_from: string | null; early_status: string | null };
    if (row.status === "pending") {
      db.prepare("UPDATE ot_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, actor.id, now, id);
      logPersonaAction(actor.id, `ot.${verb}.line_group`, id);
    }
    if (row.requested_from != null && row.early_status === "pending") {
      db.prepare("UPDATE ot_requests SET early_status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(decision, actor.id, now, id);
      logPersonaAction(actor.id, `ot.early_${verb}.line_group`, id);
    }
  })();
}

export function otInfo(id: number) {
  return getDb().prepare(`SELECT o.id, COALESCE(NULLIF(u.nickname_th,''), u.display_name) AS name, o.work_date AS workDate, o.requested_until AS until, o.requested_from AS \`from\`, o.status, o.early_status AS earlyStatus
    FROM ot_requests o JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(id) as { id: number; name: string; workDate: string; until: string; from: string | null; status: string; earlyStatus: string | null };
}

// ── shift-change requests ──

export function checkShiftDecision(id: number, actor: Actor): SimpleCheck {
  const row = getDb().prepare("SELECT branch_id, status FROM shift_change_requests WHERE id = ?").get(id) as { branch_id: number | null; status: string } | undefined;
  if (!row) return { ok: false, error: "not_found" };
  if (!inBranch(actor, row.branch_id)) return { ok: false, error: "branch_forbidden" };
  if (row.status !== "pending") return { ok: false, error: "already_decided" };
  return { ok: true, branchId: row.branch_id };
}

/** Records the decision and notifies the staff (approval only records; the roster is still edited by hand). */
export function applyShiftDecision(id: number, actor: Actor, decision: "approved" | "rejected"): boolean {
  const done = decideShiftRequest(actor.id, id, decision, null);
  if (done) logPersonaAction(actor.id, `shift_request.${decision}.line_group`, id);
  return done;
}

export function shiftInfo(id: number) {
  return getDb().prepare(`SELECT s.id, s.ref_no AS ref, COALESCE(NULLIF(u.nickname_th,''), u.display_name) AS name, s.kind, s.work_date AS workDate, s.off_date AS offDate
    FROM shift_change_requests s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id) as { id: number; ref: string | null; name: string; kind: string; workDate: string; offDate: string | null };
}
