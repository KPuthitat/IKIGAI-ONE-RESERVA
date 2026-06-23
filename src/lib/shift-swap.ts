// Same-day peer shift swap (owner 2026-06-23). Staff A trades their shift with
// staff B on the SAME day — B taps "accept" and the two roster_assignments rows
// swap user_id atomically. NO admin approval (the supervisor isn't in the loop).
//
// Scope guard: both A and B must have EXACTLY ONE work shift on that date, so
// the swap is unambiguous (the common case: each person works one shift/day).
// If either has multiple shifts that day we block and tell them to ask an admin.

import { getDb } from "./db";
import { sendLinePush } from "./line";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { nameWithPrefix } from "./name";

export type SwapStatus = "pending" | "accepted" | "declined" | "cancelled";

export type SwapRow = {
  id: number;
  branch_id: number;
  swap_date: string;
  initiator_user_id: number;
  target_user_id: number;
  initiator_shift: string | null;
  target_shift: string | null;
  note: string | null;
  status: SwapStatus;
  ref_no: string | null;
  decided_at: string | null;
  created_at: string;
};

export type SwapCandidate = { userId: number; name: string; shiftLabel: string };

function bkkMonth(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7).replace("-", "");
}

/** Best-effort LINE DM to a single user via the platform OA (same as shift-requests). */
function pushToUser(userId: number, text: string): void {
  try {
    const row = getDb().prepare("SELECT line_user_id FROM users WHERE id = ?")
      .get(userId) as { line_user_id: string | null } | undefined;
    const to = row?.line_user_id;
    if (!to) return;
    const ch = getPlatformChannel();
    if (!isChannelReady(ch) || !ch?.channel_token) return;
    void sendLinePush(ch.channel_token, { to, messages: [{ type: "text", text }] })
      .catch((e) => console.warn("[shift-swap] push failed", e));
  } catch (e) {
    console.warn("[shift-swap] push threw", e);
  }
}

function nameOf(userId: number): string {
  const u = getDb().prepare("SELECT display_name, title_prefix FROM users WHERE id = ?")
    .get(userId) as { display_name: string; title_prefix: string | null } | undefined;
  return nameWithPrefix(u?.title_prefix ?? null, u?.display_name ?? "พนักงาน");
}

type WorkAssignment = { id: number; shiftLabel: string; startTime: string };

/** A user's WORK roster rows on a date, each with a "HH:MM–HH:MM (CODE)" label. */
function workAssignmentsOnDate(userId: number, branchId: number, date: string): WorkAssignment[] {
  const rows = getDb().prepare(`
    SELECT a.id, s.start_time, s.end_time, s.code
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.user_id = ? AND a.branch_id = ? AND a.assignment_date = ? AND s.kind = 'work'
    ORDER BY s.start_time ASC
  `).all(userId, branchId, date) as Array<{ id: number; start_time: string; end_time: string; code: string }>;
  return rows.map((r) => ({ id: r.id, startTime: r.start_time, shiftLabel: `${r.start_time}–${r.end_time} (${r.code})` }));
}

/** Other staff who have a work shift on `date` — the people A can swap with. */
export function listSwapCandidates(branchId: number, date: string, excludeUserId: number): SwapCandidate[] {
  const rows = getDb().prepare(`
    SELECT a.user_id,
           u.display_name, u.title_prefix,
           MIN(s.start_time) AS start_time, MAX(s.end_time) AS end_time,
           GROUP_CONCAT(DISTINCT s.code) AS codes,
           COUNT(*) AS n
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    JOIN users u ON u.id = a.user_id
    WHERE a.branch_id = ? AND a.assignment_date = ? AND s.kind = 'work' AND a.user_id != ?
    GROUP BY a.user_id
    ORDER BY start_time ASC, u.display_name ASC
  `).all(branchId, date, excludeUserId) as Array<{
    user_id: number; display_name: string; title_prefix: string | null;
    start_time: string; end_time: string; codes: string; n: number;
  }>;
  // Only single-shift people are swappable (the guard mirrors createSwapRequest).
  return rows.filter((r) => r.n === 1).map((r) => ({
    userId: r.user_id,
    name: nameWithPrefix(r.title_prefix, r.display_name),
    shiftLabel: `${r.start_time}–${r.end_time} (${r.codes})`
  }));
}

/** My own single work shift on a date, or a reason it can't be swapped. */
export function myShiftOnDate(userId: number, branchId: number, date: string):
  | { ok: true; assignment: WorkAssignment }
  | { ok: false; reason: "no_shift" | "multiple" } {
  const mine = workAssignmentsOnDate(userId, branchId, date);
  if (mine.length === 0) return { ok: false, reason: "no_shift" };
  if (mine.length > 1) return { ok: false, reason: "multiple" };
  return { ok: true, assignment: mine[0] };
}

export type CreateSwapResult =
  | { ok: true; id: number; ref_no: string }
  | { ok: false; error: "self" | "initiator_no_shift" | "initiator_multiple" | "target_no_shift" | "target_multiple" | "duplicate" };

/** Create a pending swap request + DM the target. Both parties must have exactly
 *  one work shift on `date`. */
