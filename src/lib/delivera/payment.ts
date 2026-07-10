import { getDb } from "@/lib/db";
import { hashLineUserId } from "@/lib/insigna/hash";
import { round2 } from "./quote";
import { getOrderByNo, setOrderStatus, type OrderRow } from "./orders";
import { slipOkReady, deliveraEnv } from "./env";

// DELIVERA payments (commit 4/8). Two rails:
//   • promptpay — a dynamic PromptPay QR for the exact order total; the customer
//     pays then attaches the slip. Verified by SlipOK when configured, otherwise
//     the slip queues for manual confirmation on the kitchen board (ships dark).
//   • cod — pay the rider on delivery; the order skips straight to the kitchen.
// Prices are NEVER trusted from the client — the QR amount is the stored total.

// ─── PromptPay EMVCo QR payload (pure, unit-tested) ─────────────────────────

/** Tag-Length-Value: id + 2-digit length + value. */
function tlv(id: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${id}${len}${value}`;
}

/** CRC16-CCITT-FALSE (poly 0x1021, init 0xFFFF) — the checksum PromptPay uses.
 *  Returns 4 upper-case hex chars. Verified against the standard "123456789"
 *  vector (0x29B1) in the unit test. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Format a PromptPay proxy (phone / national-id / e-wallet) into its EMVCo
 *  sub-tag. Phone → tag 01 as "0066…" (13 digits); 13-digit id → tag 02;
 *  15-digit e-wallet → tag 03. */
function proxyTlv(promptpayId: string): string {
  const digits = (promptpayId || "").replace(/\D/g, "");
  if (digits.length === 13) return tlv("02", digits);            // national / tax id
  if (digits.length === 15) return tlv("03", digits);            // e-wallet id
  // phone: strip leading 0, prepend 66, left-pad to 13
  const phone = ("0000000000000" + digits.replace(/^0/, "66")).slice(-13);
  return tlv("01", phone);
}

/** Build the full PromptPay QR payload string for `amount` THB. Pure + sync so
 *  it's unit-testable; the route turns it into a QR image via `qrcode`. */
export function buildPromptPayPayload(promptpayId: string, amount: number): string {
  const merchant = tlv("00", "A000000677010111") + proxyTlv(promptpayId);
  const body =
    tlv("00", "01") +                       // payload format indicator
    tlv("01", "12") +                        // point of initiation = dynamic (amount-bearing)
    tlv("29", merchant) +                    // PromptPay merchant account info
    tlv("53", "764") +                       // currency THB
    tlv("54", round2(amount).toFixed(2)) +   // amount
    tlv("58", "TH");                          // country
  const toCheck = body + "6304";             // CRC is computed over the data + "6304"
  return toCheck + crc16(toCheck);
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function getPromptPayId(branchId: number): string | null {
  const r = getDb().prepare("SELECT promptpay_id FROM delivera_branch_settings WHERE branch_id = ?").get(branchId) as { promptpay_id: string | null } | undefined;
  return r?.promptpay_id?.trim() || null;
}

// ─── Payment flow ─────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  constructor(public code: string, public detail?: unknown) { super(code); this.name = "PaymentError"; }
}

export type StartPaymentResult =
  | { method: "cod"; status: "confirmed"; total: number }
  | { method: "promptpay"; status: "pending_payment"; total: number; promptpayId: string; qrPayload: string };

/** Choose how to pay an order (customer-scoped by the caller). COD confirms the
 *  order straight to the kitchen; PromptPay returns the QR payload to display. */
export function startPayment(order: OrderRow, method: "promptpay" | "cod"): StartPaymentResult {
  const db = getDb();
  if (order.pay_status === "verified") throw new PaymentError("already_paid");
  if (order.status !== "pending_payment") throw new PaymentError("not_payable", order.status);

  if (method === "cod") {
    const tx = db.transaction(() => {
      db.prepare("UPDATE delivery_orders SET pay_method = 'cod', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
      // COD: money is collected on delivery — the order proceeds to the kitchen now.
      setOrderStatus(order.id, "confirmed", { force: true });
      ensurePaymentRow(order.id, "cod", order.total, "unpaid");
    });
    tx();
    return { method: "cod", status: "confirmed", total: order.total };
  }

  const promptpayId = getPromptPayId(order.branch_id);
  if (!promptpayId) throw new PaymentError("promptpay_not_configured");
  const qrPayload = buildPromptPayPayload(promptpayId, order.total);
  db.prepare("UPDATE delivery_orders SET pay_method = 'promptpay', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
  ensurePaymentRow(order.id, "promptpay", order.total, "unpaid");
  return { method: "promptpay", status: "pending_payment", total: order.total, promptpayId, qrPayload };
}

/** Idempotent: one open payment row per (order, method). */
function ensurePaymentRow(orderId: number, method: "promptpay" | "cod", amount: number, status: string): void {
  const db = getDb();
  const existing = db.prepare("SELECT id FROM delivery_payments WHERE order_id = ? AND method = ?").get(orderId, method);
  if (existing) return;
  db.prepare("INSERT INTO delivery_payments (order_id, method, amount, status) VALUES (?,?,?,?)").run(orderId, method, amount, status);
}

export type SlipResult = { payStatus: "verified" | "pending_verify"; verified: boolean };

/** Attach a payment slip to a PromptPay order. When SlipOK is configured the
 *  slip is verified automatically (amount must match, trans-ref de-duped);
 *  otherwise it queues as pending_verify for a human to confirm on the kitchen
 *  board — so the flow works before SlipOK is provisioned. */
export async function submitSlip(args: {
  orderNo: string; lineUserId: string; slipData?: string | null; slipImageUrl?: string | null;
}): Promise<SlipResult> {
  const db = getDb();
  const order = getOrderByNo(args.orderNo);
  if (!order) throw new PaymentError("order_not_found");
  if (order.customer_hash !== hashLineUserId(args.lineUserId)) throw new PaymentError("forbidden");
  if (order.pay_method !== "promptpay") throw new PaymentError("not_promptpay");
  if (order.pay_status === "verified") return { payStatus: "verified", verified: true };

  const payment = db.prepare("SELECT id FROM delivery_payments WHERE order_id = ? AND method = 'promptpay'").get(order.id) as { id: number } | undefined;
  if (!payment) throw new PaymentError("no_payment_row");

  // SlipOK path — verify + de-dupe the bank transaction reference.
  if (slipOkReady() && (args.slipData || args.slipImageUrl)) {
    const v = await verifySlipOk({ data: args.slipData ?? null, imageUrl: args.slipImageUrl ?? null });
    if (!v.ok) throw new PaymentError("slip_verify_failed", v.message);
    if (Math.abs(round2(v.amount) - round2(order.total)) > 0.01) throw new PaymentError("slip_amount_mismatch", { paid: v.amount, due: order.total });
    // Reject a slip whose bank ref was already used on any order (double-submit / reuse).
    const dup = db.prepare("SELECT 1 FROM delivery_payments WHERE slipok_trans_ref = ?").get(v.transRef);
    if (dup) throw new PaymentError("slip_already_used");
    const tx = db.transaction(() => {
      db.prepare("UPDATE delivery_payments SET status = 'verified', slipok_trans_ref = ?, slip_image_url = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(v.transRef, args.slipImageUrl ?? null, payment.id);
      db.prepare("UPDATE delivery_orders SET pay_status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
      if (order.status === "pending_payment") setOrderStatus(order.id, "paid", { force: true });
    });
    tx();
    return { payStatus: "verified", verified: true };
  }

  // No SlipOK yet → hold for manual confirmation.
  db.prepare("UPDATE delivery_payments SET status = 'pending_verify', slip_image_url = ? WHERE id = ?").run(args.slipImageUrl ?? null, payment.id);
  db.prepare("UPDATE delivery_orders SET pay_status = 'pending_verify', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(order.id);
  return { payStatus: "pending_verify", verified: false };
}

/** Staff manually confirms a queued slip (kitchen board, commit 5). */
export function confirmSlipManually(orderId: number): void {
  const db = getDb();
  const order = getDb().prepare("SELECT * FROM delivery_orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) throw new PaymentError("order_not_found");
  const tx = db.transaction(() => {
    db.prepare("UPDATE delivery_payments SET status = 'verified', verified_at = CURRENT_TIMESTAMP WHERE order_id = ? AND method = 'promptpay'").run(orderId);
    db.prepare("UPDATE delivery_orders SET pay_status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(orderId);
    if (order.status === "pending_payment") setOrderStatus(orderId, "paid", { force: true });
  });
  tx();
}

/** POST the slip to SlipOK for verification. Gated by slipOkReady(); the exact
 *  response shape is parsed defensively since the live API can't be exercised
 *  here. SlipOK: POST https://api.slipok.com/api/line/apikey/{branchId}. */
async function verifySlipOk(args: { data: string | null; imageUrl: string | null }): Promise<{ ok: boolean; amount: number; transRef: string; message?: string }> {
  const env = deliveraEnv();
  const url = `https://api.slipok.com/api/line/apikey/${env.SLIPOK_BRANCH_ID}`;
  const body: Record<string, unknown> = { log: true };
  if (args.data) body.data = args.data;          // QR string decoded from the slip
  else if (args.imageUrl) body.url = args.imageUrl;
  let json: Record<string, unknown>;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-authorization": env.SLIPOK_API_KEY },
      body: JSON.stringify(body)
    });
    json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, amount: 0, transRef: "", message: String((json as { message?: string }).message ?? res.status) };
  } catch (e) {
    return { ok: false, amount: 0, transRef: "", message: (e as Error).message };
  }
  const data = (json.data ?? {}) as Record<string, unknown>;
  const amount = Number(data.amount ?? data.amountValue ?? 0);
  const transRef = String(data.transRef ?? data.transRefId ?? data.ref ?? "");
  const success = json.success === true && !!transRef;
  return { ok: success, amount, transRef, message: success ? undefined : "slip_not_verified" };
}
