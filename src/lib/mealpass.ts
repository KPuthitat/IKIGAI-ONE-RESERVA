// MEALPASS 2.0 — attendance-linked meal-credit engine (owner 2026-08-09).
//
// Credits are EARNED from confirmed attendance and BURNED on meals. The ledger
// (mealpass_ledger) is append-only — balance is always SUM(credits) over a
// person's rows in a month; we never mutate an amount. This file holds the
// money-critical logic as PURE functions (unit-tested without a DB, mirroring
// service-charge/group-insurance) plus thin DB helpers used by cron + routes.
//
// Wording rule (spec, hard): staff-facing copy NEVER says "ฟรี" or references
// food cost/COG. This module returns numbers only; the UI phrases them as
// "N เครดิต ใช้ได้เมื่อลงเวลาเข้าทำงาน".

import { randomBytes } from "crypto";
import Database from "better-sqlite3";
import { getDb } from "./db";
import { scheduledShiftMinutesForUserDate } from "./roster";
import { svcWorkedMinutesForUserDate, FOOD_CLAWBACK_MIN_MINUTES } from "./service-charge";

// ── Shift thresholds ─────────────────────────────────────────────────────
// A "full day" mirrors the existing full-shift bar used by the SVC food
// clawback (rostered ≥ 8h AND actually worked ≥ 8h − 30-min grace = 450). A
// "half day" (part-timers) is a rostered ~4h shift worked to within the same
// 30-min grace.
export const FULL_SHIFT_MIN = 480;                       // 8h rostered
export const HALF_SHIFT_MIN = 240;                       // 4h rostered
export const FULL_WORKED_FLOOR = FOOD_CLAWBACK_MIN_MINUTES; // 450 (= 480 − 30)
export const HALF_WORKED_FLOOR = HALF_SHIFT_MIN - 30;    // 210

// Defaults — the authoritative values live in mealpass_config per branch.
export const DEFAULT_FULL_CREDITS = 60;
export const DEFAULT_HALF_CREDITS = 30;
export const DEFAULT_MONTHLY_CAP = 1500;
export const DEFAULT_STANDARD_COST = 60;
export const DEFAULT_SPECIAL_RATE = 0.5;
export const DEFAULT_CASH_DISCOUNT = 0.10;

export type ShiftClass = "full" | "half" | "none";
export type MealClass = "standard" | "special" | "cash";

export type MealpassConfig = {
  branch_id: number;
  enabled: number;
  redeem_cutoff: string;
  monthly_cap: number;
  full_day_credits: number;
  half_day_credits: number;
  standard_credit_cost: number;
  special_rate: number;
  cash_discount: number;
  cross_company_cap_baht: number;
};

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** BKK YYYY-MM for a YYYY-MM-DD (or longer) date string. */
export function ymOf(dateBkk: string): string {
  return dateBkk.slice(0, 7);
}

// ── Pure earn logic ──────────────────────────────────────────────────────

/** Classify a day from rostered vs actually-worked minutes. Full wins over
 *  half. A day with no/short roster or too-few worked minutes earns nothing. */
export function classifyShift(scheduledMin: number, workedMin: number): ShiftClass {
  if (scheduledMin >= FULL_SHIFT_MIN && workedMin >= FULL_WORKED_FLOOR) return "full";
  if (scheduledMin >= HALF_SHIFT_MIN && workedMin >= HALF_WORKED_FLOOR) return "half";
  return "none";
}

/** Raw food credits a day would earn (before the monthly cap). Owner 2026-08-09:
 *  ONLY a full (≥8h) shift earns food credits — a shift under 8h earns 0 (those
 *  staff still get the free daily drink coupon, granted separately on clock-in).
 *  half_day_credits is kept in config for flexibility but not used by the rule. */
export function creditsForShift(
  scheduledMin: number,
  workedMin: number,
  cfg: Pick<MealpassConfig, "full_day_credits" | "half_day_credits">
): number {
  return classifyShift(scheduledMin, workedMin) === "full" ? cfg.full_day_credits : 0;
}

/** Clamp an earn to the remaining monthly headroom. Never negative. */
export function applyMonthlyCap(alreadyEarned: number, raw: number, cap: number): number {
  return Math.max(0, Math.min(raw, cap - alreadyEarned));
}

// ── Pure burn logic ──────────────────────────────────────────────────────

export type BurnQuote = {
  mealClass: MealClass;
  credits: number;   // credits to deduct from balance (0 for cash)
  baht: number;      // cash to collect (0 unless mealClass === 'cash')
};

