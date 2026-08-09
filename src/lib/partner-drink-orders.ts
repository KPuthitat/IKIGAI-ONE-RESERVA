import { randomBytes } from "crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db";
import { todayBkk } from "./time";

type DbHandle = Database.Database;
const round2 = (x: number): number => Math.round(x * 100) / 100;

// Staff drink welfare — จ้อจี้ & friends (owner 2026-07-30, opened up 2026-07-31).
//
// A staff member who has CLOCKED IN today can order a drink — no shift gate, no
// coupon, UNLIMITED per day, because the staff pays for it themselves (owner
// 2026-07-31: "ไม่กำหนดกะ ได้ตลอด เพราะจ่ายเอง"). Each order is a PENDING row + a
// one-time token rendered as a QR. The partner (จ้อจี้) scans it, picks the tier
// (50/80) + payment method, which flips it to REDEEMED — and ONLY then does the
// amount count: a 'payroll' drink becomes a deduction on the staff's period and
// joins the partner's no-GP payout; a 'cash' drink was paid to จ้อจี้ directly.
// Nothing is charged for a pending order the staff never collects.

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
  | { ok: false; error: "no_partner" | "not_clocked_in" };

/** Create a fresh pending drink order for a staff member (owner 2026-07-31).
 *  No coupon, no shift gate, unlimited per day — the only requirement is that the
 *  staff has CLOCKED IN today at this branch (they're actually at work), and the
 *  branch has a จ้อจี้ partner. The price tier (50/80) + payment method are chosen
 *  by จ้อจี้ at scan time, so a pending order carries amount 0 until redeemed. The
 *  QR expires at end of the Bangkok day. coupon_id stays NULL. */
export function createDrinkOrder(
  userId: number, branchId: number
): CreateOrderResult {
  const db = getDb();
  const partner = resolveDrinkPartner(branchId);
  if (!partner) return { ok: false, error: "no_partner" };

  const today = todayBkk();
  const dayStartIso = new Date(`${today}T00:00:00+07:00`).toISOString();
  const dayEndIso = new Date(`${today}T23:59:59+07:00`).toISOString();
  // Must have clocked IN today at this branch — EXCEPT execs / no-clock staff
  // (track_attendance = 0) who never punch (owner 2026-07-31). They can order any
  // day the branch has a จ้อจี้ partner.
  const isExec = !!db.prepare(
    "SELECT 1 FROM users WHERE id = ? AND COALESCE(track_attendance, 1) = 0"
  ).get(userId);
  if (!isExec) {
    const clockedIn = db.prepare(
      `SELECT 1 FROM time_entries
        WHERE user_id = ? AND branch_id = ? AND type = 'in' AND ts >= ? AND ts <= ?
        LIMIT 1`
    ).get(userId, branchId, dayStartIso, dayEndIso);
    if (!clockedIn) return { ok: false, error: "not_clocked_in" };
  }

  const token = randomBytes(24).toString("hex");
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO partner_drink_orders
       (user_id, branch_id, partner_id, order_date, amount, token, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 'pending', ?, ?)`
  ).run(userId, branchId, partner.id, today, token, dayEndIso, now);

  return { ok: true, orderId: Number(info.lastInsertRowid), token, expiresAt: dayEndIso, partnerName: partner.name };
}

/** How the staff pays for the drink (owner 2026-07-30). */
export type PaymentMethod = "payroll" | "cash";
export function isPaymentMethod(s: string): s is PaymentMethod {
  return s === "payroll" || s === "cash";
}

export type RedeemOrderResult =
  | { ok: true; amount: number; staffName: string; orderDate: string; paymentMethod: PaymentMethod }
  | { ok: false; error: "not_found" | "already" | "expired" | "wrong_partner" | "bad_amount" | "bad_method" };

/** Partner (จ้อจี้) redeems by scanning the QR token. Flips the order to
 *  redeemed and consumes the underlying drink coupon — this is the moment the
 *  charge locks. `redeemerBranchIds` scopes the scanning partner account to the
 *  branch(es) it may fulfil for. Idempotent: re-scan of a redeemed token → 409
 *  ('already'). */
export function redeemDrinkOrder(
  token: string, redeemerUserId: number, redeemerBranchIds: number[], amount: number, paymentMethod: string
): RedeemOrderResult {
  const db = getDb();
  // The จ้อจี้ team picks the price tier (50/80) + payment method at scan time
  // (owner 2026-07-30). 'cash' = staff paid จ้อจี้ directly → no payroll deduction.
  if (!isDrinkTier(amount)) return { ok: false, error: "bad_amount" };
  if (!isPaymentMethod(paymentMethod)) return { ok: false, error: "bad_method" };
  const order = db.prepare(
    `SELECT o.id, o.user_id, o.branch_id, o.amount, o.status, o.expires_at, o.order_date,
            COALESCE(u.nickname_th, u.display_name) AS staff_name
       FROM partner_drink_orders o
       JOIN users u ON u.id = o.user_id
      WHERE o.token = ?`
  ).get(token) as
    | { id: number; user_id: number; branch_id: number; amount: number; status: string;
        expires_at: string; order_date: string; staff_name: string }
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
  const changed = db.transaction(() => {
    // Set the จ้อจี้-chosen amount + payment method as the order is redeemed.
    const info = db.prepare(
      `UPDATE partner_drink_orders
          SET status = 'redeemed', amount = ?, payment_method = ?, redeemed_at = ?, redeemed_by = ?
        WHERE id = ? AND status = 'pending'`
    ).run(amount, paymentMethod, now, redeemerUserId, order.id);
    if (info.changes === 0) return false; // lost a race — someone redeemed first
    return true;
  })();
  if (!changed) return { ok: false, error: "already" };

  return { ok: true, amount, staffName: order.staff_name, orderDate: order.order_date, paymentMethod };
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
      WHERE user_id = ? AND status = 'redeemed' AND payment_method = 'payroll'
        AND order_date >= ? AND order_date <= ? ${branchClause}`
  ).get(...params) as { total: number };
  return r.total;
}

