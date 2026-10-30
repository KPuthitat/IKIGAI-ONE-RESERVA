import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { describeOptions } from "./options-text";
import { createOrder, getOrderItems, setOrderStatus, type OrderRow, type OrderStatus } from "./orders";
import { getBranchSettings } from "./db";
import { buildPromptPayPayload, getPromptPayId, getPromptPayQrUrl } from "./payment";

// Walk-in ordering from the table / counter QR — no LINE login (owner 2026-10-30, modelled on the KOI Alipay mini-program):
// scan → pick items with options → pay by PromptPay (the manager confirms) or at the counter → queue number → live status.
// The customer is identified only by an unguessable token in their tracking link.

export type ServiceMode = "pickup" | "dine_in";

const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

export class GuestError extends Error { constructor(public code: "branch_unavailable" | "order_not_found" | "not_payable" | "cod_disabled" | "promptpay_not_configured" | "rate_limited") { super(code); } }

// ── abuse guard: a public form that creates rows ─────────────────────────
const hits = new Map<string, number[]>();
/** At most `max` orders per `windowMs` per key (the caller's IP). In-memory — fine for a single process. */
export function allowGuestOrder(key: string, now = Date.now(), max = 8, windowMs = 3_600_000): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now); hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  return true;
}

// ── create ───────────────────────────────────────────────────────────────

export type GuestOrderInput = {
  branchId: number; tableLabel?: string | null; name?: string | null; phone?: string | null; note?: string | null;
  items: Array<{ menu_item_id: number; qty: number; choice_ids?: number[] }>;
};

/** Create a walk-in order (prices recomputed server-side by createOrder), then give it a queue number and a tracking token. */
export function createGuestOrder(input: GuestOrderInput): { token: string; orderNo: string; queueNo: number; total: number } {
  const db = getDb();
  const token = crypto.randomBytes(16).toString("hex");
  const table = (input.tableLabel ?? "").trim().slice(0, 20) || null;
  const r = createOrder({
    branchId: input.branchId, lineUserId: `guest:${token}`, customerDisplayName: (input.name ?? "").trim().slice(0, 60) || null,
    phone: input.phone || null, fulfillment: "pickup", note: (input.note ?? "").trim().slice(0, 300) || null, items: input.items
  });
  const day = todayBkk();
  const queueNo = db.transaction(() => {
    const n = ((db.prepare("SELECT COALESCE(MAX(queue_no), 0) AS m FROM delivery_orders WHERE branch_id = ? AND date(created_at, '+7 hours') = ?").get(input.branchId, day) as { m: number }).m) + 1;
    db.prepare("UPDATE delivery_orders SET guest_token = ?, queue_no = ?, table_label = ?, service_mode = ? WHERE id = ?").run(token, n, table, table ? "dine_in" : "pickup", r.id);
    return n;
  })();
  return { token, orderNo: r.orderNo, queueNo, total: r.total };
}

// ── read ─────────────────────────────────────────────────────────────────

export type QueueStats = { inProgress: number; estMinutes: number };