/** What a meal costs the staffer.
 *  - standard: fixed credit_cost (default 60), no cash.
 *  - special:  credits = round(price × special_rate) [50% of selling price].
 *  - cash:     no credit; pay price × (1 − cash_discount) [−10%]. Used when the
 *              balance can't cover the credit cost.
 *  The UI shows only the credit count / normal price — never the 50% formula. */
export function burnQuote(args: {
  mealClass: MealClass;
  creditCost: number;
  price: number;
  cfg: Pick<MealpassConfig, "special_rate" | "cash_discount">;
}): BurnQuote {
  const { mealClass, creditCost, price, cfg } = args;
  if (mealClass === "cash") {
    return { mealClass, credits: 0, baht: round2(price * (1 - cfg.cash_discount)) };
  }
  if (mealClass === "special") {
    return { mealClass, credits: Math.round(price * cfg.special_rate), baht: 0 };
  }
  return { mealClass, credits: creditCost, baht: 0 };
}

/** Decide how a chosen menu item is charged given the live balance.
 *  standard item (is_standard_meal) costs credit_cost; a non-standard item is a
 *  "special" meal (50% of price in credits). If the balance can't cover the
 *  credit cost, it falls back to cash (−10%). */
export function resolveMealCharge(args: {
  isStandard: boolean;
  creditCost: number;
  price: number;
  balance: number;
  cfg: Pick<MealpassConfig, "special_rate" | "cash_discount">;
}): BurnQuote {
  const base: MealClass = args.isStandard ? "standard" : "special";
  const quote = burnQuote({ mealClass: base, creditCost: args.creditCost, price: args.price, cfg: args.cfg });
  if (quote.credits > args.balance) {
    return burnQuote({ mealClass: "cash", creditCost: args.creditCost, price: args.price, cfg: args.cfg });
  }
  return quote;
}

// ── DB helpers ───────────────────────────────────────────────────────────

const CONFIG_DEFAULTS: Omit<MealpassConfig, "branch_id"> = {
  enabled: 0,
  redeem_cutoff: "15:00",
  monthly_cap: DEFAULT_MONTHLY_CAP,
  full_day_credits: DEFAULT_FULL_CREDITS,
  half_day_credits: DEFAULT_HALF_CREDITS,
  standard_credit_cost: DEFAULT_STANDARD_COST,
  special_rate: DEFAULT_SPECIAL_RATE,
  cash_discount: DEFAULT_CASH_DISCOUNT,
  cross_company_cap_baht: 1500,
};

/** Per-branch config, falling back to defaults when the branch has no row. */
export function getMealpassConfig(branchId: number, db: Database.Database = getDb()): MealpassConfig {
  const row = db.prepare("SELECT * FROM mealpass_config WHERE branch_id = ?").get(branchId) as
    MealpassConfig | undefined;
  return row ?? { branch_id: branchId, ...CONFIG_DEFAULTS };
}

/** Create or update a branch's MEALPASS config (upsert). Unknown fields fall
 *  back to the current row (or defaults for a brand-new branch). */
export function setMealpassConfig(
  branchId: number,
  patch: Partial<Omit<MealpassConfig, "branch_id">>,
  db: Database.Database = getDb()
): MealpassConfig {
  const cur = getMealpassConfig(branchId, db);
  const next: MealpassConfig = { ...cur, ...patch, branch_id: branchId };
  db.prepare(`
    INSERT INTO mealpass_config
      (branch_id, enabled, redeem_cutoff, monthly_cap, full_day_credits, half_day_credits,
       standard_credit_cost, special_rate, cash_discount, cross_company_cap_baht, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(branch_id) DO UPDATE SET
      enabled = excluded.enabled, redeem_cutoff = excluded.redeem_cutoff,
      monthly_cap = excluded.monthly_cap, full_day_credits = excluded.full_day_credits,
      half_day_credits = excluded.half_day_credits, standard_credit_cost = excluded.standard_credit_cost,
      special_rate = excluded.special_rate, cash_discount = excluded.cash_discount,
      cross_company_cap_baht = excluded.cross_company_cap_baht, updated_at = CURRENT_TIMESTAMP
  `).run(branchId, next.enabled ? 1 : 0, next.redeem_cutoff, next.monthly_cap,
    next.full_day_credits, next.half_day_credits, next.standard_credit_cost,
    next.special_rate, next.cash_discount, next.cross_company_cap_baht);
  return next;
}

