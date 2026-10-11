// ตำแหน่งงานค่าตอบแทนพิเศษ — hooks into the roster (owner 2026-10-11).
//
//  • releaseInvalidDutyDays: when the roster changes, a booked/assigned day whose holder
//    is no longer on the roster that day becomes an open day at once and the manager is
//    alerted (a row in special_duty_alerts that the notifier sends immediately).
//  • openBookingOnPublish: the manager's "ประกาศตารางงาน" opens booking for a month that
//    is switched on; returns who to tell.
//  • coverageGaps: a day on which no rostered person may take a position (e.g. nobody
//    from the kitchen) — shown to the manager when the roster is published.
// Everything is a no-op for a branch/month where the scheme is off.

import { getDb } from "./db";
import { getMonth, listPositions, advanceMonth, bookingCloseDateFor, audit, daysInMonth, type DutyPosition } from "./special-duty";
import { isOnRoster } from "./special-duty-rules";

type Released = { positionId: number; positionName: string; date: string; userId: number };

function raise(branchId: number, ym: string, kind: string, dedupe: string, payload: unknown): void {
  getDb().prepare(`INSERT OR IGNORE INTO special_duty_alerts (branch_id, year_month, kind, dedupe_key, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(branchId, ym, kind, dedupe, JSON.stringify(payload), new Date().toISOString());
}

/** Called by every roster write (assignment upsert/delete, CSV import, shift-request approval). */
export function releaseInvalidDutyDays(branchId: number, date: string): Released[] {
  const ym = date.slice(0, 7);
  const month = getMonth(branchId, ym);
  if (!month.enabled || month.status === "off" || month.status === "awaiting_roster") return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.id, d.user_id AS uid, p.id AS pid, p.name AS pname
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE p.branch_id = ? AND p.year_month = ? AND d.duty_date = ?
       AND d.status IN ('booked','assigned') AND d.absent_by_holder = 0
  `).all(branchId, ym, date) as Array<{ id: number; uid: number; pid: number; pname: string }>;
  const out: Released[] = [];
  for (const r of rows) {
    if (isOnRoster(r.uid, branchId, date)) continue;
    db.prepare("DELETE FROM special_duty_days WHERE id = ?").run(r.id);
    audit({ actorId: null, branchId, yearMonth: ym, entity: "day", entityId: r.id, action: "released_by_roster_change", before: { positionId: r.pid, date, userId: r.uid } });
    raise(branchId, ym, "slot_released", `${r.pid}:${date}`, { positionId: r.pid, positionName: r.pname, date });
    out.push({ positionId: r.pid, positionName: r.pname, date, userId: r.uid });
  }
  return out;
}

/** People on this branch's roster in the month who may take at least one active position. */
export function bookingAudience(branchId: number, ym: string): Array<{ userId: number; lineUserId: string | null }> {
  const positions = listPositions(branchId, ym, { activeOnly: true });
  if (positions.length === 0) return [];
  const rows = getDb().prepare(`
    SELECT DISTINCT u.id, u.line_user_id AS line, u.department AS dept
      FROM roster_assignments a JOIN shift_codes s ON s.id = a.shift_code_id JOIN users u ON u.id = a.user_id
     WHERE a.branch_id = ? AND substr(a.assignment_date, 1, 7) = ? AND s.kind = 'work'
       AND u.status NOT IN ('disabled','resigned','terminated')
  `).all(branchId, ym) as Array<{ id: number; line: string | null; dept: string | null }>;
  return rows
    .filter((u) => positions.some((p) => p.eligibleGroups == null || (u.dept != null && (p.eligibleGroups as string[]).includes(u.dept))))
    .map((u) => ({ userId: u.id, lineUserId: u.line }));
}

export type CoverageGap = { positionId: number; positionName: string; date: string };

/** Days where nobody on the roster is eligible for a position. */
export function coverageGaps(branchId: number, ym: string): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  const db = getDb();
  const positions = listPositions(branchId, ym, { activeOnly: true });
  if (positions.length === 0) return gaps;
  const rows = db.prepare(`
    SELECT a.assignment_date AS d, u.department AS dept
      FROM roster_assignments a JOIN shift_codes s ON s.id = a.shift_code_id JOIN users u ON u.id = a.user_id
     WHERE a.branch_id = ? AND substr(a.assignment_date, 1, 7) = ? AND s.kind = 'work'
       AND u.status NOT IN ('disabled','resigned','terminated')
  `).all(branchId, ym) as Array<{ d: string; dept: string | null }>;
  const byDate = new Map<string, Array<string | null>>();
  for (const r of rows) { const a = byDate.get(r.d) ?? []; a.push(r.dept); byDate.set(r.d, a); }
  const eligible = (p: DutyPosition, dept: string | null) => p.eligibleGroups == null || (dept != null && (p.eligibleGroups as string[]).includes(dept));
  for (let d = 1; d <= daysInMonth(ym); d++) {
    const date = `${ym}-${String(d).padStart(2, "0")}`;
    const depts = byDate.get(date) ?? [];
    for (const p of positions) if (!depts.some((x) => eligible(p, x))) gaps.push({ positionId: p.id, positionName: p.name, date });
  }
  return gaps;
}

/** The manager published the month's roster: open booking (if the scheme is on and was
 *  waiting for it) and report the audience + coverage gaps. */
export function openBookingOnPublish(args: { branchId: number; yearMonth: string; actorId: number | null; nowIso?: string }): {
  opened: boolean; closeDate: string | null; audience: Array<{ userId: number; lineUserId: string | null }>; gaps: CoverageGap[];
} {
  const { branchId, yearMonth } = args;
  const month = getMonth(branchId, yearMonth);
  if (!month.enabled || month.status !== "awaiting_roster") return { opened: false, closeDate: month.bookingCloseDate, audience: [], gaps: [] };
  const nowIso = args.nowIso ?? new Date().toISOString();
  const closeDate = bookingCloseDateFor(yearMonth, nowIso);
  getDb().prepare("UPDATE special_duty_months SET booking_close_date = ? WHERE branch_id = ? AND year_month = ?").run(closeDate, branchId, yearMonth);
  advanceMonth({ branchId, yearMonth, to: "booking_open", actorId: args.actorId });
  const gaps = coverageGaps(branchId, yearMonth);
  for (const g of gaps) raise(branchId, yearMonth, "coverage_gap", `${g.positionId}:${g.date}`, g);
  return { opened: true, closeDate, audience: bookingAudience(branchId, yearMonth), gaps };
}

/** The roster changed after booking opened: how many of the month's bookings no longer hold. */
export function pendingAlerts(branchId: number): Array<{ id: number; yearMonth: string; kind: string; payload: unknown }> {
  return (getDb().prepare("SELECT id, year_month AS ym, kind, payload_json AS p FROM special_duty_alerts WHERE branch_id = ? AND notified_at IS NULL ORDER BY id").all(branchId) as Array<{ id: number; ym: string; kind: string; p: string | null }>)
    .map((r) => ({ id: r.id, yearMonth: r.ym, kind: r.kind, payload: r.p ? JSON.parse(r.p) : null }));
}
export function markAlertsNotified(ids: number[]): void {
  const st = getDb().prepare("UPDATE special_duty_alerts SET notified_at = ? WHERE id = ?");
  const now = new Date().toISOString();
  for (const id of ids) st.run(now, id);
}
