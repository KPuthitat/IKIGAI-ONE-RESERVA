import { pushRider } from "./line";
import { riderLineReady } from "./env";
import { getRider } from "./rider";
import { getOrder, getOrderItems } from "./orders";

// DELIVERA notifications (commit 8/8). Best-effort LINE pushes.
//
// Customers are stored as customer_hash only (privacy) with no raw LINE id, so
// there is nothing to push to — the customer's live updates come from the track
// page polling instead. Riders DO store their raw LINE userId (needed to reach
// them), so we push a new-job alert to the assigned rider. Silent no-op when the
// rider channel isn't configured (dark ship) or the push fails.

/** Alert a rider that a job was assigned to them. Fire-and-forget safe. */
export async function notifyRiderNewJob(riderId: number, orderId: number): Promise<void> {
  try {
    if (!riderLineReady()) return;
    const rider = getRider(riderId);
    const order = getOrder(orderId);
    if (!rider?.line_user_id || !order) return;
    const items = getOrderItems(orderId);
    const lines = items.slice(0, 5).map((i) => `• ${i.name_th} ×${i.qty}`).join("\n");
    const cod = order.pay_method === "cod" ? `\nเก็บปลายทาง ฿${order.total.toLocaleString("th-TH")}` : "";
    const dest = order.fulfillment === "delivery" && order.dest_address ? `\nส่งที่: ${order.dest_address}` : "";
    const text =
      `งานใหม่ ${order.order_no}\n${lines}${items.length > 5 ? "\n…" : ""}` +
      `\nยอด ฿${order.total.toLocaleString("th-TH")}${cod}${dest}` +
      `\n\nเปิดแอปทีมงานส่งสุข เพื่อรับงาน`;
    await pushRider(rider.line_user_id, [{ type: "text", text }]);
  } catch {
    /* best-effort — a failed push must never break dispatch */
  }
}
