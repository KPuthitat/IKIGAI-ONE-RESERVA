// ตำแหน่งงานค่าตอบแทนพิเศษ — closing booking, filling the open days, publishing the
// special schedule (owner 2026-10-11).
//
//  • closeBooking / startFilling: booking_open → booking_closed → filling.
//  • openDays: every (position, date) with nobody on it, with how many people could take it.
//  • suggestFill: greedy rotation. Days are visited in date order; each goes to the eligible
//    person with the fewest days this month, then the fewest last month (so the load
//    rotates month to month), then whoever last did a duty longest ago. Every pick goes
//    through the same rule check as a manual assignment (roster, group, leave, two
//    positions a day), so a suggestion is never something a manager could not assign.
//    A preview runs inside a transaction that is rolled back.
//  • removeDay: the manager frees a booked/assigned day (not once evidence is in).
//  • publishSchedule: filling → special_published; from then staff of the branch can see
//    names (never money). Unfilled days must be acknowledged explicitly.

import { getDb } from "./db";
import { advanceMonth, audit, daysInMonth, getMonth, listPositions, SpecialDutyError } from "./special-duty";
import { assignDay, checkAssignment, type RuleResult } from "./special-duty-rules";

const prevMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const monthDates = (ym: string) => Array.from({ length: daysInMonth(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);

export function closeBooking(args: { branchId: number; yearMonth: string; actorId: number | null }) {
  return advanceMonth({ ...args, to: "booking_closed" });
}
export function startFilling(args: { branchId: number; yearMonth: string; actorId: number | null }) {
  return advanceMonth({ ...args, to: "filling" });
}

/** Booking windows that ended before `today` close by themselves (called from the daily cron). */
export function closeDueBookings(today = bkkToday()): Array<{ branchId: number; yearMonth: string }> {
  const rows = getDb().prepare(`SELECT branch_id AS b, year_month AS m FROM special_duty_months
      WHERE enabled = 1 AND status = 'booking_open' AND booking_close_date IS NOT NULL AND booking_close_date < ?`)
    .all(today) as Array<{ b: number; m: string }>;
  const out: Array<{ branchId: number; yearMonth: string }> = [];
  for (const r of rows) { closeBooking({ branchId: r.b, yearMonth: r.m, actorId: null }); out.push({ branchId: r.b, yearMonth: r.m }); }
  return out;
}

export type OpenDay = { positionId: number; positionName: string; date: string; candidates: number };

function candidatePool(branchId: number): number[] {
  return (getDb().prepare(`
    SELECT u.id FROM users u
     WHERE u.role IN ('staff','admin') AND u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account, 0) = 0
       AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?)
     ORDER BY u.id
  `).all(branchId) as Array<{ id: number }>).map((r) => r.id);
}

export function openDays(branchId: number, yearMonth: string, asOf?: string): OpenDay[] {
  const db = getDb();
  const pool = candidatePool(branchId);
  const out: OpenDay[] = [];
  for (const p of listPositions(branchId, yearMonth, { activeOnly: true })) {
    const taken = new Set((db.prepare("SELECT duty_date AS d FROM special_duty_days WHERE position_id = ?").all(p.id) as Array<{ d: string }>).map((r) => r.d));
    for (const date of monthDates(yearMonth)) {
      if (taken.has(date)) continue;
      const candidates = pool.filter((uid) => checkAssignment({ userId: uid, branchId, yearMonth, positionId: p.id, date, asOf }).ok).length;
      out.push({ positionId: p.id, positionName: p.name, date, candidates });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.positionId - b.positionId);
}

export type Suggestion = { positionId: number; positionName: string; date: string; userId: number; userName: string };
export type FillPlan = { suggestions: Suggestion[]; unfillable: OpenDay[] };

function loadCounts(branchId: number, ym: string) {
  const db = getDb();
  const count = (month: string) => new Map((db.prepare(`
    SELECT d.user_id AS u, COUNT(*) AS n FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE p.branch_id = ? AND p.year_month = ? GROUP BY d.user_id`).all(branchId, month) as Array<{ u: number; n: number }>).map((r) => [r.u, r.n]));
  const last = new Map((db.prepare(`
    SELECT d.user_id AS u, MAX(d.duty_date) AS dt FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE p.branch_id = ? AND p.year_month < ? GROUP BY d.user_id`).all(branchId, ym) as Array<{ u: number; dt: string }>).map((r) => [r.u, r.dt]));
  return { thisMonth: count(ym), lastMonth: count(prevMonth(ym)), lastDuty: last };
}

/** Greedy rotation. With `commit` false the work is rolled back and only the plan is returned. */
export function fillOpenDays(args: { branchId: number; yearMonth: string; managerId: number; commit: boolean; asOf?: string }): FillPlan {
  const { branchId, yearMonth, managerId } = args;
  const db = getDb();
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled) throw new SpecialDutyError("month_off");
  if (month.status !== "booking_closed" && month.status !== "filling") throw new SpecialDutyError("invalid_transition", month.status);
  const names = new Map((db.prepare("SELECT id, display_name AS n FROM users").all() as Array<{ id: number; n: string }>).map((r) => [r.id, r.n]));
  const pool = candidatePool(branchId);
  const plan: FillPlan = { suggestions: [], unfillable: [] };
  const ROLLBACK = new Error("rollback-preview");
  try {
    db.transaction(() => {
      const cnt = loadCounts(branchId, yearMonth);
      const days = openDays(branchId, yearMonth, args.asOf);
      for (const day of days) {
        const ok = pool.filter((uid) => checkAssignment({ userId: uid, branchId, yearMonth, positionId: day.positionId, date: day.date, asOf: args.asOf }).ok);
        if (ok.length === 0) { plan.unfillable.push(day); continue; }
        ok.sort((a, b) =>
          (cnt.thisMonth.get(a) ?? 0) - (cnt.thisMonth.get(b) ?? 0)
          || (cnt.lastMonth.get(a) ?? 0) - (cnt.lastMonth.get(b) ?? 0)
          || (cnt.lastDuty.get(a) ?? "").localeCompare(cnt.lastDuty.get(b) ?? "")
          || a - b);
        const pick = ok[0];
        const r = assignDay({ userId: pick, branchId, yearMonth, positionId: day.positionId, date: day.date, managerId, asOf: args.asOf });
        if (!r.ok) { plan.unfillable.push(day); continue; }
        cnt.thisMonth.set(pick, (cnt.thisMonth.get(pick) ?? 0) + 1);
        cnt.lastDuty.set(pick, day.date);
        plan.suggestions.push({ positionId: day.positionId, positionName: day.positionName, date: day.date, userId: pick, userName: names.get(pick) ?? "" });
      }
      if (!args.commit) throw ROLLBACK;
    })();
  } catch (e) { if (e !== ROLLBACK) throw e; }
  if (args.commit && month.status === "booking_closed") startFilling({ branchId, yearMonth, actorId: managerId });
  return plan;
}

/** Manager assigns one open day (also moves booking_closed → filling). */
export function managerAssign(args: { branchId: number; yearMonth: string; positionId: number; date: string; userId: number; managerId: number; asOf?: string }): RuleResult {
  const r = assignDay(args);
  if (r.ok && getMonth(args.branchId, args.yearMonth).status === "booking_closed") startFilling({ branchId: args.branchId, yearMonth: args.yearMonth, actorId: args.managerId });
  return r;
}

export type RemoveResult = { ok: true } | { ok: false; code: "not_found" | "not_removable" | "wrong_stage" };

/** Free a booked/assigned day. Allowed while the month is being filled and before any evidence is submitted. */
export function removeDay(args: { dayId: number; branchId: number; managerId: number }): RemoveResult {
  const db = getDb();
  const row = db.prepare(`
    SELECT d.id, d.status, d.user_id AS uid, d.duty_date AS date, d.source, p.id AS pid, p.year_month AS ym
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id WHERE d.id = ? AND p.branch_id = ?
  `).get(args.dayId, args.branchId) as { id: number; status: string; uid: number; date: string; source: string; pid: number; ym: string } | undefined;
  if (!row) return { ok: false, code: "not_found" };
  const m = getMonth(args.branchId, row.ym);
  if (!["booking_closed", "filling"].includes(m.status)) return { ok: false, code: "wrong_stage" };
  if (!["booked", "assigned"].includes(row.status)) return { ok: false, code: "not_removable" };
  db.prepare("DELETE FROM special_duty_days WHERE id = ?").run(row.id);
  audit({ actorId: args.managerId, branchId: args.branchId, yearMonth: row.ym, entity: "assignment", entityId: row.id, action: "remove",
    before: { userId: row.uid, positionId: row.pid, date: row.date, source: row.source } });
  return { ok: true };
}

export type PublishResult =
  | { published: false; unfilled: OpenDay[] }
  | { published: true; unfilled: OpenDay[]; duties: Array<{ userId: number; lineUserId: string | null; days: Array<{ positionName: string; date: string }> }> };

export function publishSchedule(args: { branchId: number; yearMonth: string; actorId: number; allowUnfilled: boolean; asOf?: string }): PublishResult {
  const { branchId, yearMonth } = args;
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled) throw new SpecialDutyError("month_off");
  if (month.status === "booking_closed") startFilling({ branchId, yearMonth, actorId: args.actorId });
  else if (month.status !== "filling") throw new SpecialDutyError("invalid_transition", month.status);
  const unfilled = openDays(branchId, yearMonth, args.asOf);
  if (unfilled.length > 0 && !args.allowUnfilled) return { published: false, unfilled };
  advanceMonth({ branchId, yearMonth, to: "special_published", actorId: args.actorId });
  const rows = getDb().prepare(`
    SELECT d.user_id AS uid, u.line_user_id AS line, p.name AS pname, d.duty_date AS date
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id JOIN users u ON u.id = d.user_id
     WHERE p.branch_id = ? AND p.year_month = ? ORDER BY d.duty_date, p.slot_no
  `).all(branchId, yearMonth) as Array<{ uid: number; line: string | null; pname: string; date: string }>;
  const by = new Map<number, { userId: number; lineUserId: string | null; days: Array<{ positionName: string; date: string }> }>();
  for (const r of rows) {
    const e = by.get(r.uid) ?? { userId: r.uid, lineUserId: r.line, days: [] };
    e.days.push({ positionName: r.pname, date: r.date }); by.set(r.uid, e);
  }
  return { published: true, unfilled, duties: [...by.values()] };
}
