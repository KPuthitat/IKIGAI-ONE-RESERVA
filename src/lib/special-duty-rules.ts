// ตำแหน่งงานค่าตอบแทนพิเศษ — booking / assignment rules (owner 2026-10-11).
// Pure checks against the database, no side effects except in setUserBookings /
// assignDay, which run inside one transaction so a rejected request changes nothing.
// Messages never say WHO holds a slot — only that it is taken.

import { getDb } from "./db";
import { getMonth, listPositions, cfgNum, audit, SpecialDutyError, type DutyPosition } from "./special-duty";

export type RuleCode =
  | "month_off" | "roster_not_published" | "booking_not_open" | "booking_closed"
  | "not_in_branch" | "self_booking_disqualified" | "position_invalid" | "date_outside_month" | "date_in_past"
  | "not_in_roster" | "group_not_eligible" | "on_leave" | "below_minimum_days" | "too_many_per_day" | "slot_taken"
  | "not_open_for_assignment";

export type RuleResult = { ok: true; overridden?: RuleCode[] } | { ok: false; errors: Array<{ code: RuleCode; positionId?: number; date?: string }> };

const bkkToday = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const prevMonth = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };

export function absenceStrikes(userId: number, branchId: number, yearMonth: string): number {
  return (getDb().prepare(`
    SELECT COUNT(*) AS n FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE d.user_id = ? AND p.branch_id = ? AND p.year_month = ? AND d.absent_by_holder = 1
  `).get(userId, branchId, yearMonth) as { n: number }).n;
}

/** More than the configured number of missed duties last month → no self-booking this
 *  month (the manager can still assign them an open day). */
export function isSelfBookingDisqualified(userId: number, branchId: number, yearMonth: string): boolean {
  return absenceStrikes(userId, branchId, prevMonth(yearMonth)) > cfgNum("absence_strike_limit", branchId);
}

type UserRow = { id: number; department: string | null; status: string };

function loadUser(userId: number, branchId: number): UserRow | null {
  const u = getDb().prepare(`
    SELECT u.id, u.department, u.status FROM users u
     WHERE u.id = ? AND u.status NOT IN ('disabled','resigned','terminated')
       AND EXISTS (SELECT 1 FROM user_branches ub WHERE ub.user_id = u.id AND ub.branch_id = ?)
  `).get(userId, branchId) as UserRow | undefined;
  return u ?? null;
}

/** On the roster of THIS branch that day with a work shift (a day off does not count). */
export function isOnRoster(userId: number, branchId: number, date: string): boolean {
  return !!getDb().prepare(`
    SELECT 1 FROM roster_assignments a JOIN shift_codes s ON s.id = a.shift_code_id
     WHERE a.branch_id = ? AND a.user_id = ? AND a.assignment_date = ? AND s.kind = 'work' LIMIT 1
  `).get(branchId, userId, date);
}

export function isOnApprovedLeave(userId: number, date: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM leave_requests WHERE user_id = ? AND status = 'approved' AND ? BETWEEN date_from AND date_to LIMIT 1").get(userId, date);
}

export function isGroupEligible(user: { department: string | null }, position: DutyPosition): boolean {
  return position.eligibleGroups == null || (user.department != null && (position.eligibleGroups as string[]).includes(user.department));
}

type Err = { code: RuleCode; positionId?: number; date?: string };

/** Checks shared by self-booking and manager assignment for one (position, date). */
function checkSlot(user: UserRow, branchId: number, ym: string, pos: DutyPosition | undefined, date: string, asOf: string, errs: Err[]): void {
  if (!pos || !pos.active) { errs.push({ code: "position_invalid" }); return; }
  if (date.slice(0, 7) !== ym) { errs.push({ code: "date_outside_month", positionId: pos.id, date }); return; }
  if (date < asOf) errs.push({ code: "date_in_past", positionId: pos.id, date });
  if (!isGroupEligible(user, pos)) errs.push({ code: "group_not_eligible", positionId: pos.id, date });
  if (!isOnRoster(user.id, branchId, date)) errs.push({ code: "not_in_roster", positionId: pos.id, date });
  if (isOnApprovedLeave(user.id, date)) errs.push({ code: "on_leave", positionId: pos.id, date });
}

