import { getDb } from "@/lib/db";
import { getOrder, getOrderItems, setOrderStatus, OrderError, type OrderRow, type OrderItemRow, type OrderStatus } from "./orders";
import { confirmSlipManually } from "./payment";
import { getDeliveryForOrder, getRider, assignRider, type DeliveryRow } from "./rider";

// DELIVERA kitchen board (commit 5/8, dispatch added 6/8). Staff-facing,
// session-authed + branch-scoped by the caller (requirePermission +
// active branch). No Supabase Realtime → the client polls.

export type KitchenOrder = {
  order: OrderRow;
  items: OrderItemRow[];
  // Rider tracking for assigned/in-transit orders (owner 2026-07-10) — who's
  // on it + how far along. null before dispatch.
  rider: { id: number; name: string; phone: string | null } | null;
  delivery: Pick<DeliveryRow, "assigned_at" | "accepted_at" | "picked_up_at" | "delivered_at"> | null;
};

/** Live orders for a branch's kitchen board — everything not yet completed or
 *  cancelled, oldest first (FIFO cooking queue) + rider progress. */
export function listKitchenOrders(branchId: number): KitchenOrder[] {
  const rows = getDb()
    .prepare("SELECT * FROM delivery_orders WHERE branch_id = ? AND status NOT IN ('completed','cancelled') ORDER BY created_at")
    .all(branchId) as OrderRow[];
  return rows.map((order) => {
    const d = getDeliveryForOrder(order.id);
    const r = d?.rider_id ? getRider(d.rider_id) : null;
    return {
      order, items: getOrderItems(order.id),
      rider: r ? { id: r.id, name: r.display_name, phone: r.phone } : null,
      delivery: d ? { assigned_at: d.assigned_at, accepted_at: d.accepted_at, picked_up_at: d.picked_up_at, delivered_at: d.delivered_at } : null
    };
  });
}

/** Dispatch a rider to an order (branch-scoped via rider.assignRider). */
export function dispatchRider(orderId: number, branchId: number, riderId: number): void {
  assignRider(orderId, riderId, branchId);
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