/** Credits earned so far in a month (earn rows only). */
export function monthlyEarned(userId: number, ym: string, db: Database.Database = getDb()): number {
  const r = db.prepare(
    "SELECT COALESCE(SUM(credits),0) AS n FROM mealpass_ledger WHERE user_id = ? AND ym = ? AND entry_type = 'earn'"
  ).get(userId, ym) as { n: number };
  return r.n;
}

/** Spendable balance for a person in a month = SUM of every ledger row's
 *  signed credits (earn + / burn,expire,clawback − / adjust ±). */
export function balanceForUser(userId: number, ym: string, db: Database.Database = getDb()): number {
  const r = db.prepare(
    "SELECT COALESCE(SUM(credits),0) AS n FROM mealpass_ledger WHERE user_id = ? AND ym = ?"
  ).get(userId, ym) as { n: number };
  return r.n;
}

/** Accrue one person's earn for one work day (idempotent via the unique index
 *  on (user_id, attendance_date) WHERE entry_type='earn'). Sums scheduled +
 *  worked minutes across every branch they were rostered at that day (transfer
 *  days), classifies once, and earns once — clamped to the monthly cap.
 *  Returns the credits written (0 when nothing earned / cap full / duplicate). */
export function earnForDay(args: {
  userId: number;
  branchIds: number[];       // branches the user had a WORK shift at that day
  dateBkk: string;
  actorId?: number | null;
  db?: Database.Database;
}): number {
  const db = args.db ?? getDb();
  const { userId, branchIds, dateBkk } = args;
  if (branchIds.length === 0) return 0;

  // Already earned today? (fast path — the unique index is the real guard.)
  const dup = db.prepare(
    "SELECT 1 FROM mealpass_ledger WHERE user_id = ? AND attendance_date = ? AND entry_type = 'earn'"
  ).get(userId, dateBkk);
  if (dup) return 0;

  let scheduled = 0;
  let worked = 0;
  for (const b of branchIds) {
    scheduled += scheduledShiftMinutesForUserDate(userId, b, dateBkk);
    worked += svcWorkedMinutesForUserDate(b, userId, dateBkk);
  }

  // Config from the primary (first) branch of the day.
  const cfg = getMealpassConfig(branchIds[0], db);
  const raw = creditsForShift(scheduled, worked, cfg);
  if (raw <= 0) return 0;

  const ym = ymOf(dateBkk);
  const credits = applyMonthlyCap(monthlyEarned(userId, ym, db), raw, cfg.monthly_cap);
  if (credits <= 0) return 0;

  try {
    db.prepare(`
      INSERT INTO mealpass_ledger
        (user_id, ym, entry_type, credits, attendance_date, attendance_branch_id, created_by, notes)
      VALUES (?, ?, 'earn', ?, ?, ?, ?, ?)
    `).run(userId, ym, credits, dateBkk, branchIds[0], args.actorId ?? null,
      classifyShift(scheduled, worked) === "full" ? "เต็มวัน" : "ครึ่งวัน");
  } catch (e) {
    // Lost the idempotency race (unique index) — treat as already earned.
    if (e instanceof Error && /UNIQUE/.test(e.message)) return 0;
    throw e;
  }
  return credits;
}

/** Nightly accrual for a whole BKK date across all branches: earns for every
 *  active employee who had a work shift that day. Returns how many people
 *  earned. Idempotent — safe to re-run (e.g. after a time-cert correction). */
export function accrueForDate(dateBkk: string, db: Database.Database = getDb()): number {
  const rows = db.prepare(`
    SELECT a.user_id AS uid, a.branch_id AS bid
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    JOIN users u ON u.id = a.user_id
    WHERE a.assignment_date = ?
      AND s.kind = 'work'
      AND u.status NOT IN ('disabled','resigned')
  `).all(dateBkk) as Array<{ uid: number; bid: number }>;

  const byUser = new Map<number, Set<number>>();
  for (const r of rows) {
    const set = byUser.get(r.uid) ?? new Set<number>();
    set.add(r.bid);
    byUser.set(r.uid, set);
  }

  let earners = 0;
  for (const [uid, branchSet] of byUser) {
    const got = earnForDay({ userId: uid, branchIds: [...branchSet], dateBkk, db });
    if (got > 0) earners++;
  }
  return earners;
}

/** Month-end expiry: credits do NOT roll over. For each person still holding a
 *  positive balance in `ym`, post an 'expire' row that zeroes it. Idempotent —
 *  skips users who already have an expire row for that month. Returns the count
 *  of people expired. */
