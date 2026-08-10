import Database from "better-sqlite3";
import { getDb } from "./db";

// Payroll-facing MEALPASS helpers, split out of mealpass.ts to avoid an import
// cycle: mealpass.ts → service-charge.ts → payroll-compute.ts would otherwise
// close a loop back onto mealpass.ts. This module imports only ./db, so
// payroll-compute.ts can pull the cross-company deduction from here safely.

/** Home branch of an employee = their primary branch (else lowest-id branch).
 *  The cross-company payroll charge is deducted ONCE, in this branch's round. */
export function resolveHomeBranchId(userId: number, db: Database.Database = getDb()): number | null {
  const row = db.prepare(`
    SELECT ub.branch_id AS bid FROM user_branches ub
    WHERE ub.user_id = ? ORDER BY ub.is_primary DESC, ub.branch_id ASC LIMIT 1
  `).get(userId) as { bid: number } | undefined;
  return row?.bid ?? null;
}

/** Sum of confirmed cross-company (ศาลาชิลล์) payroll charges to DEDUCT from a
 *  payslip. Deducted once, in the buyer's HOME-branch round (owner 2026-08-10),
 *  windowed by the order date so it lands in the round covering the purchase —
 *  mirrors sumRedeemedDrinksForUser. Returns 0 for any non-home-branch round.
 *  A combined / company-wide round (null branch) has a single line, so deduct
 *  there without the home-branch gate. */
export function sumCrossCompanyChargesForUser(
  userId: number,
  startDate: string,
  endDate: string,
  periodBranchId: number | null,
  db: Database.Database = getDb()
): number {
  if (periodBranchId != null) {
    const homeBranch = resolveHomeBranchId(userId, db);
    if (homeBranch == null || homeBranch !== periodBranchId) return 0;
  }
  const r = db.prepare(`
    SELECT COALESCE(SUM(l.baht), 0) AS n
    FROM mealpass_ledger l JOIN mealpass_orders o ON o.id = l.order_id
    WHERE l.user_id = ? AND l.entry_type = 'payroll_charge'
      AND o.order_date >= ? AND o.order_date <= ?
  `).get(userId, startDate, endDate) as { n: number };
  return r.n;
}
