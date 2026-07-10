import { getDb } from "@/lib/db";
import { getOrder, getOrderItems, type OrderRow } from "./orders";
import { createIncome } from "@/lib/accounta-db";
import { startVisit, addOrders, endVisit } from "@/lib/insigna/visits";

// DELIVERA integration hooks (commit 7/8). Cross-module side effects fired at
// order milestones, each IDEMPOTENT (one-shot flag on the order) and BEST-EFFORT
// (a hook failure is logged, never blocks the order flow):
//   • INVENTA — deduct stock when the kitchen starts cooking ('preparing').
//   • ACCOUNTA — post the sale as income when the order completes.
//   • INSIGNA — record the delivery as a customer visit (feeds analytics).
// Ownership/branch scoping is the caller's; these run after a validated action.

function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** INVENTA: on cook-start, decrement current_qty for each order line whose menu
 *  item is coupled to a stock item (delivera_menu_items.inventa_item_id). One
 *  menu unit = one stock unit (retail-item coupling; prepared food has no BOM,
 *  so those items simply carry no link). Clamped at 0. */
export function applyStockDeduction(orderId: number): void {
  const db = getDb();
  const order = getOrder(orderId);
  if (!order || order.stock_deducted) return;
  try {
    const rows = db.prepare(
      `SELECT oi.qty AS qty, m.inventa_item_id AS item_id
         FROM delivery_order_items oi
         JOIN delivera_menu_items m ON m.id = oi.menu_item_id
        WHERE oi.order_id = ? AND m.inventa_item_id IS NOT NULL`
    ).all(orderId) as Array<{ qty: number; item_id: number }>;
    const dec = db.prepare("UPDATE inventa_items SET current_qty = MAX(0, current_qty - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of rows) dec.run(r.qty, r.item_id);
      db.prepare("UPDATE delivery_orders SET stock_deducted = 1 WHERE id = ?").run(orderId);
    });
    tx();
  } catch (e) {
    console.warn(`[delivera] stock deduction failed for order ${orderId}:`, (e as Error).message);
  }
}

/** ACCOUNTA: post the completed order's total as DELIVERA sales income (once). */
export function applyAccountaIncome(order: OrderRow): void {
  const db = getDb();
  if (order.income_posted || order.branch_id == null) return;
  try {
    const company = db.prepare("SELECT company_id FROM branches WHERE id = ?").get(order.branch_id) as { company_id: number | null } | undefined;
    createIncome(1, {
      branch_id: order.branch_id, company_id: company?.company_id ?? null,
      income_date: todayBkk(), channel: "DELIVERA", amount: order.total,
      note: `เดลิเวอรี่ ${order.order_no}`, is_vat: true, is_revenue: true
    });
    db.prepare("UPDATE delivery_orders SET income_posted = 1 WHERE id = ?").run(order.id);
  } catch (e) {
    console.warn(`[delivera] accounta income failed for order ${order.id}:`, (e as Error).message);
  }
}

/** INSIGNA: record the completed delivery as a customer visit + its order lines,
 *  so frequency / revenue / repeat-order analytics include delivery customers. */
export function applyInsignaSignal(order: OrderRow): void {
  const db = getDb();
  if (order.insigna_recorded) return;
  try {
    const { visit_token } = startVisit({
      customer_hash: order.customer_hash, party_size: 1, party_type: "UNKNOWN", visit_trigger_src: "DELIVERA"
    });
    const items = getOrderItems(order.id).map((it) => ({
      menu_id: String(it.menu_item_id), menu_name: it.name_th, category: "OTHER" as const,
      quantity: it.qty, unit_price: it.unit_price
    }));
    if (items.length) addOrders(visit_token, items);
    endVisit(visit_token, undefined, `DELIVERA ${order.order_no}`);
    db.prepare("UPDATE delivery_orders SET insigna_recorded = 1 WHERE id = ?").run(order.id);
  } catch (e) {
    console.warn(`[delivera] insigna signal failed for order ${order.id}:`, (e as Error).message);
  }
}

export type OrderHookEvent = "cooking" | "completed";

/** Fire the hooks for a milestone. `cooking` → INVENTA; `completed` → ACCOUNTA +
 *  INSIGNA. Safe to call more than once (each side effect is idempotent). */
export function runOrderHooks(orderId: number, event: OrderHookEvent): void {
  if (event === "cooking") { applyStockDeduction(orderId); return; }
  const order = getOrder(orderId);
  if (!order) return;
  applyAccountaIncome(order);
  applyInsignaSignal(order);
}