export function expireMonth(ym: string, db: Database.Database = getDb()): number {
  const balances = db.prepare(`
    SELECT user_id AS uid, COALESCE(SUM(credits),0) AS bal
    FROM mealpass_ledger WHERE ym = ?
    GROUP BY user_id HAVING bal > 0
  `).all(ym) as Array<{ uid: number; bal: number }>;

  const insert = db.prepare(`
    INSERT INTO mealpass_ledger (user_id, ym, entry_type, credits, notes)
    VALUES (?, ?, 'expire', ?, 'หมดอายุสิ้นเดือน (ไม่ทบยอด)')
  `);
  const already = db.prepare(
    "SELECT 1 FROM mealpass_ledger WHERE user_id = ? AND ym = ? AND entry_type = 'expire'"
  );

  let n = 0;
  const tx = db.transaction(() => {
    for (const b of balances) {
      if (already.get(b.uid, ym)) continue;
      insert.run(b.uid, ym, -b.bal);
      n++;
    }
  });
  tx();
  return n;
}

// ── Burn flow (in-house meal redemption) ──────────────────────────────────
// Staff pick a menu item → order (MP-xxxx, pending) → manager confirms → one
// ledger burn row + status confirmed. Cash meals (balance short) burn 0 credits
// (money collected at the counter) but still post a row for audit. The DB
// unique index (kind='meal', live status) is the real 1-meal/day guard; we
// pre-check for a friendly error.

/** True when the current HH:MM is past the branch redeem cutoff. String
 *  compare is safe for zero-padded HH:MM. */
export function isAfterCutoff(nowHhmm: string, cutoff: string): boolean {
  return nowHhmm > cutoff;
}

/** Coded error so routes can map to HTTP status. */
export class MealpassError extends Error {
  constructor(public code: string) { super(code); this.name = "MealpassError"; }
}

