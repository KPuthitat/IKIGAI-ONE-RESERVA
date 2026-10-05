// OT requests still waiting for a decision inside a payroll round (owner
// 2026-10-05). The pay engine only credits OT whose request is approved, so
// paying while one is pending silently drops that OT from the paid amount.
// Same "pending" definition as the OT approvals page: a late segment is pending
// when it has a time, an early segment when it has a start.

import type Database from "better-sqlite3";
import { nameWithPrefix } from "./name";

export type PendingOtItem = {
  user_id: number;
  name: string;
  work_date: string;            // YYYY-MM-DD (BKK)
  kind: "late" | "early" | "both";
};

export function listPendingOtForPeriod(db: Database.Database, periodId: number): PendingOtItem[] {
  const rows = db.prepare(`
    SELECT o.user_id, o.work_date, u.display_name, u.title_prefix,
           (o.status = 'pending' AND o.requested_until != '') AS late_pending,
           (o.early_status = 'pending' AND o.requested_from IS NOT NULL) AS early_pending
      FROM ot_requests o
      JOIN payroll_periods p ON p.id = ?
      JOIN users u ON u.id = o.user_id
     WHERE o.work_date >= p.period_start AND o.work_date <= p.period_end
       AND o.user_id IN (SELECT user_id FROM payroll_lines WHERE period_id = p.id)
       AND ((o.status = 'pending' AND o.requested_until != '')
         OR (o.early_status = 'pending' AND o.requested_from IS NOT NULL))
     ORDER BY o.work_date, u.display_name
  `).all(periodId) as Array<{
    user_id: number; work_date: string; display_name: string; title_prefix: string | null;
    late_pending: number; early_pending: number;
  }>;
  return rows.map((r) => ({
    user_id: r.user_id,
    name: nameWithPrefix(r.title_prefix, r.display_name),
    work_date: r.work_date,
    kind: r.late_pending && r.early_pending ? "both" : r.early_pending ? "early" : "late"
  }));
}
