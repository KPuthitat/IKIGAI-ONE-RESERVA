import { getDb } from "@/lib/db";
import { getOrder, OrderError } from "./orders";

// DELIVERA COD reconciliation (commit 8/8). A rider collects cash on delivery;
// the shop then reconciles that the rider handed the money over
// (deliveries.cod_settled). Branch-scoped by the caller.

export type UnsettledCod = {
  order_id: number; order_no: string; rider_id: number | null; rider_name: string | null;
  cod_amount: number; delivered_at: string | null;
};

/** COD deliveries a branch has NOT yet reconciled (delivered, cod_amount > 0). */
export function listUnsettledCod(branchId: number): UnsettledCod[] {
  return getDb().prepare(
    `SELECT o.id AS order_id, o.order_no, d.rider_id, r.display_name AS rider_name,
            d.cod_amount, d.delivered_at
       FROM deliveries d
       JOIN delivery_orders o ON o.id = d.order_id
       LEFT JOIN riders r ON r.id = d.rider_id
      WHERE o.branch_id = ? AND d.cod_amount > 0 AND d.cod_settled = 0 AND d.delivered_at IS NOT NULL
      ORDER BY d.delivered_at`
  ).all(branchId) as UnsettledCod[];
}

export type CodSummary = { count: number; amount: number };
export function codSummary(branchId: number): CodSummary {
  const r = getDb().prepare(
    `SELECT COUNT(*) AS count, COALESCE(SUM(d.cod_amount),0) AS amount
       FROM deliveries d JOIN delivery_orders o ON o.id = d.order_id
      WHERE o.branch_id = ? AND d.cod_amount > 0 AND d.cod_settled = 0 AND d.delivered_at IS NOT NULL`
  ).get(branchId) as { count: number; amount: number };
  return { count: r.count, amount: Math.round(r.amount * 100) / 100 };
}

/** Mark an order's COD as handed over (branch-scoped). Idempotent. */
export function settleCod(orderId: number, branchId: number): void {
  const order = getOrder(orderId);
  if (!order || order.branch_id !== branchId) throw new OrderError("order_not_found", orderId);
  getDb().prepare(
    "UPDATE deliveries SET cod_settled = 1, updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND cod_amount > 0"
  ).run(orderId);
}