function genCode(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString("hex").toUpperCase()}`;
}
function endOfBkkDay(dateBkk: string): string {
  return new Date(`${dateBkk}T23:59:59+07:00`).toISOString();
}

type MenuRow = {
  id: number; branch_id: number; name_th: string; price: number;
  is_available: number; is_standard_meal: number; credit_cost: number;
};

export type MealOrderResult = {
  id: number; code: string; mealClass: MealClass;
  credits: number; baht: number; menuName: string; balanceAfter: number;
};

/** Create a pending in-house meal order. Validates: feature enabled, dine-in
 *  acknowledged, menu item available at the branch, ≤1 meal/day. Charge is
 *  balance-aware (standard → credit_cost; special → 50% price; falls back to
 *  cash −10% when credits are short). Being past the cutoff does NOT block
 *  creation — it forces a manager override at confirm time. */
export function createMealOrder(args: {
  userId: number;
  branchId: number;
  menuItemId: number;
  dineInAck: boolean;
  dateBkk: string;
  db?: Database.Database;
}): MealOrderResult {
  const db = args.db ?? getDb();
  const cfg = getMealpassConfig(args.branchId, db);
  if (!cfg.enabled) throw new MealpassError("mealpass_disabled");
  if (!args.dineInAck) throw new MealpassError("dine_in_required");

  const menu = db.prepare(
    "SELECT id, branch_id, name_th, price, is_available, is_standard_meal, credit_cost FROM delivera_menu_items WHERE id = ?"
  ).get(args.menuItemId) as MenuRow | undefined;
  if (!menu || menu.branch_id !== args.branchId) throw new MealpassError("menu_invalid");
  if (!menu.is_available) throw new MealpassError("menu_unavailable");

  // ≤1 in-house meal / day (friendly pre-check; unique index is the guard).
  const existing = db.prepare(
    "SELECT 1 FROM mealpass_orders WHERE user_id = ? AND order_date = ? AND kind = 'meal' AND status IN ('pending','confirmed')"
  ).get(args.userId, args.dateBkk);
  if (existing) throw new MealpassError("already_today");

  const ym = ymOf(args.dateBkk);
  const balance = balanceForUser(args.userId, ym, db);
  const quote = resolveMealCharge({
    isStandard: menu.is_standard_meal === 1,
    creditCost: menu.credit_cost,
    price: menu.price,
    balance,
    cfg,
  });

  // Insert with a unique code (retry on the rare code collision).
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode("MP");
    const token = randomBytes(24).toString("hex");
    try {
      const info = db.prepare(`
        INSERT INTO mealpass_orders
          (user_id, code, kind, order_date, branch_id, menu_item_id, menu_name_snap,
           price_snap, meal_class, credits, baht, status, dine_in_ack, token, expires_at)
        VALUES (?, ?, 'meal', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
      `).run(args.userId, code, args.dateBkk, args.branchId, menu.id, menu.name_th,
        menu.price, quote.mealClass, quote.credits, quote.baht, token, endOfBkkDay(args.dateBkk));
      return {
        id: Number(info.lastInsertRowid), code, mealClass: quote.mealClass,
        credits: quote.credits, baht: quote.baht, menuName: menu.name_th,
        balanceAfter: balance - quote.credits,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Unique meal-per-day index → someone raced us.
      if (/idx_mealpass_meal_once_per_day/.test(msg)) throw new MealpassError("already_today");
      if (/UNIQUE/.test(msg) && attempt < 4) continue; // code/token clash — retry
      throw e;
    }
  }
  throw new MealpassError("code_generation_failed");
}

/** Manager confirms a pending meal order → burns credits (or records the cash
 *  meal) and flips to confirmed. Past the cutoff, an override flag + reason are
 *  required and logged. Re-validates the live balance for credit meals. */
export function confirmMealOrder(args: {
  code: string;
  confirmerUserId: number;
  nowHhmm: string;
  override?: boolean;
  overrideReason?: string | null;
  db?: Database.Database;
}): { ok: true; mealClass: MealClass; credits: number; baht: number } {
  const db = args.db ?? getDb();
  const order = db.prepare(
    "SELECT * FROM mealpass_orders WHERE code = ?"
  ).get(args.code) as {
    id: number; user_id: number; kind: string; order_date: string; branch_id: number;
    menu_item_id: number | null; menu_name_snap: string | null; price_snap: number | null;
    meal_class: MealClass; credits: number; baht: number; status: string;
  } | undefined;
  if (!order) throw new MealpassError("not_found");
  if (order.status === "confirmed") throw new MealpassError("already_confirmed");
  if (order.status !== "pending") throw new MealpassError("not_pending");

  const cfg = getMealpassConfig(order.branch_id, db);
  if (isAfterCutoff(args.nowHhmm, cfg.redeem_cutoff)) {
    if (!args.override) throw new MealpassError("override_required");
    if (!args.overrideReason || !args.overrideReason.trim()) throw new MealpassError("override_reason_required");
  }

  const ym = ymOf(order.order_date);
  // Credit meals: re-check the live balance still covers it.
  if (order.meal_class !== "cash" && order.credits > 0) {
    if (balanceForUser(order.user_id, ym, db) < order.credits) throw new MealpassError("insufficient");
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO mealpass_ledger
        (user_id, ym, entry_type, credits, baht, order_id, menu_item_id, menu_name_snap,
         price_snap, attendance_branch_id, created_by, notes)
      VALUES (?, ?, 'burn', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      order.user_id, ym,
      order.meal_class === "cash" ? 0 : -order.credits,
      order.baht,
      order.id, order.menu_item_id, order.menu_name_snap, order.price_snap,
      order.branch_id, args.confirmerUserId,
      order.meal_class === "cash" ? "จ่ายเงินสด" : (order.meal_class === "special" ? "เมนูพิเศษ" : "เมนูมาตรฐาน")
    );
    db.prepare(`
      UPDATE mealpass_orders
      SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ?,
          override_by = ?, override_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(
      args.confirmerUserId,
      args.override ? args.confirmerUserId : null,
      args.override ? (args.overrideReason ?? null) : null,
      order.id
    );
  });
  tx();
  return { ok: true, mealClass: order.meal_class, credits: order.credits, baht: order.baht };
}

/** Cancel a still-pending order (staff changed their mind / manager rejected).
 *  No ledger movement — nothing was burned yet. */
export function cancelMealOrder(code: string, db: Database.Database = getDb()): void {
  const r = db.prepare(
    "UPDATE mealpass_orders SET status = 'cancelled' WHERE code = ? AND status = 'pending'"
  ).run(code);
  if (r.changes === 0) throw new MealpassError("not_pending");
}

/** Expire pending orders whose day has passed (cron). No ledger movement. */
export function expireStaleMealpassOrders(nowIso: string, db: Database.Database = getDb()): number {
  const r = db.prepare(
    "UPDATE mealpass_orders SET status = 'expired' WHERE status = 'pending' AND expires_at < ?"
  ).run(nowIso);
  return r.changes;
}