export function createSwapRequest(
  actor: { id: number; activeBranchId: number | null },
  data: { date: string; targetUserId: number; note: string | null }
): CreateSwapResult {
  const branchId = actor.activeBranchId;
  if (branchId == null) return { ok: false, error: "initiator_no_shift" };
  if (data.targetUserId === actor.id) return { ok: false, error: "self" };

  const mine = myShiftOnDate(actor.id, branchId, data.date);
  if (!mine.ok) return { ok: false, error: mine.reason === "no_shift" ? "initiator_no_shift" : "initiator_multiple" };
  const theirs = myShiftOnDate(data.targetUserId, branchId, data.date);
  if (!theirs.ok) return { ok: false, error: theirs.reason === "no_shift" ? "target_no_shift" : "target_multiple" };

  const db = getDb();
  const dup = db.prepare(`
    SELECT id FROM shift_swap_requests
    WHERE initiator_user_id = ? AND target_user_id = ? AND swap_date = ? AND status = 'pending'
  `).get(actor.id, data.targetUserId, data.date);
  if (dup) return { ok: false, error: "duplicate" };

  const info = db.prepare(`
    INSERT INTO shift_swap_requests
      (branch_id, swap_date, initiator_user_id, target_user_id, initiator_shift, target_shift, note, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(branchId, data.date, actor.id, data.targetUserId, mine.assignment.shiftLabel, theirs.assignment.shiftLabel, data.note);
  const id = Number(info.lastInsertRowid);
  const ref_no = `SW${bkkMonth()}-${id}`;
  db.prepare("UPDATE shift_swap_requests SET ref_no = ? WHERE id = ?").run(ref_no, id);

  pushToUser(
    data.targetUserId,
    `ขอสลับกะ [${ref_no}]\n${nameOf(actor.id)} ขอสลับกะวันที่ ${data.date}\n• ของคุณ: ${theirs.assignment.shiftLabel}\n• ของเขา: ${mine.assignment.shiftLabel}${data.note ? `\nหมายเหตุ: ${data.note}` : ""}\n\nเปิดแอป IKIGAI OS → สลับกะกับเพื่อน เพื่อกดรับหรือปฏิเสธ`
  );
  return { ok: true, id, ref_no };
}

export type RespondResult =
  | { ok: true; action: "accepted" | "declined" }
  | { ok: false; error: "not_found" | "not_target" | "not_pending" | "roster_changed" };

/** Target accepts (→ atomic roster swap) or declines. */
export function respondSwap(targetUserId: number, id: number, action: "accept" | "decline"): RespondResult {
  const db = getDb();
  const req = db.prepare("SELECT * FROM shift_swap_requests WHERE id = ?").get(id) as SwapRow | undefined;
  if (!req) return { ok: false, error: "not_found" };
  if (req.target_user_id !== targetUserId) return { ok: false, error: "not_target" };
  if (req.status !== "pending") return { ok: false, error: "not_pending" };

  if (action === "decline") {
    db.prepare("UPDATE shift_swap_requests SET status = 'declined', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    pushToUser(req.initiator_user_id, `ขอสลับกะ [${req.ref_no}] — ${nameOf(targetUserId)} ปฏิเสธคำขอสลับกะวันที่ ${req.swap_date}`);
    return { ok: true, action: "declined" };
  }

  // Accept: re-resolve both shifts now (roster may have changed since the ask).
  const a = myShiftOnDate(req.initiator_user_id, req.branch_id, req.swap_date);
  const b = myShiftOnDate(req.target_user_id, req.branch_id, req.swap_date);
  if (!a.ok || !b.ok) return { ok: false, error: "roster_changed" };

  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare("UPDATE roster_assignments SET user_id = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(req.target_user_id, targetUserId, nowIso, a.assignment.id);   // A's old slot → B
    db.prepare("UPDATE roster_assignments SET user_id = ?, updated_by = ?, updated_at = ? WHERE id = ?")
      .run(req.initiator_user_id, targetUserId, nowIso, b.assignment.id); // B's old slot → A
    db.prepare("UPDATE shift_swap_requests SET status = 'accepted', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  });
  tx();

  // After the swap: A now works B's old shift, B works A's old shift.
  pushToUser(req.initiator_user_id, `ขอสลับกะ [${req.ref_no}] — ${nameOf(targetUserId)} กดรับแล้ว ✓\nวันที่ ${req.swap_date} คุณเข้ากะ ${b.assignment.shiftLabel}`);
  pushToUser(req.target_user_id, `สลับกะสำเร็จ [${req.ref_no}] ✓\nวันที่ ${req.swap_date} คุณเข้ากะ ${a.assignment.shiftLabel}`);
  return { ok: true, action: "accepted" };
}

/** Initiator cancels their own still-pending request. */
export function cancelSwap(userId: number, id: number): boolean {
  const db = getDb();
  const row = db.prepare("SELECT initiator_user_id, status FROM shift_swap_requests WHERE id = ?")
    .get(id) as { initiator_user_id: number; status: string } | undefined;
  if (!row || row.initiator_user_id !== userId || row.status !== "pending") return false;
  db.prepare("UPDATE shift_swap_requests SET status = 'cancelled', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  return true;
}

export type SwapRowWithNames = SwapRow & { initiator_name: string; target_name: string };

function joinNames(rows: SwapRow[]): SwapRowWithNames[] {
  return rows.map((r) => ({ ...r, initiator_name: nameOf(r.initiator_user_id), target_name: nameOf(r.target_user_id) }));
}

/** Pending swaps waiting for ME to accept/decline. */
export function listIncomingSwaps(userId: number): SwapRowWithNames[] {
  const rows = getDb().prepare(
    "SELECT * FROM shift_swap_requests WHERE target_user_id = ? AND status = 'pending' ORDER BY created_at DESC"
  ).all(userId) as SwapRow[];
  return joinNames(rows);
}

/** Swaps I initiated (any status), newest first. */
export function listMySentSwaps(userId: number): SwapRowWithNames[] {
  const rows = getDb().prepare(
    "SELECT * FROM shift_swap_requests WHERE initiator_user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(userId) as SwapRow[];
  return joinNames(rows);
}
