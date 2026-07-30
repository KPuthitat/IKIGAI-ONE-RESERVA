import { randomBytes } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { todayBkk } from "./time";

type DbHandle = Database.Database;

// Staff drink welfare — จ้อจี้ & friends (owner 2026-07-30).
//
// A clocked-in staff member holding today's (still-unredeemed) drink coupon can
// order a drink at one of two tiers (50/80). The order is a PENDING row + a
// one-time token rendered as a QR. The partner (จ้อจี้) scans it to fulfil,
// which flips it to REDEEMED — and ONLY then does the amount count: it becomes a
// payroll deduction on the staff's period and joins the partner's no-GP payout
// for the month. Nothing is charged for a pending order the staff never collects.
//
// Cap = 1/day is inherited from the daily drink coupon: an order consumes that
// coupon on redeem, and creating an order requires the coupon to still be
// 'issued'. Re-picking a tier replaces the prior pending order (fresh QR).

/** The two allowed drink tiers, in baht (owner 2026-07-30). */
export const DRINK_TIERS = [50, 80] as const;
export type DrinkTier = (typeof DRINK_TIERS)[number];
export function isDrinkTier(n: number): n is DrinkTier {
  return (DRINK_TIERS as readonly number[]).includes(n);
}

export type DrinkPartner = { id: number; name: string; branch_id: number };

/** The active drink-welfare partner for a branch (จ้อจี้), or null. */
export function resolveDrinkPartner(branchId: number): DrinkPartner | null {
  const r = getDb().prepare(
    `SELECT id, name, branch_id FROM revshare_partners
      WHERE branch_id = ? AND drink_welfare = 1 AND active = 1
      ORDER BY id LIMIT 1`
  ).get(branchId) as DrinkPartner | undefined;
  return r ?? null;
}

export type CreateOrderResult =
  | { ok: true; orderId: number; token: string; expiresAt: string; partnerName: string }
  | { ok: false; error: "no_partner" | "no_coupon" };

/** Create (or replace) today's pending drink order for a staff member. Requires
 *  an unredeemed daily drink coupon at this branch. The price tier (50/80) is
 *  NOT chosen here — the จ้อจี้ team picks it when they scan (owner 2026-07-30) —
 *  so a pending order carries amount 0 until redeemed. Idempotent-ish: an
 *  existing pending order for the same coupon is replaced with a fresh token. */
export function createDrinkOrder(
  userId: number, branchId: number
): CreateOrderResult {
  const db = getDb();
  const partner = resolveDrinkPartner(branchId);
  if (!partner) return { ok: false, error: "no_partner" };

  const today = todayBkk();
  // The daily drink entitlement — must still be issued (not redeemed/expired).
  const coupon = db.prepare(
    `SELECT id, redeem_before FROM meal_coupons
      WHERE user_id = ? AND coupon_date = ? AND type = 'drink' AND status = 'issued'
      LIMIT 1`
  ).get(userId, today) as { id: number; redeem_before: string } | undefined;
  if (!coupon) return { ok: false, error: "no_coupon" };
  if (Date.now() > Date.parse(coupon.redeem_before)) return { ok: false, error: "no_coupon" };

  const token = randomBytes(24).toString("hex");
  const now = new Date().toISOString();

  const orderId = db.transaction(() => {
    // Replace any prior pending order for this coupon (refresh → fresh QR).
    db.prepare(
      "UPDATE partner_drink_orders SET status = 'cancelled' WHERE coupon_id = ? AND status = 'pending'"
    ).run(coupon.id);
    const info = db.prepare(
      `INSERT INTO partner_drink_orders
         (user_id, branch_id, partner_id, coupon_id, order_date, amount, token, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?)`
    ).run(userId, branchId, partner.id, coupon.id, today, token, coupon.redeem_before, now);
    return Number(info.lastInsertRowid);
  })();

  return { ok: true, orderId, token, expiresAt: coupon.redeem_before, partnerName: partner.name };
}

export type RedeemOrderResult =
  | { ok: true; amount: number; staffName: string; orderDate: string }
  | { ok: false; error: "not_found" | "already" | "expired" | "wrong_partner" | "bad_amount" };

/** Partner (จ้อจี้) redeems by scanning the QR token. Flips the order to
 *  redeemed and consumes the underlying drink coupon — this is the moment the
 *  charge locks. `redeemerBranchIds` scopes the scanning partner account to the
 *  branch(es) it may fulfil for. Idempotent: re-scan of a redeemed token → 409
 *  ('already'). */
