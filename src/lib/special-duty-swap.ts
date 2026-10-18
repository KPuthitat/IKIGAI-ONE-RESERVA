// ตำแหน่งงานค่าตอบแทนพิเศษ — swapping duty days (owner 2026-10-11).
//
// A holder (A) offers one of their days for a day held by a colleague (B) of the same
// branch. B accepts, then the manager approves; only then do the two rows change hands,
// so nothing moves on a promise. Everything is re-checked at each step against the same
// rules as a booking: the new holder must be on the roster that day, not on approved
// leave, in the position's work group, and within the per-day limit. A swap must be
// asked for at least special_duty_config.swap_notice_days before the EARLIER of the two
// days, and only for days still waiting to be done (booked / assigned).

import { getDb } from "./db";
import { audit, cfgNum, getMonth } from "./special-duty";
import { isGroupEligible, isOnApprovedLeave, isOnRoster } from "./special-duty-rules";
import { sqlNameWithPrefix } from "./name";

export type SwapErrorCode =
  | "not_found" | "forbidden" | "wrong_stage" | "same_person" | "day_not_swappable" | "too_late" | "pair_invalid"
  | "already_pending" | "wrong_status" | "note_required" | "not_eligible";

export class SwapError extends Error { constructor(public code: SwapErrorCode, public detail?: string) { super(code); } }

const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WORKING = ["special_published", "in_progress"];

type DayRow = { id: number; position_id: number; duty_date: string; user_id: number; status: string; performer_user_id: number | null;
  branch_id: number; year_month: string; pname: string; eligible_groups: string | null };

function loadDay(dayId: number): DayRow {
  const r = getDb().prepare(`
    SELECT d.id, d.position_id, d.duty_date, d.user_id, d.status, d.performer_user_id,
           p.branch_id, p.year_month, p.name AS pname, p.eligible_groups
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ?
  `).get(dayId) as DayRow | undefined;
  if (!r) throw new SwapError("not_found");
  return r;
}

/** Would `userId` be allowed to hold `target` (a day they do not hold now) if `giving` (their own day) is released? */
function canTake(userId: number, target: DayRow, giving: DayRow): boolean {
  const u = getDb().prepare("SELECT department, status FROM users WHERE id = ?").get(userId) as { department: string | null; status: string } | undefined;
  if (!u || ["disabled", "resigned", "terminated"].includes(u.status)) return false;
  const groups = target.eligible_groups ? JSON.parse(target.eligible_groups) : null;
  if (!isGroupEligible({ department: u.department }, { eligibleGroups: groups } as never)) return false;
  if (!isOnRoster(userId, target.branch_id, target.duty_date) || isOnApprovedLeave(userId, target.duty_date)) return false;
  const others = (getDb().prepare(`SELECT COUNT(*) n FROM special_duty_days WHERE duty_date = ? AND id != ? AND id != ? AND status != 'absent' AND COALESCE(performer_user_id, user_id) = ?`)
    .get(target.duty_date, target.id, giving.id, userId) as { n: number }).n;
  return others + 1 <= cfgNum("max_positions_per_person_per_day", target.branch_id);
}

/** Everything that must hold for the pair to be traded right now (null = fine). */
function pairProblem(a: DayRow, b: DayRow, today: string): SwapErrorCode | null {
  if (a.branch_id !== b.branch_id) return "pair_invalid";
  if (a.user_id === b.user_id) return "same_person";
  for (const d of [a, b]) if (!["booked", "assigned"].includes(d.status) || d.performer_user_id != null) return "day_not_swappable";
  const m = getMonth(a.branch_id, a.year_month);
  if (!m.enabled || !WORKING.includes(m.status) || a.year_month !== b.year_month) return "wrong_stage";
  const earliest = a.duty_date < b.duty_date ? a.duty_date : b.duty_date;
  if (today > addDays(earliest, -cfgNum("swap_notice_days", a.branch_id))) return "too_late";
  if (!canTake(a.user_id, b, a) || !canTake(b.user_id, a, b)) return "not_eligible";
  return null;
}