/** The user's whole wanted set of days for ONE position (replacing what they hold there).
 *  Any number of days is accepted (owner 2026-10-18: "ไม่น้อยกว่า 6 ครั้ง" is NOT a lock — someone rostered on fewer than
 *  6 days could never reach it). min_days_per_position is only the recommended number shown to staff. */
export function checkBookingSet(args: { userId: number; branchId: number; yearMonth: string; positionId: number; dates: string[]; asOf?: string }): RuleResult {
  const { userId, branchId, yearMonth, positionId } = args;
  const asOf = args.asOf ?? bkkToday();
  const errs: Err[] = [];
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled || month.status === "off") return { ok: false, errors: [{ code: "month_off" }] };
  if (month.status === "awaiting_roster") return { ok: false, errors: [{ code: "roster_not_published" }] };
  if (month.status !== "booking_open") return { ok: false, errors: [{ code: "booking_not_open" }] };
  if (month.bookingCloseDate && asOf > month.bookingCloseDate) return { ok: false, errors: [{ code: "booking_closed" }] };
  const user = loadUser(userId, branchId);
  if (!user) return { ok: false, errors: [{ code: "not_in_branch" }] };
  if (isSelfBookingDisqualified(userId, branchId, yearMonth)) return { ok: false, errors: [{ code: "self_booking_disqualified" }] };

  const dates = [...new Set(args.dates)].sort();
  const pos = listPositions(branchId, yearMonth).find((p) => p.id === positionId);
  for (const d of dates) checkSlot(user, branchId, yearMonth, pos, d, asOf, errs);
  if (!pos || !pos.active) return { ok: false, errors: errs };


  // at most N positions per person per day, counting every row they hold (booked or assigned) in OTHER positions
  const db = getDb();
  const maxPerDay = cfgNum("max_positions_per_person_per_day", branchId);
  for (const d of dates) {
    const others = (db.prepare("SELECT COUNT(*) AS n FROM special_duty_days WHERE user_id = ? AND duty_date = ? AND position_id != ?").get(userId, d, positionId) as { n: number }).n;
    if (others + 1 > maxPerDay) errs.push({ code: "too_many_per_day", positionId, date: d });
  }
  // a slot held by someone else is "taken" — never reveal by whom
  for (const d of dates) {
    const row = db.prepare("SELECT user_id FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(positionId, d) as { user_id: number } | undefined;
    if (row && row.user_id !== userId) errs.push({ code: "slot_taken", positionId, date: d });
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true };
}

/** Confirm a person's days for one position: all or nothing, in one transaction. */
export function setUserBookings(args: { userId: number; branchId: number; yearMonth: string; positionId: number; dates: string[]; asOf?: string }): RuleResult {
  const db = getDb();
  const dates = [...new Set(args.dates)].sort();
  let result: RuleResult = { ok: true };
  try {
  db.transaction(() => {
    result = checkBookingSet({ ...args, dates });
    if (!result.ok) return;
    const held = db.prepare("SELECT duty_date AS d FROM special_duty_days WHERE position_id = ? AND user_id = ? AND source = 'booked' AND status = 'booked'")
      .all(args.positionId, args.userId) as Array<{ d: string }>;
    const keep = new Set(dates);
    const del = db.prepare("DELETE FROM special_duty_days WHERE position_id = ? AND user_id = ? AND duty_date = ? AND source = 'booked' AND status = 'booked'");
    for (const h of held) if (!keep.has(h.d)) del.run(args.positionId, args.userId, h.d);
    const have = new Set(held.map((h) => h.d));
    const ins = db.prepare("INSERT INTO special_duty_days (position_id, duty_date, user_id, source, status) VALUES (?, ?, ?, 'booked', 'booked')");
    for (const d of dates) if (!have.has(d)) {
      try { ins.run(args.positionId, d, args.userId); }
      catch { result = { ok: false, errors: [{ code: "slot_taken", positionId: args.positionId, date: d }] }; throw new SpecialDutyError("rollback"); }
    }
    audit({ actorId: args.userId, branchId: args.branchId, yearMonth: args.yearMonth, entity: "booking", entityId: args.positionId, action: "set",
      before: held.map((h) => h.d).sort(), after: dates });
  })();
  } catch (e) { if (!(e instanceof SpecialDutyError && e.code === "rollback")) throw e; }
  return result;
}