/** Orders the kitchen is working on or has queued today (paid / accepted / cooking) and a rough wait for a new order. */
export function queueStats(branchId: number, aheadOverride?: number): QueueStats {
  const db = getDb();
  const inProgress = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_orders WHERE branch_id = ? AND date(created_at, '+7 hours') = ? AND status IN ('paid','confirmed','preparing')`)
    .get(branchId, todayBkk()) as { n: number }).n;
  const prep = getBranchSettings(branchId).default_prep_minutes || 20;
  const ahead = aheadOverride ?? inProgress;
  // the base prep time plus a share of it for every order ahead (the kitchen cooks several at once)
  return { inProgress, estMinutes: Math.max(1, prep + ahead * Math.ceil(prep / 5)) };
}

export type GuestView = {
  orderNo: string; queueNo: number | null; tableLabel: string | null; service: ServiceMode; status: OrderStatus; payStatus: string; payMethod: string | null;
  total: number; createdAt: string; branchName: string; items: Array<{ name: string; qty: number; options: string; lineTotal: number }>;
  step: 1 | 2 | 3 | 4; ahead: number; estMinutes: number; codEnabled: boolean; hasPromptPay: boolean;
};

export function getGuestOrderRow(token: string): OrderRow | null {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  return (getDb().prepare("SELECT * FROM delivery_orders WHERE guest_token = ?").get(token) as OrderRow | undefined) ?? null;
}

/** Steps shown to the customer: 1 ordered · 2 paid · 3 being made · 4 ready to collect. */
function stepOf(o: OrderRow): 1 | 2 | 3 | 4 {
  if (o.status === "ready" || o.status === "completed" || o.status === "delivered") return 4;
  if (o.status === "preparing") return 3;
  if (o.status === "paid" || o.status === "confirmed") return 2;
  return 1;
}

/** Public-safe view of one order for its owner (found by token). */
export function guestView(token: string): GuestView | null {
  const o = getGuestOrderRow(token);
  if (!o) return null;
  const db = getDb();
  const branchName = (db.prepare("SELECT name FROM branches WHERE id = ?").get(o.branch_id) as { name: string } | undefined)?.name ?? "";
  const ahead = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_orders WHERE branch_id = ? AND date(created_at, '+7 hours') = date(?, '+7 hours') AND id < ? AND status IN ('paid','confirmed','preparing')`)
    .get(o.branch_id, o.created_at, o.id) as { n: number }).n;
  const s = getBranchSettings(o.branch_id);
  const active = ["paid", "confirmed", "preparing"].includes(o.status);
  return {
    orderNo: o.order_no, queueNo: o.queue_no ?? null, tableLabel: o.table_label ?? null, service: o.service_mode === "dine_in" ? "dine_in" : "pickup",
    status: o.status, payStatus: o.pay_status, payMethod: o.pay_method, total: o.total, createdAt: o.created_at, branchName,
    items: getOrderItems(o.id).map((i) => ({ name: i.name_th, qty: i.qty, options: describeOptions(i.options_json), lineTotal: i.line_total })),
    step: stepOf(o), ahead: active ? ahead : 0, estMinutes: active ? queueStats(o.branch_id, ahead).estMinutes : 0,
    codEnabled: s.cod_enabled === 1, hasPromptPay: !!(s.promptpay_id?.trim() || s.promptpay_qr_url?.trim())
  };
}

// ── pay ──────────────────────────────────────────────────────────────────

/** "I have paid" (PromptPay): the order waits for the manager to confirm the money arrived. */
export function guestMarkPaid(token: string): void {
  const o = getGuestOrderRow(token);
  if (!o) throw new GuestError("order_not_found");
  if (o.status !== "pending_payment") throw new GuestError("not_payable");
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM delivery_payments WHERE order_id = ? AND method = 'promptpay'").get(o.id))
    db.prepare("INSERT INTO delivery_payments (order_id, method, amount, status) VALUES (?, 'promptpay', ?, 'pending_verify')").run(o.id, o.total);
  db.prepare("UPDATE delivery_payments SET status = 'pending_verify' WHERE order_id = ? AND method = 'promptpay' AND status = 'unpaid'").run(o.id);
  db.prepare("UPDATE delivery_orders SET pay_method = 'promptpay', pay_status = 'pending_verify', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(o.id);
}

/** "I'll pay at the counter": the kitchen starts straight away and the staff takes the money at hand-over. */
export function guestPayAtCounter(token: string): void {
  const o = getGuestOrderRow(token);
  if (!o) throw new GuestError("order_not_found");
  if (o.status !== "pending_payment") throw new GuestError("not_payable");
  if (getBranchSettings(o.branch_id).cod_enabled !== 1) throw new GuestError("cod_disabled");
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE delivery_orders SET pay_method = 'cod', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(o.id);
    if (!db.prepare("SELECT 1 FROM delivery_payments WHERE order_id = ? AND method = 'cod'").get(o.id))
      db.prepare("INSERT INTO delivery_payments (order_id, method, amount, status) VALUES (?, 'cod', ?, 'unpaid')").run(o.id, o.total);
    setOrderStatus(o.id, "confirmed", { force: true });
  })();
}

/** What to show for paying by PromptPay: the dynamic QR for the exact total, or the shop's own uploaded QR image. */
export function guestPayInfo(token: string): { total: number; qrPayload: string | null; qrImageUrl: string | null } | null {
  const o = getGuestOrderRow(token);
  if (!o) return null;
  const qrImageUrl = getPromptPayQrUrl(o.branch_id);
  const id = getPromptPayId(o.branch_id);
  return { total: o.total, qrImageUrl, qrPayload: !qrImageUrl && id ? buildPromptPayPayload(id, o.total) : null };
}