export type SwapView = {
  id: number; status: string; note: string | null; createdAt: string; decisionNote: string | null;
  fromUserId: number; fromName: string; toUserId: number; toName: string;
  a: { dayId: number; date: string; positionName: string }; b: { dayId: number; date: string; positionName: string };
};

function view(r: { id: number; status: string; note: string | null; created_at: string; decision_note: string | null; from_user_id: number; to_user_id: number; day_a_id: number; day_b_id: number }): SwapView {
  const db = getDb();
  const name = (id: number) => (db.prepare("SELECT TRIM(COALESCE(title_prefix, '') || ' ' || display_name) n FROM users WHERE id = ?").get(id) as { n: string } | undefined)?.n ?? "";
  const dayInfo = (id: number) => (db.prepare("SELECT d.duty_date date, p.name pname FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ?").get(id) as { date: string; pname: string });
  const a = dayInfo(r.day_a_id), b = dayInfo(r.day_b_id);
  return { id: r.id, status: r.status, note: r.note, createdAt: r.created_at, decisionNote: r.decision_note,
    fromUserId: r.from_user_id, fromName: name(r.from_user_id), toUserId: r.to_user_id, toName: name(r.to_user_id),
    a: { dayId: r.day_a_id, date: a.date, positionName: a.pname }, b: { dayId: r.day_b_id, date: b.date, positionName: b.pname } };
}

type SwapRow = { id: number; branch_id: number; year_month: string; day_a_id: number; day_b_id: number; from_user_id: number; to_user_id: number; status: string; note: string | null; created_at: string; decision_note: string | null };
const loadSwap = (id: number): SwapRow => {
  const r = getDb().prepare("SELECT * FROM special_duty_swaps WHERE id = ?").get(id) as SwapRow | undefined;
  if (!r) throw new SwapError("not_found");
  return r;
};