// ── In-store drink coupon — FREE 1/day, any shift ──────────────────────────
// Granted on ANY clock-in (regardless of shift length). Redeems one canned
// in-store drink (menu tagged is_store_drink). No credits, no cash. Staff picks
// a drink → QR/code → manager scans/confirms.

export type DrinkCoupon = {
  id: number; user_id: number; coupon_date: string; branch_id: number | null;
  code: string; token: string | null; status: "issued" | "redeemed" | "expired";
  menu_item_id: number | null; menu_name_snap: string | null; price_snap: number | null;
};

/** Grant today's free drink coupon (idempotent per user+day). Returns the
 *  coupon code (existing or new). Call on every clock-in. */
export function grantDrinkCoupon(
  userId: number, branchId: number, dateBkk: string, db: Database.Database = getDb()
): { code: string } {
  const existing = db.prepare(
    "SELECT code FROM mealpass_drink_coupons WHERE user_id = ? AND coupon_date = ?"
  ).get(userId, dateBkk) as { code: string } | undefined;
  if (existing) return { code: existing.code };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode("DR");
    const token = randomBytes(24).toString("hex");
    try {
      db.prepare(
        "INSERT INTO mealpass_drink_coupons (user_id, coupon_date, branch_id, code, token, status) VALUES (?,?,?,?,?,'issued')"
      ).run(userId, dateBkk, branchId, code, token);
      return { code };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // Raced on unique(user, coupon_date) → already granted; return it.
      if (/idx_mealpass_drink_coupons|coupon_date/.test(msg)) {
        const now = db.prepare("SELECT code FROM mealpass_drink_coupons WHERE user_id = ? AND coupon_date = ?")
          .get(userId, dateBkk) as { code: string } | undefined;
        if (now) return now;
      }
      if (/UNIQUE/.test(msg) && attempt < 4) continue; // code/token clash
      throw e;
    }
  }
  throw new MealpassError("code_generation_failed");
}

/** Today's drink coupon for a user (for the staff screen). */
export function getDrinkCouponForDate(
  userId: number, dateBkk: string, db: Database.Database = getDb()
): DrinkCoupon | null {
  return (db.prepare(
    "SELECT * FROM mealpass_drink_coupons WHERE user_id = ? AND coupon_date = ?"
  ).get(userId, dateBkk) as DrinkCoupon | undefined) ?? null;
}

/** Staff picks a canned in-store drink for today's coupon → returns the QR
 *  code/token to show the manager. Validates the item is a store drink at the
 *  coupon's branch and the coupon is still unused. */
export function chooseDrinkForCoupon(args: {
  userId: number; dateBkk: string; menuItemId: number; db?: Database.Database;
}): { code: string; token: string | null } {
  const db = args.db ?? getDb();
  const c = getDrinkCouponForDate(args.userId, args.dateBkk, db);
  if (!c) throw new MealpassError("no_coupon");
  if (c.status !== "issued") throw new MealpassError("already_used");
  const menu = db.prepare(
    "SELECT id, branch_id, name_th, price, is_available, is_store_drink FROM delivera_menu_items WHERE id = ?"
  ).get(args.menuItemId) as
    { id: number; branch_id: number; name_th: string; price: number; is_available: number; is_store_drink: number } | undefined;
  if (!menu || menu.is_store_drink !== 1) throw new MealpassError("menu_invalid");
  if (!menu.is_available) throw new MealpassError("menu_unavailable");
  if (c.branch_id != null && menu.branch_id !== c.branch_id) throw new MealpassError("menu_invalid");
  db.prepare(
    "UPDATE mealpass_drink_coupons SET menu_item_id = ?, menu_name_snap = ?, price_snap = ? WHERE id = ?"
  ).run(menu.id, menu.name_th, menu.price, c.id);
  return { code: c.code, token: c.token };
}

/** Manager confirms (scan/enter) a drink coupon → mark redeemed. Free — no
 *  ledger money row (value is snapshotted on the coupon for the cost report). */
