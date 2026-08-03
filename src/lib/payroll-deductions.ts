import { getDb } from "./db";

// Itemised other-deductions on a payroll line (กยศ. / เงินกู้ / ค่าปรับ …).
// Their SUM is written back to payroll_lines.other_deductions and net is
// recomputed, so the ledger stays consistent while the breakdown lives here.

export type LineDeduction = { id: number; period_id: number; user_id: number; label: string; amount: number };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function listLineDeductions(periodId: number, userId: number): LineDeduction[] {
  return getDb()
    .prepare("SELECT id, period_id, user_id, label, amount FROM payroll_line_deductions WHERE period_id = ? AND user_id = ? ORDER BY id")
    .all(periodId, userId) as LineDeduction[];
}

export function sumLineDeductions(periodId: number, userId: number): number {
  const row = getDb()
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payroll_line_deductions WHERE period_id = ? AND user_id = ?")
    .get(periodId, userId) as { s: number };
  return r2(row.s);
}

/** Recompute other_deductions = Σ named deductions, and net = gross − sso − tax
 *  − other_deductions for the line. Returns the new total (null if no line). */
export function applyDeductionsToLine(periodId: number, userId: number): number | null {
  const db = getDb();
  const line = db
    .prepare("SELECT gross_pay, sso_amount, tax_amount FROM payroll_lines WHERE period_id = ? AND user_id = ?")
    .get(periodId, userId) as { gross_pay: number; sso_amount: number; tax_amount: number } | undefined;
  if (!line) return null;
  const total = sumLineDeductions(periodId, userId);
  const net = r2(line.gross_pay - line.sso_amount - line.tax_amount - total);
  db.prepare(
    "UPDATE payroll_lines SET other_deductions = ?, net_pay = ?, reviewed_at = NULL, reviewed_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE period_id = ? AND user_id = ?"
  ).run(total, net, periodId, userId);
  return total;
}

export function addLineDeduction(periodId: number, userId: number, label: string, amount: number, createdBy: number): number {
  const info = getDb()
    .prepare("INSERT INTO payroll_line_deductions (period_id, user_id, label, amount, created_by) VALUES (?,?,?,?,?)")
    .run(periodId, userId, label.trim(), r2(amount), createdBy);
  applyDeductionsToLine(periodId, userId);
  return Number(info.lastInsertRowid);
}

/** Delete a deduction; returns its (period,user) so the caller can react.
 *  Recomputes the line total. */
export function deleteLineDeduction(id: number): { periodId: number; userId: number } | null {
  const db = getDb();
  const row = db.prepare("SELECT period_id, user_id FROM payroll_line_deductions WHERE id = ?").get(id) as
    { period_id: number; user_id: number } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM payroll_line_deductions WHERE id = ?").run(id);
  applyDeductionsToLine(row.period_id, row.user_id);
  return { periodId: row.period_id, userId: row.user_id };
}