/** Manager assigns an open day — from the moment booking opens until the schedule is published
 *  (owner 2026-10-15: the back office can add people itself, not only fill what is left).
 *  Same eligibility, no minimum, and strikes do not block it. */
/** What a manager may knowingly step over (owner 2026-10-16): the person is not on the roster that day, is on leave,
 *  is outside the position's group, or the day is already past. Never: a taken slot, the per-day limit, the person
 *  not belonging to the branch, or a position that does not exist. */
const OVERRIDABLE: ReadonlySet<RuleCode> = new Set<RuleCode>(["not_in_roster", "on_leave", "group_not_eligible", "date_in_past"]);

export function checkAssignment(args: { userId: number; branchId: number; yearMonth: string; positionId: number; date: string; asOf?: string; override?: boolean }): RuleResult {
  const { userId, branchId, yearMonth, positionId, date } = args;
  const asOf = args.asOf ?? bkkToday();
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled) return { ok: false, errors: [{ code: "month_off" }] };
  if (!["booking_open", "booking_closed", "filling"].includes(month.status)) return { ok: false, errors: [{ code: "not_open_for_assignment" }] };
  const user = loadUser(userId, branchId);
  if (!user) return { ok: false, errors: [{ code: "not_in_branch" }] };
  const errs: Err[] = [];
  const pos = listPositions(branchId, yearMonth).find((p) => p.id === positionId);
  checkSlot(user, branchId, yearMonth, pos, date, asOf, errs);
  if (!pos || !pos.active) return { ok: false, errors: errs };
  const db = getDb();
  const others = (db.prepare("SELECT COUNT(*) AS n FROM special_duty_days WHERE user_id = ? AND duty_date = ? AND position_id != ?").get(userId, date, positionId) as { n: number }).n;
  if (others + 1 > cfgNum("max_positions_per_person_per_day", branchId)) errs.push({ code: "too_many_per_day", positionId, date });
  if (db.prepare("SELECT 1 FROM special_duty_days WHERE position_id = ? AND duty_date = ?").get(positionId, date)) errs.push({ code: "slot_taken", positionId, date });
  if (args.override) {
    const stepped = errs.filter((e) => OVERRIDABLE.has(e.code)).map((e) => e.code);
    const hard = errs.filter((e) => !OVERRIDABLE.has(e.code));
    return hard.length ? { ok: false, errors: hard } : { ok: true, overridden: stepped };
  }
  return errs.length ? { ok: false, errors: errs } : { ok: true };
}

export function assignDay(args: { userId: number; branchId: number; yearMonth: string; positionId: number; date: string; managerId: number; asOf?: string; override?: boolean }): RuleResult {
  const db = getDb();
  let result: RuleResult = { ok: true };
  db.transaction(() => {
    result = checkAssignment(args);
    if (!result.ok) return;
    const r = db.prepare("INSERT INTO special_duty_days (position_id, duty_date, user_id, source, status, assigned_by) VALUES (?, ?, ?, 'assigned', 'assigned', ?)")
      .run(args.positionId, args.date, args.userId, args.managerId);
    audit({ actorId: args.managerId, branchId: args.branchId, yearMonth: args.yearMonth, entity: "assignment", entityId: Number(r.lastInsertRowid), action: "assign", after: { userId: args.userId, positionId: args.positionId, date: args.date, ...(result.ok && result.overridden?.length ? { overridden: result.overridden } : {}) } });
  })();
  return result;
}