export function proposeSwap(args: { userId: number; myDayId: number; theirDayId: number; note?: string; today?: string }): number {
  const db = getDb();
  const a = loadDay(args.myDayId), b = loadDay(args.theirDayId);
  if (a.user_id !== args.userId) throw new SwapError("forbidden");
  const problem = pairProblem(a, b, args.today ?? bkkToday());
  if (problem) throw new SwapError(problem);
  const busy = db.prepare("SELECT 1 FROM special_duty_swaps WHERE status IN ('pending_peer','pending_manager') AND (day_a_id IN (?,?) OR day_b_id IN (?,?))").get(a.id, b.id, a.id, b.id);
  if (busy) throw new SwapError("already_pending");
  const id = Number(db.prepare(`INSERT INTO special_duty_swaps (branch_id, year_month, day_a_id, day_b_id, from_user_id, to_user_id, note, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(a.branch_id, a.year_month, a.id, b.id, a.user_id, b.user_id, (args.note ?? "").trim() || null, new Date().toISOString()).lastInsertRowid);
  audit({ actorId: args.userId, branchId: a.branch_id, yearMonth: a.year_month, entity: "swap", entityId: id, action: "propose", after: { a: a.id, b: b.id } });
  return id;
}

export function respondToSwap(args: { swapId: number; userId: number; accept: boolean; today?: string }): void {
  const db = getDb();
  const s = loadSwap(args.swapId);
  if (s.to_user_id !== args.userId) throw new SwapError("forbidden");
  if (s.status !== "pending_peer") throw new SwapError("wrong_status");
  const now = new Date().toISOString();
  if (!args.accept) {
    db.prepare("UPDATE special_duty_swaps SET status = 'declined', peer_responded_at = ? WHERE id = ?").run(now, s.id);
  } else {
    const problem = pairProblem(loadDay(s.day_a_id), loadDay(s.day_b_id), args.today ?? bkkToday());
    if (problem) throw new SwapError(problem);
    db.prepare("UPDATE special_duty_swaps SET status = 'pending_manager', peer_responded_at = ? WHERE id = ?").run(now, s.id);
  }
  audit({ actorId: args.userId, branchId: s.branch_id, yearMonth: s.year_month, entity: "swap", entityId: s.id, action: args.accept ? "accept" : "decline" });
}

export function cancelSwap(args: { swapId: number; userId: number }): void {
  const s = loadSwap(args.swapId);
  if (s.from_user_id !== args.userId) throw new SwapError("forbidden");
  if (!["pending_peer", "pending_manager"].includes(s.status)) throw new SwapError("wrong_status");
  getDb().prepare("UPDATE special_duty_swaps SET status = 'cancelled' WHERE id = ?").run(s.id);
  audit({ actorId: args.userId, branchId: s.branch_id, yearMonth: s.year_month, entity: "swap", entityId: s.id, action: "cancel" });
}

/** The manager decides. Approval re-checks everything, then moves both days in ONE transaction. */
export function decideSwap(args: { swapId: number; branchId: number; managerId: number; approve: boolean; note?: string; today?: string }): void {
  const db = getDb();
  const s = loadSwap(args.swapId);
  if (s.branch_id !== args.branchId) throw new SwapError("not_found");
  if (s.status !== "pending_manager") throw new SwapError("wrong_status");
  const note = (args.note ?? "").trim();
  const now = new Date().toISOString();
  if (!args.approve) {
    if (note.length < 3) throw new SwapError("note_required");
    db.prepare("UPDATE special_duty_swaps SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(args.managerId, now, note, s.id);
  } else {
    db.transaction(() => {
      const a = loadDay(s.day_a_id), b = loadDay(s.day_b_id);
      // the days must still belong to the two people who agreed
      if (a.user_id !== s.from_user_id || b.user_id !== s.to_user_id) throw new SwapError("day_not_swappable");
      const problem = pairProblem(a, b, args.today ?? bkkToday());
      if (problem) throw new SwapError(problem);
      db.prepare("UPDATE special_duty_days SET user_id = ? WHERE id = ?").run(b.user_id, a.id);
      db.prepare("UPDATE special_duty_days SET user_id = ? WHERE id = ?").run(a.user_id, b.id);
      db.prepare("UPDATE special_duty_swaps SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?").run(args.managerId, now, note || null, s.id);
    })();
  }
  audit({ actorId: args.managerId, branchId: s.branch_id, yearMonth: s.year_month, entity: "swap", entityId: s.id, action: args.approve ? "approve" : "reject", after: { note } });
}

/** A person's own swap requests (sent and received), newest first. */
export function listMySwaps(userId: number, yearMonth: string): { incoming: SwapView[]; sent: SwapView[] } {
  const rows = getDb().prepare("SELECT * FROM special_duty_swaps WHERE year_month = ? AND (from_user_id = ? OR to_user_id = ?) ORDER BY id DESC").all(yearMonth, userId, userId) as SwapRow[];
  return { incoming: rows.filter((r) => r.to_user_id === userId).map(view), sent: rows.filter((r) => r.from_user_id === userId).map(view) };
}

/** What the manager has to decide. */
export function listPendingForManager(branchId: number, yearMonth: string): SwapView[] {
  return (getDb().prepare("SELECT * FROM special_duty_swaps WHERE branch_id = ? AND year_month = ? AND status = 'pending_manager' ORDER BY id").all(branchId, yearMonth) as SwapRow[]).map(view);
}

/** Days that `userId` could still offer or ask for in a swap, with who holds them — for the picker (names are already
 *  visible to the branch once the schedule is published). */
export function swappableDays(userId: number, branchId: number, yearMonth: string, today = bkkToday()): { mine: Array<{ dayId: number; date: string; positionName: string }>; others: Array<{ dayId: number; date: string; positionName: string; holderName: string; holderId: number }> } {
  const db = getDb();
  const rows = db.prepare(`SELECT d.id, d.user_id AS uid, d.duty_date AS date, p.name AS pname, ${sqlNameWithPrefix("u")} AS holder FROM special_duty_days d
      JOIN special_duty_positions p ON p.id = d.position_id JOIN users u ON u.id = d.user_id
     WHERE p.branch_id = ? AND p.year_month = ? AND d.status IN ('booked','assigned') AND d.performer_user_id IS NULL ORDER BY d.duty_date, p.slot_no`)
    .all(branchId, yearMonth) as Array<{ id: number; uid: number; date: string; pname: string; holder: string }>;
  const notice = cfgNum("swap_notice_days", branchId);
  const ok = rows.filter((r) => today <= addDays(r.date, -notice));
  return {
    mine: ok.filter((r) => r.uid === userId).map((r) => ({ dayId: r.id, date: r.date, positionName: r.pname })),
    others: ok.filter((r) => r.uid !== userId).map((r) => ({ dayId: r.id, date: r.date, positionName: r.pname, holderName: r.holder, holderId: r.uid }))
  };
}

// ── who to tell ─────────────────────────────────────────────────────────

const lineOf = (userId: number) => (getDb().prepare("SELECT line_user_id l FROM users WHERE id = ?").get(userId) as { l: string | null } | undefined)?.l ?? null;

/** LINE ids of the branch's managers (admins of the branch). */
export function managerLineIds(branchId: number): string[] {
  return (getDb().prepare(`SELECT DISTINCT u.line_user_id l FROM users u JOIN user_branches ub ON ub.user_id = u.id
      WHERE ub.branch_id = ? AND ub.is_admin = 1 AND u.line_user_id IS NOT NULL AND u.status NOT IN ('disabled','resigned','terminated')`).all(branchId) as Array<{ l: string }>).map((r) => r.l);
}

export type SwapNotice = { to: Array<string | null>; title: string; lines: string[]; audience: "staff" | "manager" };

const TH_M = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const thDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${d} ${TH_M[m - 1]} ${y + 543}`; };

/** The message(s) to send after a swap step. `event` is the step that just happened. */
export function swapNotices(swapId: number, event: "proposed" | "accepted" | "declined" | "approved" | "rejected" | "cancelled"): SwapNotice[] {
  const s = loadSwap(swapId);
  const v = view(s);
  const trade = `${v.fromName} ให้วันที่ ${thDate(v.a.date)} (${v.a.positionName}) แลกกับวันที่ ${thDate(v.b.date)} (${v.b.positionName}) ของ ${v.toName}`;
  switch (event) {
    case "proposed": return [{ to: [lineOf(s.to_user_id)], audience: "staff", title: "มีคำขอสลับวันตำแหน่งงานค่าตอบแทนพิเศษ", lines: [trade, ...(v.note ? [`เหตุผล: ${v.note}`] : []), "กรุณาเปิดระบบเพื่อตอบรับหรือปฏิเสธ"] }];
    case "accepted": return [
      { to: [lineOf(s.from_user_id)], audience: "staff", title: "คู่สลับตอบรับแล้ว", lines: [`${v.toName} ตอบรับการสลับวัน รอผู้จัดการอนุมัติ`] },
      { to: managerLineIds(s.branch_id), audience: "manager", title: "มีคำขอสลับวันรออนุมัติ", lines: [trade, "ผู้ที่เกี่ยวข้องตกลงกันแล้ว"] }
    ];
    case "declined": return [{ to: [lineOf(s.from_user_id)], audience: "staff", title: "คู่สลับปฏิเสธการสลับวัน", lines: [trade] }];
    case "cancelled": return [{ to: [lineOf(s.to_user_id)], audience: "staff", title: "ผู้ขอยกเลิกคำขอสลับวัน", lines: [trade] }];
    case "approved": return [{ to: [lineOf(s.from_user_id), lineOf(s.to_user_id)], audience: "staff", title: "ผู้จัดการอนุมัติการสลับวันแล้ว", lines: [trade, "วันที่ของแต่ละท่านเปลี่ยนตามนี้แล้ว"] }];
    case "rejected": return [{ to: [lineOf(s.from_user_id), lineOf(s.to_user_id)], audience: "staff", title: "ผู้จัดการไม่อนุมัติการสลับวัน", lines: [trade, ...(s.decision_note ? [`เหตุผล: ${s.decision_note}`] : [])] }];
  }
}