/** Sum of a partner's REDEEMED, PAYROLL drink orders in a calendar month — the
 *  no-GP amount the company forwards to that partner. 'cash' drinks are excluded
 *  (the staff paid จ้อจี้ directly, so the company owes nothing on them). */
export function sumRedeemedDrinksForPartnerMonth(
  db: DbHandle, partnerId: number, year: number, month: number
): number {
  const mm = String(month).padStart(2, "0");
  const prefix = `${year}-${mm}`;
  const r = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM partner_drink_orders
      WHERE partner_id = ? AND status = 'redeemed' AND payment_method = 'payroll'
        AND substr(order_date, 1, 7) = ?`
  ).get(partnerId, prefix) as { total: number };
  return r.total;
}

/** Redeemed drink-welfare summary for a partner over a date range (inclusive,
 *  YYYY-MM-DD) — read straight from the redemptions (owner 2026-07-30), for the
 *  separate staff-drink-welfare card the company sends จ้อจี้. Partner-facing:
 *  totals + per-tier counts only (no staff names). */
export type DrinkWelfareSummary = {
  // 'payroll' drinks — what the company forwards to จ้อจี้ (the card's payable).
  count: number;
  total: number;                       // VAT-inclusive
  byTier: Array<{ amount: number; count: number; subtotal: number }>;
  // 'cash' drinks — staff paid จ้อจี้ directly (info only; NOT company's payable).
  cashCount: number;
  cashTotal: number;
};
export function drinkWelfareSummary(
  db: DbHandle, partnerId: number, startDate: string, endDate: string
): DrinkWelfareSummary {
  const rows = db.prepare(
    `SELECT amount, payment_method AS method, COUNT(*) AS n
       FROM partner_drink_orders
      WHERE partner_id = ? AND status = 'redeemed'
        AND order_date >= ? AND order_date <= ?
      GROUP BY amount, payment_method
      ORDER BY amount`
  ).all(partnerId, startDate, endDate) as Array<{ amount: number; method: string; n: number }>;
  const tierMap = new Map<number, number>();
  let cashCount = 0, cashTotal = 0;
  for (const r of rows) {
    if (r.method === "cash") { cashCount += r.n; cashTotal += r.amount * r.n; }
    else tierMap.set(r.amount, (tierMap.get(r.amount) ?? 0) + r.n);
  }
  let count = 0, total = 0;
  const byTier = [...tierMap.entries()].sort((a, b) => a[0] - b[0]).map(([amount, n]) => {
    const subtotal = round2(amount * n); count += n; total += subtotal;
    return { amount, count: n, subtotal };
  });
  return { count, total: round2(total), byTier, cashCount, cashTotal: round2(cashTotal) };
}

/** Month's redeemed drink welfare grouped into ISO weeks (Mon start) + a month
 *  total — for the revshare welfare card (weekly Monday sends + a month-end
 *  send). Only weeks with redemptions appear. */
export type DrinkWelfareWeek = { weekStart: string; start: string; end: string; label: string; summary: DrinkWelfareSummary };
export function drinkWelfareByWeek(
  db: DbHandle, partnerId: number, year: number, month: number
): { weeks: DrinkWelfareWeek[]; month: DrinkWelfareSummary } {
  const mm = String(month).padStart(2, "0");
  const rows = db.prepare(
    `SELECT order_date, amount, payment_method AS method FROM partner_drink_orders
      WHERE partner_id = ? AND status = 'redeemed' AND substr(order_date, 1, 7) = ?
      ORDER BY order_date`
  ).all(partnerId, `${year}-${mm}`) as Array<{ order_date: string; amount: number; method: string }>;

  const mondayOf = (iso: string): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    const dow = d.getUTCDay();                 // 0=Sun..6=Sat
    d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
    return d.toISOString().slice(0, 10);
  };
  type Item = { amount: number; method: string };
  const wk = new Map<string, { start: string; end: string; rows: Item[] }>();
  for (const r of rows) {
    const k = mondayOf(r.order_date);
    const item: Item = { amount: r.amount, method: r.method };
    const g = wk.get(k);
    if (!g) wk.set(k, { start: r.order_date, end: r.order_date, rows: [item] });
    else { g.rows.push(item); if (r.order_date < g.start) g.start = r.order_date; if (r.order_date > g.end) g.end = r.order_date; }
  }
  const summarize = (items: Item[]): DrinkWelfareSummary => {
    const tierMap = new Map<number, number>();
    let cashCount = 0, cashTotal = 0;
    for (const it of items) {
      if (it.method === "cash") { cashCount += 1; cashTotal += it.amount; }
      else tierMap.set(it.amount, (tierMap.get(it.amount) ?? 0) + 1);
    }
    let count = 0, total = 0;
    const byTier = [...tierMap.entries()].sort((a, b) => a[0] - b[0]).map(([amount, n]) => {
      const subtotal = round2(amount * n); count += n; total += subtotal;
      return { amount, count: n, subtotal };
    });
    return { count, total: round2(total), byTier, cashCount, cashTotal: round2(cashTotal) };
  };
  const weeks: DrinkWelfareWeek[] = [...wk.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, g]) => ({ weekStart, start: g.start, end: g.end, label: `${g.start} – ${g.end}`, summary: summarize(g.rows) }));
  return { weeks, month: summarize(rows.map((r) => ({ amount: r.amount, method: r.method }))) };
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
