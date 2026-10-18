// ตำแหน่งงานค่าตอบแทนพิเศษ — pay and budget (owner 2026-10-11).
//
// Only days the manager has APPROVED are paid. The payee is whoever did the duty (the
// substitute if there was one, else the holder) and the amount is the position's daily
// rate for that month. A month's duty days are paid with the service charge of that
// month, on the 20th of the next month, booked to the BRANCH that owns the position,
// taxed like service charge (3% withheld for withholding-tax staff, none for
// social-security staff) — the tax itself is applied in service-charge.ts.

import { getDb } from "./db";
import { cfgNum, daysInMonth, listPositions, monthBudget } from "./special-duty";
import { sqlNameWithPrefix } from "./name";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** branchId → (userId → gross) of approved duty days whose date falls in `yearMonth`. */
export function dutyFeeGrossByBranchUser(yearMonth: string): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  const rows = getDb().prepare(`
    SELECT p.branch_id AS b, COALESCE(d.performer_user_id, d.user_id) AS uid, SUM(p.daily_rate) AS gross
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id
     WHERE d.status = 'approved' AND substr(d.duty_date, 1, 7) = ?
     GROUP BY p.branch_id, uid
  `).all(yearMonth) as Array<{ b: number; uid: number; gross: number }>;
  for (const r of rows) {
    const g = round2(r.gross || 0);
    if (g <= 0) continue;
    const m = out.get(r.b) ?? new Map<number, number>();
    m.set(r.uid, g); out.set(r.b, m);
  }
  return out;
}

export type DutyMonthSummary = {
  branchId: number; yearMonth: string;
  budget: number;                 // every day of every active position × rate (the most the month could cost)
  approvedDays: number; approvedAmount: number;
  pendingDays: number;            // booked / assigned / covered / submitted, not yet approved
  absentDays: number;
  unfilledDays: number;           // position-days with nobody on them
  heldDays: number;
  byPerson: Array<{ userId: number; name: string; days: number }>;
};

export function dutyMonthSummary(branchId: number, yearMonth: string): DutyMonthSummary {
  const db = getDb();
  const positions = listPositions(branchId, yearMonth, { activeOnly: true });
  const rows = db.prepare(`
    SELECT d.status, d.user_id AS uid, COALESCE(d.performer_user_id, d.user_id) AS payee, p.daily_rate AS rate, ${sqlNameWithPrefix("u")} AS name
      FROM special_duty_days d JOIN special_duty_positions p ON p.id = d.position_id JOIN users u ON u.id = d.user_id
     WHERE p.branch_id = ? AND p.year_month = ? AND p.active = 1
  `).all(branchId, yearMonth) as Array<{ status: string; uid: number; payee: number; rate: number; name: string }>;
  const total = positions.length * daysInMonth(yearMonth);
  const approved = rows.filter((r) => r.status === "approved");
  const holders = new Map<number, { name: string; days: number }>();
  for (const r of rows) { const h = holders.get(r.uid) ?? { name: r.name, days: 0 }; h.days++; holders.set(r.uid, h); }
  return {
    branchId, yearMonth, budget: monthBudget(branchId, yearMonth),
    approvedDays: approved.length, approvedAmount: round2(approved.reduce((s, r) => s + r.rate, 0)),
    pendingDays: rows.filter((r) => ["booked", "assigned", "covered", "submitted"].includes(r.status)).length,
    absentDays: rows.filter((r) => r.status === "absent").length,
    unfilledDays: Math.max(0, total - rows.length), heldDays: rows.length,
    byPerson: [...holders.entries()].map(([userId, h]) => ({ userId, name: h.name, days: h.days })).sort((a, b) => b.days - a.days)
  };
}

export type DutyOwnerAlert = { kind: "few_people" | "too_many_days"; text: string };

/** Things the owner should look at: too few people sharing the duty, or one person carrying too many days. */
export function dutyOwnerAlerts(branchId: number, yearMonth: string): DutyOwnerAlert[] {
  const s = dutyMonthSummary(branchId, yearMonth);
  const alerts: DutyOwnerAlert[] = [];
  const minPeople = cfgNum("owner_alert_min_bookers", branchId), maxDays = cfgNum("owner_alert_max_days_per_person", branchId);
  if (s.heldDays > 0 && s.byPerson.length < minPeople) alerts.push({ kind: "few_people", text: `มีผู้ได้รับตำแหน่งเพียง ${s.byPerson.length} คน ต่ำกว่าเกณฑ์ ${minPeople} คน` });
  for (const p of s.byPerson) if (p.days > maxDays) alerts.push({ kind: "too_many_days", text: `${p.name} ได้รับตำแหน่ง ${p.days} วัน เกินเกณฑ์ ${maxDays} วันต่อเดือน` });
  return alerts;
}