export function redeemDrinkCoupon(args: {
  code: string; confirmerUserId: number; db?: Database.Database;
}): { ok: true; menuName: string | null } {
  const db = args.db ?? getDb();
  const c = db.prepare(
    "SELECT * FROM mealpass_drink_coupons WHERE code = ? OR token = ?"
  ).get(args.code, args.code) as DrinkCoupon | undefined;
  if (!c) throw new MealpassError("not_found");
  if (c.status === "redeemed") throw new MealpassError("already_confirmed");
  if (c.status !== "issued") throw new MealpassError("not_pending");
  if (c.menu_item_id == null) throw new MealpassError("no_drink_chosen");
  db.prepare(
    "UPDATE mealpass_drink_coupons SET status = 'redeemed', redeemed_at = CURRENT_TIMESTAMP, redeemed_by = ?, redeemed_branch_id = ? WHERE id = ? AND status = 'issued'"
  ).run(args.confirmerUserId, c.branch_id, c.id);
  return { ok: true, menuName: c.menu_name_snap };
}

/** Expire unredeemed drink coupons from past days (cron). */
export function expireStaleDrinkCoupons(todayBkk: string, db: Database.Database = getDb()): number {
  return db.prepare(
    "UPDATE mealpass_drink_coupons SET status = 'expired' WHERE status = 'issued' AND coupon_date < ?"
  ).run(todayBkk).changes;
}

// ── Cross-company (ศาลาชิลล์) — buy at a partner company's shop on payroll ──
// An employee of company A buys at company B's in-house shop (e.g. เวลล์เทรด
// staff at ศาลาชิลล์ by จ้อจี้). No credits, no cash — the employee price is
// SUSPENDED as a PAYROLL_CHARGE and deducted from their NEXT payslip at their
// HOME company, then settled B←A between companies. Labour-law: needs written
// consent + a per-person monthly cap (deductions ≤ 1/5 of wage; owner sets the
// baht cap). Not counted against the 1-meal/day rule.

export const MEALPASS_CONSENT_VERSION = "1.0";

/** Has this employee signed the current cross-company payroll-charge consent? */
export function hasMealpassConsent(userId: number, db: Database.Database = getDb()): boolean {
  return !!db.prepare(
    "SELECT 1 FROM mealpass_consent WHERE user_id = ? AND version = ?"
  ).get(userId, MEALPASS_CONSENT_VERSION);
}

/** Record a consent signature (idempotent per user+version). */
export function recordMealpassConsent(userId: number, db: Database.Database = getDb()): void {
  db.prepare(
    "INSERT OR IGNORE INTO mealpass_consent (user_id, version) VALUES (?, ?)"
  ).run(userId, MEALPASS_CONSENT_VERSION);
}

/** Home company of an employee = the company of their primary branch (else the
 *  lowest-id branch). Null when they have no branch. */
export function resolveHomeCompanyId(userId: number, db: Database.Database = getDb()): number | null {
  const row = db.prepare(`
    SELECT b.company_id AS cid
    FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
    WHERE ub.user_id = ?
    ORDER BY ub.is_primary DESC, ub.branch_id ASC LIMIT 1
  `).get(userId) as { cid: number | null } | undefined;
  return row?.cid ?? null;
}

/** Baht already SUSPENDED (confirmed cross-company payroll charges) for a person
 *  this month — for the monthly cap check. */
export function crossCompanyChargedThisMonth(userId: number, ym: string, db: Database.Database = getDb()): number {
  const r = db.prepare(
    "SELECT COALESCE(SUM(baht),0) AS n FROM mealpass_ledger WHERE user_id = ? AND ym = ? AND entry_type = 'payroll_charge'"
  ).get(userId, ym) as { n: number };
  return r.n;
}

/** Pure cap check — is there room for another `addBaht` charge? */
export function withinCrossCompanyCap(alreadyBaht: number, addBaht: number, capBaht: number): boolean {
  return alreadyBaht + addBaht <= capBaht;
}

export type CrossOrderResult = {
  id: number; code: string; baht: number; menuName: string;
  sellingCompanyId: number; homeCompanyId: number;
};

/** Create a pending cross-company order (SC-xxxx). Requires: signed consent,
 *  the item is at a DIFFERENT company's branch than the buyer's home company,
 *  and the buyer is under their monthly suspended-charge cap. No credits/cash —
 *  the employee price is charged to payroll on partner confirm. */
