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

/** Raw credits a day would earn (before the monthly cap). */
export function creditsForShift(
  scheduledMin: number,
  workedMin: number,
  cfg: Pick<MealpassConfig, "full_day_credits" | "half_day_credits">
): number {
  switch (classifyShift(scheduledMin, workedMin)) {
    case "full": return cfg.full_day_credits;
    case "half": return cfg.half_day_credits;
    default: return 0;
  }
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
