import { getDb } from "@/lib/db";
import { getOrder, getOrderItems, setOrderStatus, OrderError, type OrderRow, type OrderItemRow, type OrderStatus } from "./orders";
import { confirmSlipManually } from "./payment";

// DELIVERA kitchen board (commit 5/8). Staff-facing, session-authed +
// branch-scoped by the caller (requirePermission('delivera.manage') + the
// active branch). No Supabase Realtime → the client polls.

export type KitchenOrder = {
  order: OrderRow;
  items: OrderItemRow[];
};

/** Live orders for a branch's kitchen board — everything not yet completed or
 *  cancelled, oldest first (FIFO cooking queue). */
export function listKitchenOrders(branchId: number): KitchenOrder[] {
  const rows = getDb()
    .prepare("SELECT * FROM delivery_orders WHERE branch_id = ? AND status NOT IN ('completed','cancelled') ORDER BY created_at")
    .all(branchId) as OrderRow[];
  return rows.map((order) => ({ order, items: getOrderItems(order.id) }));
}

/** Fetch an order only when it belongs to `branchId` (app-layer isolation). */
function ownedOrder(orderId: number, branchId: number): OrderRow {
  const o = getOrder(orderId);
  if (!o || o.branch_id !== branchId) throw new OrderError("order_not_found", orderId);
  return o;
}

/** Advance an order to the next kitchen state (legal transitions only). */
export function advanceKitchenOrder(orderId: number, branchId: number, to: OrderStatus): OrderStatus {
  ownedOrder(orderId, branchId);
  return setOrderStatus(orderId, to);
}

/** Cancel an order (allowed from any non-terminal state). */
export function cancelKitchenOrder(orderId: number, branchId: number): OrderStatus {
  ownedOrder(orderId, branchId);
  return setOrderStatus(orderId, "cancelled");
}

/** Manually confirm a queued PromptPay slip (before SlipOK is provisioned, or as
 *  an override). Marks the payment verified + moves the order to 'paid'. */
export function confirmOrderSlip(orderId: number, branchId: number): void {
  ownedOrder(orderId, branchId);
  confirmSlipManually(orderId);
}