export function createCrossCompanyOrder(args: {
  buyerUserId: number;
  sellingBranchId: number;
  menuItemId: number;
  dateBkk: string;
  db?: Database.Database;
}): CrossOrderResult {
  const db = args.db ?? getDb();
  if (!hasMealpassConsent(args.buyerUserId, db)) throw new MealpassError("consent_required");

  const menu = db.prepare(
    "SELECT id, branch_id, name_th, price, is_available FROM delivera_menu_items WHERE id = ?"
  ).get(args.menuItemId) as { id: number; branch_id: number; name_th: string; price: number; is_available: number } | undefined;
  if (!menu || menu.branch_id !== args.sellingBranchId) throw new MealpassError("menu_invalid");
  if (!menu.is_available) throw new MealpassError("menu_unavailable");

  const sellingCompany = (db.prepare("SELECT company_id AS cid FROM branches WHERE id = ?")
    .get(args.sellingBranchId) as { cid: number | null } | undefined)?.cid ?? null;
  const homeCompany = resolveHomeCompanyId(args.buyerUserId, db);
  if (sellingCompany == null || homeCompany == null) throw new MealpassError("company_unknown");
  if (sellingCompany === homeCompany) throw new MealpassError("not_cross_company"); // use the meal flow

  // Cap from the buyer's HOME branch config (per-person monthly suspended cap).
  const homeBranch = db.prepare(`
    SELECT ub.branch_id AS bid FROM user_branches ub
    WHERE ub.user_id = ? ORDER BY ub.is_primary DESC, ub.branch_id ASC LIMIT 1
  `).get(args.buyerUserId) as { bid: number } | undefined;
  const cap = getMealpassConfig(homeBranch?.bid ?? -1, db).cross_company_cap_baht;
  const ym = ymOf(args.dateBkk);
  if (!withinCrossCompanyCap(crossCompanyChargedThisMonth(args.buyerUserId, ym, db), menu.price, cap)) {
    throw new MealpassError("cap_exceeded");
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode("SC");
    const token = randomBytes(24).toString("hex");
    try {
      const info = db.prepare(`
        INSERT INTO mealpass_orders
          (user_id, code, kind, order_date, branch_id, selling_company_id, menu_item_id,
           menu_name_snap, price_snap, credits, baht, status, consent_at, consent_by, token, expires_at)
        VALUES (?, ?, 'cross_company', ?, ?, ?, ?, ?, ?, 0, ?, 'pending', CURRENT_TIMESTAMP, ?, ?, ?)
      `).run(args.buyerUserId, code, args.dateBkk, args.sellingBranchId, sellingCompany, menu.id,
        menu.name_th, menu.price, menu.price, args.buyerUserId, token, endOfBkkDay(args.dateBkk));
      return {
        id: Number(info.lastInsertRowid), code, baht: menu.price, menuName: menu.name_th,
        sellingCompanyId: sellingCompany, homeCompanyId: homeCompany,
      };
    } catch (e) {
      if (e instanceof Error && /UNIQUE/.test(e.message) && attempt < 4) continue;
      throw e;
    }
  }
  throw new MealpassError("code_generation_failed");
}

/** Partner staff confirms a cross-company order → posts the PAYROLL_CHARGE
 *  ledger row (baht only) against the buyer's home company. Re-checks the cap. */
export function confirmCrossCompanyOrder(args: {
  code: string; confirmerUserId: number; db?: Database.Database;
}): { ok: true; baht: number } {
  const db = args.db ?? getDb();
  const order = db.prepare("SELECT * FROM mealpass_orders WHERE code = ?").get(args.code) as {
    id: number; user_id: number; kind: string; order_date: string; branch_id: number;
    selling_company_id: number | null; menu_item_id: number | null; menu_name_snap: string | null;
    price_snap: number | null; baht: number; status: string;
  } | undefined;
  if (!order || order.kind !== "cross_company") throw new MealpassError("not_found");
  if (order.status === "confirmed") throw new MealpassError("already_confirmed");
  if (order.status !== "pending") throw new MealpassError("not_pending");

  const ym = ymOf(order.order_date);
  const homeCompany = resolveHomeCompanyId(order.user_id, db);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO mealpass_ledger
        (user_id, ym, entry_type, credits, baht, order_id, menu_item_id, menu_name_snap, price_snap,
         attendance_branch_id, selling_company_id, home_company_id, created_by, notes)
      VALUES (?, ?, 'payroll_charge', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ศาลาชิลล์ (หักเงินเดือน)')
    `).run(order.user_id, ym, order.baht, order.id, order.menu_item_id, order.menu_name_snap,
      order.price_snap, order.branch_id, order.selling_company_id, homeCompany, args.confirmerUserId);
    db.prepare(
      "UPDATE mealpass_orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, confirmed_by = ? WHERE id = ? AND status = 'pending'"
    ).run(args.confirmerUserId, order.id);
  });
  tx();
  return { ok: true, baht: order.baht };
}
