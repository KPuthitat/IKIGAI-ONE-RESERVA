import { getDb } from "@/lib/db";
import { type OrderRow } from "@/lib/inventa-orders";

// Server-only by usage: imported only by the two server page.tsx files. It
// pulls in better-sqlite3 (via getDb), so a client component must never
// import it.
/** Recent purchase orders for a branch, newest first. Shared by the create
 *  workspace (/staff/inventa/orders) and the tracking page
 *  (/staff/inventa/orders/list) so the SELECT lives in exactly one place. */
export function getBranchOrders(branchId: number | null, limit: number): OrderRow[] {
  return getDb()
    .prepare(
      `
    SELECT o.id, o.status, o.note, o.created_at, o.sent_at, o.approved_at,
           (SELECT COUNT(*) FROM inventa_order_lines l WHERE l.order_id = o.id) AS line_count,
           (SELECT COALESCE(SUM(l.order_qty * l.unit_cost_at_order), 0)
              FROM inventa_order_lines l WHERE l.order_id = o.id) AS total_cost,
           (SELECT s.name FROM inventa_order_lines l
              JOIN inventa_suppliers s ON s.id = l.supplier_id
              WHERE l.order_id = o.id LIMIT 1) AS supplier_name,
           cu.display_name AS created_by_name,
           au.display_name AS approved_by_name
    FROM inventa_orders o
    LEFT JOIN users cu ON cu.id = o.created_by
    LEFT JOIN users au ON au.id = o.approved_by
    WHERE o.branch_id IS ? OR o.branch_id = ?
    ORDER BY o.created_at DESC
    LIMIT ?
  `
    )
    .all(branchId, branchId, limit) as OrderRow[];
}
