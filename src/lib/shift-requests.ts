// Shift-change requests (owner 2026-06-05) — staff ask to add a working
// day (PT extra shift) or swap a day off for another (FT taking a day off
// without spending leave). v1 is RECORD + NOTIFY only: approval does not
// touch the roster or pay engine — an admin reflects it in the roster
// manually. Approval is by the same people who approve leave (a branch
// supervisor / admin); for v1 we keep the lifecycle simple (pending →
// approved/rejected/cancelled) without the leave system's escalation
// cron — the request shows in the admin review list until actioned.

import { getDb } from "./db";
import { sendLinePush } from "./line";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";

export type ShiftRequestKind = "extra_shift" | "swap";
export type ShiftRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

export type ShiftRequestRow = {
  id: number;
  user_id: number;
  branch_id: number | null;
  kind: ShiftRequestKind;
  work_date: string;
  off_date: string | null;
  note: string | null;
  status: ShiftRequestStatus;
  ref_no: string | null;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

const KIND_TH: Record<ShiftRequestKind, string> = {
  extra_shift: "ขอเพิ่มกะ",
  swap: "ขอสลับวันหยุด"
};

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7).replace("-", "");
}

/** Best-effort LINE push to a single user's bound LINE id via the platform OA. */
function pushToUser(userId: number, text: string): void {
  try {
    const row = getDb().prepare("SELECT line_user_id FROM users WHERE id = ?")
      .get(userId) as { line_user_id: string | null } | undefined;
    const to = row?.line_user_id;
    if (!to) return;
    const ch = getPlatformChannel();
    if (!isChannelReady(ch) || !ch?.channel_token) return;
    void sendLinePush(ch.channel_token, { to, messages: [{ type: "text", text }] })
      .catch((e) => console.warn("[shift-req] push failed", e));
  } catch (e) {
    console.warn("[shift-req] push threw", e);
  }
}

/** Create a pending shift-change request + notify the staff's manager. */
export function createShiftRequest(
  actor: { id: number; activeBranchId: number | null },
  data: { kind: ShiftRequestKind; work_date: string; off_date: string | null; note: string | null }
): { id: number; ref_no: string } {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO shift_change_requests
      (user_id, branch_id, kind, work_date, off_date, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(
    actor.id, actor.activeBranchId ?? null, data.kind,
    data.work_date, data.kind === "swap" ? data.off_date : null, data.note
  );
  const id = Number(info.lastInsertRowid);
  const ref_no = `SC${bkkMonth()}-${id}`;
  db.prepare("UPDATE shift_change_requests SET ref_no = ? WHERE id = ?").run(ref_no, id);

  // Notify the requester's direct manager (if any) so they can review.
  const mgr = db.prepare(
    "SELECT reports_to_user_id FROM users WHERE id = ?"
  ).get(actor.id) as { reports_to_user_id: number | null } | undefined;
  const me = db.prepare("SELECT display_name FROM users WHERE id = ?")
    .get(actor.id) as { display_name: string } | undefined;
  if (mgr?.reports_to_user_id) {
    const label = KIND_TH[data.kind];
    const when = data.kind === "swap"
      ? `หยุด ${data.off_date} ทำงานแทน ${data.work_date}`
      : `ทำงานเพิ่ม ${data.work_date}`;
    pushToUser(
      mgr.reports_to_user_id,
      `คำร้อง${label} (${ref_no})\nจาก: ${me?.display_name ?? "พนักงาน"}\n${when}\n\nเปิดอนุมัติที่เมนู PERSONA → คำร้องกะ`
    );
  }
  return { id, ref_no };
}

/** A staff member's own requests (newest first). */
export function listMyShiftRequests(userId: number): ShiftRequestRow[] {
  return getDb().prepare(
    "SELECT * FROM shift_change_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
  ).all(userId) as ShiftRequestRow[];
}

/** Pending requests for a branch — drives the admin review list. */
export function listPendingShiftRequests(branchId: number): Array<ShiftRequestRow & {
  employee_name: string; title_prefix: string | null; employment_type: string | null;
}> {
  return getDb().prepare(`
    SELECT r.*, u.display_name AS employee_name, u.title_prefix, u.employment_type
    FROM shift_change_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.branch_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all(branchId) as Array<ShiftRequestRow & {
    employee_name: string; title_prefix: string | null; employment_type: string | null;
  }>;
}

/** Approve / reject a request + notify the requester. Returns false when
 *  the request isn't found or is no longer pending. */
export function decideShiftRequest(
  adminId: number, id: number, decision: "approved" | "rejected", note: string | null
): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT user_id, status, kind, work_date, off_date, ref_no FROM shift_change_requests WHERE id = ?"
  ).get(id) as Pick<ShiftRequestRow, "user_id" | "status" | "kind" | "work_date" | "off_date" | "ref_no"> | undefined;
  if (!row || row.status !== "pending") return false;
  db.prepare(`
    UPDATE shift_change_requests
    SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?
    WHERE id = ?
  `).run(decision, adminId, note, id);

  const label = KIND_TH[row.kind];
  const verdict = decision === "approved" ? "อนุมัติแล้ว ✓" : "ไม่อนุมัติ";
  pushToUser(
    row.user_id,
    `คำร้อง${label} (${row.ref_no}) — ${verdict}${note ? `\nหมายเหตุ: ${note}` : ""}`
  );
  return true;
}

/** Staff cancels their own still-pending request. */
export function cancelShiftRequest(userId: number, id: number): boolean {
  const db = getDb();
  const row = db.prepare(
    "SELECT user_id, status FROM shift_change_requests WHERE id = ?"
  ).get(id) as { user_id: number; status: string } | undefined;
  if (!row || row.user_id !== userId || row.status !== "pending") return false;
  db.prepare("UPDATE shift_change_requests SET status = 'cancelled' WHERE id = ?").run(id);
  return true;
}

export function shiftRequestKindLabel(kind: ShiftRequestKind): string {
  return KIND_TH[kind];
}