export function redeemDrinkOrder(
  token: string, redeemerUserId: number, redeemerBranchIds: number[], amount: number
): RedeemOrderResult {
  const db = getDb();
  // The จ้อจี้ team picks the price tier (50/80) at scan time (owner 2026-07-30).
  if (!isDrinkTier(amount)) return { ok: false, error: "bad_amount" };
  const order = db.prepare(
    `SELECT o.id, o.user_id, o.branch_id, o.amount, o.status, o.expires_at, o.coupon_id, o.order_date,
            COALESCE(u.nickname_th, u.display_name) AS staff_name
       FROM partner_drink_orders o
       JOIN users u ON u.id = o.user_id
      WHERE o.token = ?`
  ).get(token) as
    | { id: number; user_id: number; branch_id: number; amount: number; status: string;
        expires_at: string; coupon_id: number | null; order_date: string; staff_name: string }
    | undefined;
  if (!order) return { ok: false, error: "not_found" };
  if (order.status === "redeemed") return { ok: false, error: "already" };
  if (order.status !== "pending") return { ok: false, error: "not_found" };
  // The scanning partner account must cover the order's branch.
  if (redeemerBranchIds.length > 0 && !redeemerBranchIds.includes(order.branch_id)) {
    return { ok: false, error: "wrong_partner" };
  }
  if (Date.now() > Date.parse(order.expires_at)) {
    db.prepare("UPDATE partner_drink_orders SET status = 'expired' WHERE id = ? AND status = 'pending'").run(order.id);
    return { ok: false, error: "expired" };
  }

  const now = new Date().toISOString();
  const label = `เครื่องดื่มจ้อจี้ ฿${amount}`;
  const changed = db.transaction(() => {
    // Set the จ้อจี้-chosen amount as the order is redeemed (locks the charge).
    const info = db.prepare(
      `UPDATE partner_drink_orders
          SET status = 'redeemed', amount = ?, redeemed_at = ?, redeemed_by = ?
        WHERE id = ? AND status = 'pending'`
    ).run(amount, now, redeemerUserId, order.id);
    if (info.changes === 0) return false; // lost a race — someone redeemed first
    // Consume the daily drink coupon so it can't be re-ordered or menu-redeemed.
    if (order.coupon_id != null) {
      db.prepare(
        `UPDATE meal_coupons
            SET status = 'redeemed', redeemed_at = ?, redeemed_branch_id = ?,
                redeemed_menu_item_id = NULL, redeemed_menu_name = ?
          WHERE id = ? AND status = 'issued'`
      ).run(now, order.branch_id, label, order.coupon_id);
    }
    return true;
  })();
  if (!changed) return { ok: false, error: "already" };

  return { ok: true, amount, staffName: order.staff_name, orderDate: order.order_date };
}

/** Sum of a staff member's REDEEMED drink orders within a date range (inclusive,
 *  YYYY-MM-DD) — the drink_deductions for their payroll line. Scoped to a branch
 *  when given (per-branch payroll: a drink bought at NAMA is deducted in NAMA's
 *  round only); pass null for a legacy all-branches period. */
export function sumRedeemedDrinksForUser(
  db: DbHandle, userId: number, startDate: string, endDate: string, branchId: number | null
): number {
  const branchClause = branchId != null ? "AND branch_id = ?" : "";
  const params: Array<string | number> = [userId, startDate, endDate];
  if (branchId != null) params.push(branchId);
  const r = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM partner_drink_orders
      WHERE user_id = ? AND status = 'redeemed'
        AND order_date >= ? AND order_date <= ? ${branchClause}`
  ).get(...params) as { total: number };
  return r.total;
}

/** Sum of a partner's REDEEMED drink orders in a calendar month — the no-GP
 *  amount added to that partner's payout settlement. */
export function sumRedeemedDrinksForPartnerMonth(
  db: DbHandle, partnerId: number, year: number, month: number
): number {
  const mm = String(month).padStart(2, "0");
  const prefix = `${year}-${mm}`;
  const r = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM partner_drink_orders
      WHERE partner_id = ? AND status = 'redeemed'
        AND substr(order_date, 1, 7) = ?`
  ).get(partnerId, prefix) as { total: number };
  return r.total;
}

/** A staff member's drink orders for a date (newest first) — for the staff UI. */
export type DrinkOrderRow = {
  id: number; amount: number; token: string; status: string; expires_at: string; redeemed_at: string | null;
};
export function listUserDrinkOrdersForDate(userId: number, dateBkk: string): DrinkOrderRow[] {
  return getDb().prepare(
    `SELECT id, amount, token, status, expires_at, redeemed_at
       FROM partner_drink_orders
      WHERE user_id = ? AND order_date = ?
      ORDER BY id DESC`
  ).all(userId, dateBkk) as DrinkOrderRow[];
}
