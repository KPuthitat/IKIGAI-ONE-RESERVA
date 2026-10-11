// ตำแหน่งงานค่าตอบแทนพิเศษ — the ONLY readers of booking data for a viewer (owner 2026-10-11).
//
// SQLite has no row-level security, so privacy is enforced here: every screen and API
// reads booking rows through these functions and nothing else (a test scans the source
// tree to prove no other file queries special_duty_days).
//
//  • Staff while booking is open … filling: anonymous. A slot is "free", "full" or "mine";
//    no id, name, source or amount of anyone else is ever in the result — even when
//    every slot is full.
//  • Staff after the schedule is published: names of their OWN branch only, no money,
//    no booked-vs-assigned flag.
//  • A manager sees their branches in full, the owner every branch.

import { getDb } from "./db";
import { cfgNum, getMonth, listPositions, type DutyMonthStatus, type DutyPosition } from "./special-duty";
import { isGroupEligible, isOnRoster } from "./special-duty-rules";

export type Viewer = { userId: number; role: "staff" | "admin" | "super_admin"; branchIds: number[]; adminBranchIds: number[]; department?: string | null };

export class AccessError extends Error { constructor(public code: "forbidden" | "not_published" | "month_off") { super(code); } }

const ANON: DutyMonthStatus[] = ["booking_open", "booking_closed", "filling"];
const REVEALED: DutyMonthStatus[] = ["special_published", "in_progress", "settled"];

export const canManage = (v: Viewer, branchId: number) => v.role === "super_admin" || (v.role === "admin" && v.adminBranchIds.includes(branchId));
const inBranch = (v: Viewer, branchId: number) => v.role === "super_admin" || v.branchIds.includes(branchId);

function viewerDept(v: Viewer): string | null {
  if (v.department !== undefined) return v.department;
  return (getDb().prepare("SELECT department FROM users WHERE id = ?").get(v.userId) as { department: string | null } | undefined)?.department ?? null;
}

export type SlotState = "free" | "full" | "mine";
export type AnonymousSlots = {
  status: DutyMonthStatus; bookingCloseDate: string | null; minDays: number;
  positions: Array<{ id: number; slotNo: number; name: string; description: string | null; dailyRate: number; eligible: boolean;
    days: Array<{ date: string; state: SlotState }> }>;
};

/** The booking calendar for ONE viewer: only their own roster days, only the positions
 *  they may take, each slot just free / full / mine. */
export function getAnonymousSlots(viewer: Viewer, branchId: number, yearMonth: string): AnonymousSlots {
  if (!inBranch(viewer, branchId)) throw new AccessError("forbidden");
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled) throw new AccessError("month_off");
  if (!ANON.includes(month.status)) throw new AccessError("not_published");   // before booking or after reveal this view does not exist
  const dept = viewerDept(viewer);
  const db = getDb();
  const positions = listPositions(branchId, yearMonth, { activeOnly: true }).map((p) => {
    const eligible = isGroupEligible({ department: dept }, p);
    const taken = new Map((db.prepare("SELECT duty_date AS d, user_id AS u FROM special_duty_days WHERE position_id = ?").all(p.id) as Array<{ d: string; u: number }>).map((r) => [r.d, r.u]));
    const [y, m] = yearMonth.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days: Array<{ date: string; state: SlotState }> = [];
    if (eligible) for (let d = 1; d <= last; d++) {
      const date = `${yearMonth}-${String(d).padStart(2, "0")}`;
      if (!isOnRoster(viewer.userId, branchId, date)) continue;
      const holder = taken.get(date);
      days.push({ date, state: holder == null ? "free" : holder === viewer.userId ? "mine" : "full" });
    }
    return { id: p.id, slotNo: p.slotNo, name: p.name, description: p.description, dailyRate: p.dailyRate, eligible, days };
  });
  return { status: month.status, bookingCloseDate: month.bookingCloseDate, minDays: cfgNum("min_days_per_position"), positions };
}

export type MyDuty = { positionId: number; positionName: string; date: string; status: string; amount: number };

/** The viewer's own rows with the pay they would get — never anyone else's. */
export function getMyDuties(viewer: Viewer, branchId: number, yearMonth: string): MyDuty[] {
  if (!inBranch(viewer, branchId)) throw new AccessError("forbidden");
  return (getDb().prepare(`
    SELECT p.id AS pid, p.name, p.daily_rate AS rate, d.duty_date AS date, d.status
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE p.branch_id = ? AND p.year_month = ? AND (d.user_id = ? OR d.performer_user_id = ?)
     ORDER BY d.duty_date, p.slot_no
  `).all(branchId, yearMonth, viewer.userId, viewer.userId) as Array<{ pid: number; name: string; rate: number; date: string; status: string }>)
    .map((r) => ({ positionId: r.pid, positionName: r.name, date: r.date, status: r.status, amount: r.rate }));
}

export type PublishedRow = { positionId: number; positionName: string; date: string; name: string };

/** Staff view after the schedule is published: names of their own branch, nothing else. */
export function getPublishedSchedule(viewer: Viewer, branchId: number, yearMonth: string): PublishedRow[] {
  if (!inBranch(viewer, branchId)) throw new AccessError("forbidden");
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled) throw new AccessError("month_off");
  if (!REVEALED.includes(month.status) && !canManage(viewer, branchId)) throw new AccessError("not_published");
  return (getDb().prepare(`
    SELECT p.id AS pid, p.name AS pname, d.duty_date AS date, COALESCE(NULLIF(u.nickname_th, ''), u.display_name) AS name
      FROM special_duty_days d
      JOIN special_duty_positions p ON p.id = d.position_id
      JOIN users u ON u.id = COALESCE(d.performer_user_id, d.user_id)
     WHERE p.branch_id = ? AND p.year_month = ?
     ORDER BY p.slot_no, d.duty_date
  `).all(branchId, yearMonth) as Array<{ pid: number; pname: string; date: string; name: string }>)
    .map((r) => ({ positionId: r.pid, positionName: r.pname, date: r.date, name: r.name }));
}

export type ManagerRow = {
  id: number; positionId: number; positionName: string; date: string; userId: number; name: string;
  source: "booked" | "assigned"; status: string; performerUserId: number | null; performerName: string | null; dailyRate: number;
};

/** Everything for a branch, for its manager (or the owner). */
export function getManagerView(viewer: Viewer, branchId: number, yearMonth: string): ManagerRow[] {
  if (!canManage(viewer, branchId)) throw new AccessError("forbidden");
  return (getDb().prepare(`
    SELECT d.id, p.id AS pid, p.name AS pname, p.daily_rate AS rate, d.duty_date AS date, d.user_id AS uid, u.display_name AS uname,
           d.source, d.status, d.performer_user_id AS perf, pu.display_name AS perfname
      FROM special_duty_days d
      JOIN special_duty_positions p ON p.id = d.position_id
      JOIN users u ON u.id = d.user_id
      LEFT JOIN users pu ON pu.id = d.performer_user_id
     WHERE p.branch_id = ? AND p.year_month = ?
     ORDER BY p.slot_no, d.duty_date
  `).all(branchId, yearMonth) as Array<{ id: number; pid: number; pname: string; rate: number; date: string; uid: number; uname: string; source: "booked" | "assigned"; status: string; perf: number | null; perfname: string | null }>)
    .map((r) => ({ id: r.id, positionId: r.pid, positionName: r.pname, date: r.date, userId: r.uid, name: r.uname, source: r.source, status: r.status, performerUserId: r.perf, performerName: r.perfname, dailyRate: r.rate }));
}

export type { DutyPosition };
