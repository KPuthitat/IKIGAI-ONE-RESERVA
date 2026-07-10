import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import type Database from "better-sqlite3";
import { hashLineUserId } from "@/lib/insigna/hash";
import { encryptSecret } from "@/lib/secret-vault";
import { quote, round2, type QuoteResult } from "./quote";

// DELIVERA order server core — reused by the customer API (commit 3), kitchen
// board (5), integration hooks (7) and notifications (8). All reads/writes are
// branch-scoped by the caller (app-layer isolation).

export type OrderStatus =
  | "pending_payment" | "paid" | "confirmed" | "preparing" | "ready"
  | "assigned" | "picked_up" | "delivered" | "completed" | "cancelled";

export type MenuItem = {
  id: number; branch_id: number; name_th: string; category: string | null;
  price: number; is_available: number; sort_order: number; image_url: string | null;
  inventa_item_id: number | null;
};

export function listMenu(branchId: number, opts?: { availableOnly?: boolean }): MenuItem[] {
  const db = getDb();
  const where = opts?.availableOnly ? "AND is_available = 1" : "";
  return db
    .prepare(`SELECT * FROM delivera_menu_items WHERE branch_id = ? ${where} ORDER BY sort_order, name_th`)
    .all(branchId) as MenuItem[];
}

export function createMenuItem(branchId: number, m: {
  name_th: string; category?: string | null; price: number;
  is_available?: boolean; sort_order?: number; image_url?: string | null; inventa_item_id?: number | null;
}): number {
  const info = getDb()
    .prepare(`INSERT INTO delivera_menu_items (branch_id, name_th, category, price, is_available, sort_order, image_url, inventa_item_id)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(branchId, m.name_th, m.category ?? null, m.price, m.is_available === false ? 0 : 1,
         m.sort_order ?? 0, m.image_url ?? null, m.inventa_item_id ?? null);
  return Number(info.lastInsertRowid);
}

export function updateMenuItem(id: number, branchId: number, patch: Partial<{
  name_th: string; category: string | null; price: number; is_available: boolean;
  sort_order: number; image_url: string | null; inventa_item_id: number | null;
}>): boolean {
  const cur = getDb().prepare("SELECT * FROM delivera_menu_items WHERE id = ? AND branch_id = ?").get(id, branchId) as MenuItem | undefined;
  if (!cur) return false;
  const r = getDb().prepare(
    `UPDATE delivera_menu_items SET name_th=?, category=?, price=?, is_available=?, sort_order=?, image_url=?, inventa_item_id=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND branch_id=?`
  ).run(
    patch.name_th ?? cur.name_th,
    patch.category !== undefined ? patch.category : cur.category,
    patch.price ?? cur.price,
    patch.is_available !== undefined ? (patch.is_available ? 1 : 0) : cur.is_available,
    patch.sort_order ?? cur.sort_order,
    patch.image_url !== undefined ? patch.image_url : cur.image_url,
    patch.inventa_item_id !== undefined ? patch.inventa_item_id : cur.inventa_item_id,
    id, branchId
  );
  return r.changes > 0;
}

// ─── Orders ────────────────────────────────────────────────────────────────

export type OrderRow = {
  id: number; branch_id: number; order_no: string; customer_hash: string;
  customer_display_name: string | null; phone_enc: string | null;
  fulfillment: "delivery" | "pickup"; dest_address: string | null;
  dest_lat: number | null; dest_lng: number | null; distance_km: number | null;
  zone_id: number | null; subtotal: number; delivery_fee: number; total: number;
  status: OrderStatus; pay_method: "promptpay" | "cod" | null;
  pay_status: "unpaid" | "pending_verify" | "verified" | "failed" | "refunded";
  time_slot: string | null; note: string | null; created_at: string; updated_at: string;
  stock_deducted?: number; income_posted?: number; insigna_recorded?: number;
};

export type OrderItemRow = {
  id: number; order_id: number; menu_item_id: number; name_th: string;
  qty: number; unit_price: number; options_json: string; line_total: number;
};

export type CreateOrderInput = {
  branchId: number;
  lineUserId: string;                    // from LIFF — hashed, never stored raw
  customerDisplayName?: string | null;
  phone?: string | null;
  fulfillment: "delivery" | "pickup";
  destAddress?: string | null;
  destLat?: number | null;
  destLng?: number | null;
  timeSlot?: string | null;
  note?: string | null;
  items: Array<{ menu_item_id: number; qty: number; options_json?: string }>;
};

/** DLV-YYMMDD-XXXX in Asia/Bangkok. UNIQUE column + retry guard collisions. */
export function genOrderNo(now: Date = new Date()): string {
  const bkk = new Date(now.getTime() + 7 * 3600_000);
  const yy = String(bkk.getUTCFullYear()).slice(2);
  const mm = String(bkk.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(bkk.getUTCDate()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `DLV-${yy}${mm}${dd}-${rand}`;
}

function uniqueOrderNo(db: Database.Database): string {
  const exists = db.prepare("SELECT 1 FROM delivery_orders WHERE order_no = ?");
  for (let i = 0; i < 8; i++) {
    const no = genOrderNo();
    if (!exists.get(no)) return no;
  }
  throw new Error("order_no_collision");
}

export class OrderError extends Error {
  constructor(public code: string, public detail?: unknown) { super(code); this.name = "OrderError"; }
}

/** Create an order. Prices AND the delivery quote are recomputed server-side —
 *  the client's numbers are never trusted. Returns the authoritative figures. */
export function createOrder(input: CreateOrderInput): {
  id: number; orderNo: string; subtotal: number; deliveryFee: number; total: number; quote: QuoteResult | null;
} {
  const db = getDb();
  if (!input.items?.length) throw new OrderError("empty_cart");

  // 1. authoritative pricing from the menu table
  const getItem = db.prepare("SELECT id, name_th, price, is_available FROM delivera_menu_items WHERE id = ? AND branch_id = ?");
  const priced = input.items.map((it) => {
    const m = getItem.get(it.menu_item_id, input.branchId) as { id: number; name_th: string; price: number; is_available: number } | undefined;
    if (!m) throw new OrderError("menu_item_not_found", it.menu_item_id);
    if (!m.is_available) throw new OrderError("menu_item_unavailable", it.menu_item_id);
    if (!Number.isInteger(it.qty) || it.qty <= 0) throw new OrderError("bad_qty", it.menu_item_id);
    return { menu_item_id: m.id, name_th: m.name_th, qty: it.qty, unit_price: m.price,
             options_json: it.options_json ?? "{}", line_total: round2(m.price * it.qty) };
  });
  const subtotal = round2(priced.reduce((s, p) => s + p.line_total, 0));

  // 2. server-side quote for delivery (never trust client fee)
  let q: QuoteResult | null = null;
  let deliveryFee = 0, zoneId: number | null = null, distanceKm: number | null = null;
  if (input.fulfillment === "delivery") {
    if (input.destLat == null || input.destLng == null) throw new OrderError("dest_location_required");
    q = quote({ branchId: input.branchId, destLat: input.destLat, destLng: input.destLng, subtotal });
    if (!q.meetsMin) throw new OrderError("below_min_order", q.minOrder);
    deliveryFee = q.deliveryFee; zoneId = q.zoneId; distanceKm = q.distanceKm;
  }
  const total = round2(subtotal + deliveryFee);

  // 3. persist
  const orderNo = uniqueOrderNo(db);
  const customerHash = hashLineUserId(input.lineUserId);
  const phoneEnc = input.phone ? encryptSecret(input.phone) : null;
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO delivery_orders
         (branch_id, order_no, customer_hash, customer_display_name, phone_enc, fulfillment,
          dest_address, dest_lat, dest_lng, distance_km, zone_id, subtotal, delivery_fee, total,
          status, pay_status, time_slot, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'pending_payment', 'unpaid', ?, ?)`
    ).run(input.branchId, orderNo, customerHash, input.customerDisplayName ?? null, phoneEnc, input.fulfillment,
          input.destAddress ?? null, input.destLat ?? null, input.destLng ?? null, distanceKm, zoneId,
          subtotal, deliveryFee, total, input.timeSlot ?? null, input.note ?? null);
    const orderId = Number(info.lastInsertRowid);
    const insItem = db.prepare(
      `INSERT INTO delivery_order_items (order_id, menu_item_id, name_th, qty, unit_price, options_json, line_total)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const p of priced) insItem.run(orderId, p.menu_item_id, p.name_th, p.qty, p.unit_price, p.options_json, p.line_total);
    return orderId;
  });
  const id = tx();
  return { id, orderNo, subtotal, deliveryFee, total, quote: q };
}

export function getOrder(id: number): OrderRow | null {
  return (getDb().prepare("SELECT * FROM delivery_orders WHERE id = ?").get(id) as OrderRow | undefined) ?? null;
}
export function getOrderByNo(orderNo: string): OrderRow | null {
  return (getDb().prepare("SELECT * FROM delivery_orders WHERE order_no = ?").get(orderNo) as OrderRow | undefined) ?? null;
}
export function getOrderItems(orderId: number): OrderItemRow[] {
  return getDb().prepare("SELECT * FROM delivery_order_items WHERE order_id = ? ORDER BY id").all(orderId) as OrderItemRow[];
}

/** Customer-scoped tracking read: only returns the order when it belongs to the
 *  given LIFF identity (customer_hash match), and only public-safe fields. */
export function getOrderForCustomer(orderNo: string, lineUserId: string): {
  order_no: string; status: OrderStatus; fulfillment: string; total: number;
  pay_status: string; time_slot: string | null; created_at: string;
} | null {
  const o = getOrderByNo(orderNo);
  if (!o) return null;
  if (o.customer_hash !== hashLineUserId(lineUserId)) return null;
  return {
    order_no: o.order_no, status: o.status, fulfillment: o.fulfillment, total: o.total,
    pay_status: o.pay_status, time_slot: o.time_slot, created_at: o.created_at
  };
}

export function listOrders(branchId: number, statuses?: OrderStatus[]): OrderRow[] {
  const db = getDb();
  if (statuses?.length) {
    const ph = statuses.map(() => "?").join(",");
    return db.prepare(`SELECT * FROM delivery_orders WHERE branch_id = ? AND status IN (${ph}) ORDER BY created_at`)
      .all(branchId, ...statuses) as OrderRow[];
  }
  return db.prepare("SELECT * FROM delivery_orders WHERE branch_id = ? ORDER BY created_at DESC").all(branchId) as OrderRow[];
}

// Allowed forward transitions (kitchen/rider drive these). cancelled is reachable
// from any non-terminal state.
const FLOW: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["paid", "confirmed", "cancelled"],
  paid: ["confirmed", "preparing", "cancelled"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  // ready → completed is the pickup hand-off (no rider leg); delivery goes via assigned/picked_up.
  ready: ["assigned", "picked_up", "completed", "cancelled"],
  assigned: ["picked_up", "cancelled"],
  picked_up: ["delivered", "cancelled"],
  delivered: ["completed"],
  completed: [],
  cancelled: []
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return FLOW[from]?.includes(to) ?? false;
}

/** Set order status if the transition is legal. Returns the new status or throws. */
export function setOrderStatus(orderId: number, to: OrderStatus, opts?: { force?: boolean }): OrderStatus {
  const o = getOrder(orderId);
  if (!o) throw new OrderError("order_not_found", orderId);
  if (!opts?.force && o.status !== to && !canTransition(o.status, to)) {
    throw new OrderError("illegal_transition", { from: o.status, to });
  }
  getDb().prepare("UPDATE delivery_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(to, orderId);
  return to;
}
