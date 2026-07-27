import type Database from "better-sqlite3";

// A "company payroll cycle" is the set of per-branch payroll_periods that share
// the same (cycle, target, period_start, period_end, pay_date) across ONE
// company's branches (owner 2026-07-27). Payroll stays computed + posted per
// branch — this just groups the sibling periods so the owner can review and
// operate on the whole cycle at once. Both the read page and the cascade route
// resolve siblings through here so they never drift.

export type CycleRep = {
  id: number;
  cycle: string;
  target: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  branch_id: number | null;
  company_id: number | null;
};

export type CycleSibling = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  status: string;
  finalized_at: string | null;
  paid_at: string | null;
  posted_at: string | null;
  total_gross: number | null;
  total_net: number | null;
  line_count: number;
};

export function resolveCompanyCycle(
  db: Database.Database,
  repId: number
): { rep: CycleRep; siblings: CycleSibling[] } | null {
  const rep = db.prepare(`
    SELECT p.id, p.cycle, p.target, p.period_start, p.period_end, p.pay_date, p.branch_id,
           b.company_id AS company_id
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.id = ?
  `).get(repId) as CycleRep | undefined;
  if (!rep) return null;

  // The company's branches. A legacy NULL-branch period has no company — then
  // the "cycle" is just that one period.
  const companyBranchIds = rep.company_id != null
    ? (db.prepare("SELECT id FROM branches WHERE company_id = ?").all(rep.company_id) as Array<{ id: number }>).map((r) => r.id)
    : [];

  const inClause = companyBranchIds.length > 0
    ? `p.branch_id IN (${companyBranchIds.map(() => "?").join(",")}) OR p.id = ?`
    : `p.id = ?`;
  const args = companyBranchIds.length > 0
    ? [rep.cycle, rep.target, rep.period_start, rep.period_end, rep.pay_date, ...companyBranchIds, rep.id]
    : [rep.cycle, rep.target, rep.period_start, rep.period_end, rep.pay_date, rep.id];

  const siblings = db.prepare(`
    SELECT p.id, p.branch_id, b.name AS branch_name, p.status,
           p.finalized_at, p.paid_at, p.posted_at,
           (SELECT SUM(gross_pay) FROM payroll_lines WHERE period_id = p.id) AS total_gross,
           (SELECT SUM(net_pay)   FROM payroll_lines WHERE period_id = p.id) AS total_net,
           (SELECT COUNT(*)       FROM payroll_lines WHERE period_id = p.id) AS line_count
    FROM payroll_periods p
    LEFT JOIN branches b ON b.id = p.branch_id
    WHERE p.cycle = ? AND p.target = ? AND p.period_start = ? AND p.period_end = ? AND p.pay_date = ?
      AND (${inClause})
    ORDER BY (p.branch_id IS NULL), b.id
  `).all(...args) as CycleSibling[];

  return { rep, siblings };
}
