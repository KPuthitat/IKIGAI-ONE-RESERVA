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
import { notifyHrShiftRequest } from "./approval-notify";
import { nameWithPrefix } from "./name";

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
  // Staff-chosen slot for an extra shift (owner 2026-07-31) — nullable.
  position_id: number | null;
  shift_code_id: number | null;
};

/** Extra display fields joined for the request lists (position + shift labels). */
export type ShiftRequestLabels = {
  position_title: string | null;
  shift_code: string | null;
  shift_name: string | null;
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
  data: {
    kind: ShiftRequestKind; work_date: string; off_date: string | null; note: string | null;
    // Staff-chosen slot — only meaningful for extra_shift (owner 2026-07-31).
    position_id?: number | null; shift_code_id?: number | null;
  }
): { id: number; ref_no: string } {
  const db = getDb();
  const posId = data.kind === "extra_shift" ? (data.position_id ?? null) : null;
  const shiftId = data.kind === "extra_shift" ? (data.shift_code_id ?? null) : null;
  const info = db.prepare(`
    INSERT INTO shift_change_requests
      (user_id, branch_id, kind, work_date, off_date, note, position_id, shift_code_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(
    actor.id, actor.activeBranchId ?? null, data.kind,
    data.work_date, data.kind === "swap" ? data.off_date : null, data.note,
    posId, shiftId
  );
  const id = Number(info.lastInsertRowid);
  const ref_no = `SC${bkkMonth()}-${id}`;
  db.prepare("UPDATE shift_change_requests SET ref_no = ? WHERE id = ?").run(ref_no, id);

  // Notify the requester's direct manager (if any) so they can review.
  const mgr = db.prepare(
    "SELECT reports_to_user_id FROM users WHERE id = ?"
  ).get(actor.id) as { reports_to_user_id: number | null } | undefined;
  const me = db.prepare("SELECT display_name, title_prefix FROM users WHERE id = ?")
    .get(actor.id) as { display_name: string; title_prefix: string | null } | undefined;
  // Owner 2026-06-06: shift-change is personal — notify requester (DM)
  // + HR group only. Do NOT DM the manager separately; managers are in
  // the HR group and will see the request there.
  const myName = nameWithPrefix(me?.title_prefix ?? null, me?.display_name ?? "พนักงาน");
  void notifyHrShiftRequest({
    name: myName,
    refNo: ref_no,
    kind: data.kind,
    workDate: data.work_date,
    offDate: data.off_date ?? null
  }).catch((e) => console.warn("[shift-req] HR notify failed", e));
  // DM the requester — acknowledgement that their request was received.
  const kindLabel = KIND_TH[data.kind];
  const when = data.kind === "swap"
    ? `หยุด ${data.off_date} ทำงานแทน ${data.work_date}`
    : `ทำงานเพิ่ม ${data.work_date}`;
  pushToUser(
    actor.id,
    `คำขอเปลี่ยนเวลางาน${kindLabel ? " (" + kindLabel + ")" : ""} ${ref_no ? "[" + ref_no + "]" : ""}\n${when}\nส่งคำขอแล้ว — รอหัวหน้างานอนุมัติในกลุ่ม HR`
  );
  return { id, ref_no };
}

/** A staff member's own requests (newest first). */
export function listMyShiftRequests(userId: number): Array<ShiftRequestRow & ShiftRequestLabels> {
  return getDb().prepare(`
    SELECT r.*, p.title AS position_title, sc.code AS shift_code, sc.name AS shift_name
    FROM shift_change_requests r
    LEFT JOIN roster_positions p ON p.id = r.position_id
    LEFT JOIN shift_codes sc ON sc.id = r.shift_code_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 100
  `).all(userId) as Array<ShiftRequestRow & ShiftRequestLabels>;
}

/** Pending requests for a branch — drives the admin review list. */
export function listPendingShiftRequests(branchId: number): Array<ShiftRequestRow & ShiftRequestLabels & {
  employee_name: string; title_prefix: string | null; employment_type: string | null;
}> {
  return getDb().prepare(`
    SELECT r.*, u.display_name AS employee_name, u.title_prefix, u.employment_type,
           p.title AS position_title, sc.code AS shift_code, sc.name AS shift_name
    FROM shift_change_requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN roster_positions p ON p.id = r.position_id
    LEFT JOIN shift_codes sc ON sc.id = r.shift_code_id
    WHERE r.branch_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all(branchId) as Array<ShiftRequestRow & ShiftRequestLabels & {
    employee_name: string; title_prefix: string | null; employment_type: string | null;
  }>;
}

/** Decided (approved/rejected/cancelled) requests for a branch — the
 *  history view (owner 2026-06-17). Newest decision first; the client
 *  groups them by month + day. Joined with the decider's name. */
export function listDecidedShiftRequests(branchId: number, limit = 300): Array<ShiftRequestRow & ShiftRequestLabels & {
  employee_name: string; title_prefix: string | null; employment_type: string | null;
  decided_by_name: string | null;
}> {
  return getDb().prepare(`
    SELECT r.*, u.display_name AS employee_name, u.title_prefix, u.employment_type,
           du.display_name AS decided_by_name,
           p.title AS position_title, sc.code AS shift_code, sc.name AS shift_name
    FROM shift_change_requests r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users du ON du.id = r.decided_by
    LEFT JOIN roster_positions p ON p.id = r.position_id
    LEFT JOIN shift_codes sc ON sc.id = r.shift_code_id
    WHERE r.branch_id = ? AND r.status != 'pending'
    ORDER BY COALESCE(r.decided_at, r.created_at) DESC
    LIMIT ?
  `).all(branchId, limit) as Array<ShiftRequestRow & ShiftRequestLabels & {
    employee_name: string; title_prefix: string | null; employment_type: string | null;
    decided_by_name: string | null;
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
