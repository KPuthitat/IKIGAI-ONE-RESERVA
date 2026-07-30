import { getDb } from "@/lib/db";
import { bookingStartMs, timeToMinutes } from "@/lib/time";

// Staff meal coupons (owner 2026-07-12). A staff member who clocks in to the
// 11:00 / 12:00 lunch shift (and isn't too late) is issued a lunch coupon and a
// drink coupon, shown as a pop-up on clock-in. Each is redeemable from the
// branch's Delivera menu (admin curates which items count, tagged food/drink)
// before a per-branch cutoff (default 15:00), after which it expires. Coupons
// are branch-agnostic entitlements — redeem at either branch, picking from that
// branch's eligible list. See runMigrations() in db.ts for the schema.

export type MealCouponType = "food" | "drink";
export type MealCouponStatus = "issued" | "redeemed" | "expired";

export type MealCouponConfig = {
  enabled: boolean;
  eligibleStarts: string[]; // ["11:00","12:00"]
  redeemCutoff: string;     // "HH:MM"
  graceMin: number;
};

export type MealCouponRow = {
  id: number;
  user_id: number;
  coupon_date: string;
  type: MealCouponType;
  status: MealCouponStatus;      // raw stored status
  effectiveStatus: MealCouponStatus; // 'issued' past cutoff → 'expired'
  issued_branch_id: number | null;
  redeem_before: string;         // ISO (UTC)
  redeemed_at: string | null;
  redeemed_branch_id: number | null;
  redeemed_menu_item_id: number | null;
  redeemed_menu_name: string | null;
};

export type EligibleMenuItem = {
  id: number; name_th: string; price: number; image_url: string | null;
  credit_value: number | null;   // food welfare credit (60/120); null for drinks / untagged
};

/** Read the branch's meal-coupon config. */
export function mealCouponConfig(branchId: number): MealCouponConfig {
  const b = getDb().prepare(
    `SELECT meal_coupon_enabled AS en, meal_coupon_eligible_starts AS starts,
            meal_coupon_redeem_cutoff AS cutoff, meal_coupon_late_grace_min AS grace
       FROM branches WHERE id = ?`
  ).get(branchId) as
    | { en: number; starts: string; cutoff: string; grace: number }
    | undefined;
  return {
    enabled: !!b?.en,
    eligibleStarts: (b?.starts ?? "11:00,12:00").split(",").map((s) => s.trim()).filter(Boolean),
    redeemCutoff: b?.cutoff ?? "15:00",
    graceMin: Number(b?.grace) || 0
  };
}

/** 1C eligibility: the scheduled shift starts at an eligible time AND the punch
 *  isn't later than that start + grace. `shiftStart` is "HH:MM" or null. */
export function isEligibleClockIn(
  cfg: MealCouponConfig, shiftStart: string | null, clockInMinutes: number
): boolean {
  if (!cfg.enabled || !shiftStart) return false;
  if (!cfg.eligibleStarts.includes(shiftStart)) return false;
  return clockInMinutes <= timeToMinutes(shiftStart) + cfg.graceMin;
}

/** Minimum rostered shift length (minutes) to qualify for the FREE lunch meal
 *  (owner 2026-07-30): "กะที่ลงไว้เกิน 8 ชั่วโมง" → strictly more than 8h. */
export const MEAL_FOOD_MIN_SHIFT_MINUTES = 480;

/** สวัสดิการอาหารกลางวัน eligibility (owner 2026-07-30): BOTH the clock-in gate
 *  (eligible start time + not too late, see isEligibleClockIn) AND a rostered
 *  shift strictly longer than 8h. The drink coupon keeps the looser clock-in
 *  gate — this stricter rule is food-only. */
export function isFoodEligible(
  cfg: MealCouponConfig, shiftStart: string | null, clockInMinutes: number,
  scheduledMinutes: number
): boolean {
  return isEligibleClockIn(cfg, shiftStart, clockInMinutes)
    && scheduledMinutes > MEAL_FOOD_MIN_SHIFT_MINUTES;
}

/** Issue today's coupons for a user, once per (user, date). `opts` selects
 *  which types to issue — food follows the stricter >8h rule, drink the looser
 *  clock-in gate (owner 2026-07-30), so the caller decides each independently.
 *  Returns the pop-up payload, or null if already issued today / nothing to
 *  issue. */
export function issueDailyCoupons(
  userId: number, branchId: number, dateBkk: string,
  opts: { food: boolean; drink: boolean }
): { food: boolean; drink: boolean; redeemBefore: string } | null {
  if (!opts.food && !opts.drink) return null;
  const db = getDb();
  const existing = db.prepare(
    "SELECT COUNT(*) AS n FROM meal_coupons WHERE user_id = ? AND coupon_date = ?"
  ).get(userId, dateBkk) as { n: number };
  if (existing.n > 0) return null;

  const cfg = mealCouponConfig(branchId);
  const redeemBeforeIso = new Date(bookingStartMs(dateBkk, cfg.redeemCutoff)).toISOString();
  const now = new Date().toISOString();
  const ins = db.prepare(
    `INSERT INTO meal_coupons (user_id, coupon_date, type, status, issued_branch_id, redeem_before, created_at)
     VALUES (?, ?, ?, 'issued', ?, ?, ?)`
  );
  const txn = db.transaction(() => {
    if (opts.food) ins.run(userId, dateBkk, "food", branchId, redeemBeforeIso, now);
    if (opts.drink) ins.run(userId, dateBkk, "drink", branchId, redeemBeforeIso, now);
  });
  txn();
  return { food: opts.food, drink: opts.drink, redeemBefore: cfg.redeemCutoff };
}

function effectiveStatus(status: MealCouponStatus, redeemBefore: string): MealCouponStatus {
  if (status === "issued" && Date.now() > Date.parse(redeemBefore)) return "expired";
  return status;
}

/** A user's coupons for a date, with lazily-computed expired status. */
export function listUserCouponsForDate(userId: number, dateBkk: string): MealCouponRow[] {
  const rows = getDb().prepare(
    `SELECT id, user_id, coupon_date, type, status, issued_branch_id, redeem_before,
            redeemed_at, redeemed_branch_id, redeemed_menu_item_id, redeemed_menu_name
       FROM meal_coupons WHERE user_id = ? AND coupon_date = ?
      ORDER BY type`
  ).all(userId, dateBkk) as Array<Omit<MealCouponRow, "effectiveStatus">>;
  return rows.map((r) => ({ ...r, effectiveStatus: effectiveStatus(r.status, r.redeem_before) }));
}

/** Eligible menu items of a type for a branch (active + available only). */
export function listEligibleMenu(branchId: number, type: MealCouponType): EligibleMenuItem[] {
  return getDb().prepare(
    `SELECT m.id, m.name_th, m.price, m.image_url, cm.credit_value
       FROM meal_coupon_menu cm
       JOIN delivera_menu_items m ON m.id = cm.menu_item_id
      WHERE cm.branch_id = ? AND cm.type = ? AND cm.active = 1 AND m.is_available = 1
      ORDER BY m.sort_order, m.name_th`
  ).all(branchId, type) as EligibleMenuItem[];
}

export type RedeemResult =
  | { ok: true; type: MealCouponType; menuName: string; branchId: number }
  | { ok: false; error: "not_found" | "already_redeemed" | "not_redeemable" | "expired" | "menu_invalid" };

/** Idempotent redeem: the user picks a menu item at their active branch. */
export function redeemCoupon(
  userId: number, couponId: number, activeBranchId: number, menuItemId: number
): RedeemResult {
  const db = getDb();
  const c = db.prepare(
    "SELECT id, type, status, redeem_before FROM meal_coupons WHERE id = ? AND user_id = ?"
  ).get(couponId, userId) as
    | { id: number; type: MealCouponType; status: MealCouponStatus; redeem_before: string }
    | undefined;
  if (!c) return { ok: false, error: "not_found" };
  if (c.status === "redeemed") return { ok: false, error: "already_redeemed" };
  if (c.status !== "issued") return { ok: false, error: "not_redeemable" };
  if (Date.now() > Date.parse(c.redeem_before)) {
    db.prepare("UPDATE meal_coupons SET status = 'expired' WHERE id = ? AND status = 'issued'").run(couponId);
    return { ok: false, error: "expired" };
  }
  // Menu must be an active, available, eligible item of the coupon's type at the
  // branch the user is currently at.
  const item = db.prepare(
    `SELECT m.name_th AS name, cm.credit_value
       FROM meal_coupon_menu cm
       JOIN delivera_menu_items m ON m.id = cm.menu_item_id
      WHERE cm.branch_id = ? AND cm.menu_item_id = ? AND cm.type = ?
        AND cm.active = 1 AND m.is_available = 1`
  ).get(activeBranchId, menuItemId, c.type) as { name: string; credit_value: number | null } | undefined;
  if (!item) return { ok: false, error: "menu_invalid" };

  // Snapshot the FOOD welfare credit onto the coupon (drinks carry no credit) —
  // this is what the SVC clawback reads if the shift is left early (owner
  // 2026-07-30). Frozen here so a later menu re-pricing can't rewrite history.
  const creditValue = c.type === "food" ? item.credit_value : null;
  const info = db.prepare(
    `UPDATE meal_coupons
        SET status = 'redeemed', redeemed_at = ?, redeemed_branch_id = ?,
            redeemed_menu_item_id = ?, redeemed_menu_name = ?, credit_value = ?
      WHERE id = ? AND status = 'issued'`
  ).run(new Date().toISOString(), activeBranchId, menuItemId, item.name, creditValue, couponId);
  if (info.changes === 0) return { ok: false, error: "not_redeemable" };
  return { ok: true, type: c.type, menuName: item.name, branchId: activeBranchId };
}

// ── Admin config helpers ─────────────────────────────────────────────────

export function updateMealCouponConfig(
  branchId: number,
  patch: { enabled?: boolean; eligibleStarts?: string[]; redeemCutoff?: string; graceMin?: number }
): void {
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  if (patch.enabled !== undefined) { sets.push("meal_coupon_enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
  if (patch.eligibleStarts !== undefined) { sets.push("meal_coupon_eligible_starts = ?"); vals.push(patch.eligibleStarts.join(",")); }
  if (patch.redeemCutoff !== undefined) { sets.push("meal_coupon_redeem_cutoff = ?"); vals.push(patch.redeemCutoff); }
  if (patch.graceMin !== undefined) { sets.push("meal_coupon_late_grace_min = ?"); vals.push(patch.graceMin); }
  if (sets.length === 0) return;
  vals.push(branchId);
  getDb().prepare(`UPDATE branches SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export type CouponMenuAdminRow = {
  id: number; menu_item_id: number; name_th: string; type: MealCouponType;
  active: number; price: number; is_available: number; credit_value: number | null;
};

export function listCouponMenuAdmin(branchId: number): CouponMenuAdminRow[] {
  return getDb().prepare(
    `SELECT cm.id, cm.menu_item_id, m.name_th, cm.type, cm.active, m.price, m.is_available, cm.credit_value
       FROM meal_coupon_menu cm
       JOIN delivera_menu_items m ON m.id = cm.menu_item_id
      WHERE cm.branch_id = ?
      ORDER BY cm.type, m.sort_order, m.name_th`
  ).all(branchId) as CouponMenuAdminRow[];
}

/** Set (or clear) a FOOD menu item's welfare credit value (60/120). Passing
 *  null clears it. Only meaningful for food rows; a value on a drink row is
 *  ignored by redeem. Guarded to the branch that owns the tag. */
export function setCouponMenuCredit(id: number, branchId: number, credit: number | null): void {
  getDb().prepare("UPDATE meal_coupon_menu SET credit_value = ? WHERE id = ? AND branch_id = ? AND type = 'food'")
    .run(credit, id, branchId);
}

/** Add (or re-tag) a menu item as coupon-eligible. */
export function addCouponMenu(branchId: number, menuItemId: number, type: MealCouponType): void {
  // Guard: the item must belong to this branch.
  const owned = getDb().prepare(
    "SELECT 1 FROM delivera_menu_items WHERE id = ? AND branch_id = ?"
  ).get(menuItemId, branchId);
  if (!owned) return;
  getDb().prepare(
    `INSERT INTO meal_coupon_menu (branch_id, menu_item_id, type, active, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(branch_id, menu_item_id) DO UPDATE SET type = excluded.type, active = 1`
  ).run(branchId, menuItemId, type, new Date().toISOString());
}

export function setCouponMenuActive(id: number, branchId: number, active: boolean): void {
  getDb().prepare("UPDATE meal_coupon_menu SET active = ? WHERE id = ? AND branch_id = ?")
    .run(active ? 1 : 0, id, branchId);
}

export function removeCouponMenu(id: number, branchId: number): void {
  getDb().prepare("DELETE FROM meal_coupon_menu WHERE id = ? AND branch_id = ?").run(id, branchId);
}

// ── Daily summary (owner 2026-07-12) ──────────────────────────────────────
// One combined rollup for the executive group at the cutoff (~15:00): who
// redeemed what vs who was issued a coupon but didn't use it. Grouped by the
// branch where the coupon was issued (clocked in). A coupon is "used" when
// status='redeemed'; anything still 'issued' at summary time is treated as
// not-used (the summary runs after the cutoff, so those have expired).

export type MealCouponDaySummary = {
  hasAny: boolean;
  branches: Array<{
    name: string;
    redeemed: Array<{ name: string; typeLabel: string; menu: string }>;
    unused: Array<{ name: string; typeLabel: string }>;
  }>;
  totals: { people: number; redeemed: number; unused: number };
};

const typeLabelTh = (t: MealCouponType) => (t === "food" ? "อาหารกลางวัน" : "เครื่องดื่ม");

export function buildMealCouponDaySummary(dateBkk: string): MealCouponDaySummary {
  const db = getDb();
  const rows = db.prepare(
    `SELECT c.issued_branch_id AS bid, c.type, c.status, c.redeemed_menu_name AS menu,
            c.user_id AS uid, COALESCE(u.nickname_th, u.display_name) AS name
       FROM meal_coupons c
       JOIN users u ON u.id = c.user_id
      WHERE c.coupon_date = ?
      ORDER BY name COLLATE NOCASE`
  ).all(dateBkk) as Array<{
    bid: number | null; type: MealCouponType; status: MealCouponStatus;
    menu: string | null; uid: number; name: string;
  }>;

  const people = new Set<number>();
  let redeemedCount = 0, unusedCount = 0;
  const byBranch = new Map<number, {
    redeemed: Array<{ name: string; typeLabel: string; menu: string }>;
    unused: Array<{ name: string; typeLabel: string }>;
  }>();
  for (const r of rows) {
    people.add(r.uid);
    const key = r.bid ?? -1;
    const grp = byBranch.get(key) ?? { redeemed: [], unused: [] };
    if (r.status === "redeemed") {
      grp.redeemed.push({ name: r.name, typeLabel: typeLabelTh(r.type), menu: r.menu ?? "-" });
      redeemedCount += 1;
    } else {
      grp.unused.push({ name: r.name, typeLabel: typeLabelTh(r.type) });
      unusedCount += 1;
    }
    byBranch.set(key, grp);
  }

  // Resolve branch names (grouped by where the coupon was issued).
  const nameById = new Map<number, string>();
  const bids = [...byBranch.keys()].filter((k) => k >= 0);
  if (bids.length > 0) {
    const ph = bids.map(() => "?").join(",");
    for (const b of db.prepare(`SELECT id, name FROM branches WHERE id IN (${ph})`).all(...bids) as Array<{ id: number; name: string }>) {
      nameById.set(b.id, b.name);
    }
  }
  const branches = [...byBranch.entries()].map(([key, grp]) => ({
    name: key >= 0 ? (nameById.get(key) ?? `สาขา #${key}`) : "ไม่ระบุสาขา",
    ...grp
  }));

  return {
    hasAny: rows.length > 0,
    branches,
    totals: { people: people.size, redeemed: redeemedCount, unused: unusedCount }
  };
}

// ── Monthly report (owner 2026-07-12) ─────────────────────────────────────
// Per-branch analytics for a month: which menus were redeemed most, and how
// many coupons were redeemed at the issuing branch (own) vs a different branch
// (cross). Perspective = coupons ISSUED at `branchId` (= this branch's staff).

export type MealCouponMonthlyReport = {
  month: string; // YYYY-MM
  topMenus: Array<{ menu: string; count: number }>;
  ownVsCross: { own: number; cross: number };
  totals: { issued: number; redeemed: number; unused: number };
};

export function mealCouponMonthlyReport(branchId: number, month: string): MealCouponMonthlyReport {
  const db = getDb();
  const where = "substr(coupon_date, 1, 7) = ? AND issued_branch_id = ?";

  const totalsRow = db.prepare(
    `SELECT COUNT(*) AS issued,
            SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) AS redeemed
       FROM meal_coupons WHERE ${where}`
  ).get(month, branchId) as { issued: number; redeemed: number | null };
  const issued = totalsRow.issued ?? 0;
  const redeemed = totalsRow.redeemed ?? 0;

  const topMenus = db.prepare(
    `SELECT redeemed_menu_name AS menu, COUNT(*) AS count
       FROM meal_coupons
      WHERE ${where} AND status = 'redeemed' AND redeemed_menu_name IS NOT NULL
      GROUP BY redeemed_menu_name
      ORDER BY count DESC, redeemed_menu_name COLLATE NOCASE
      LIMIT 10`
  ).all(month, branchId) as Array<{ menu: string; count: number }>;

  const oc = db.prepare(
    `SELECT SUM(CASE WHEN redeemed_branch_id = ? THEN 1 ELSE 0 END) AS own_ct,
            SUM(CASE WHEN redeemed_branch_id IS NOT NULL AND redeemed_branch_id != ? THEN 1 ELSE 0 END) AS cross_ct
       FROM meal_coupons WHERE ${where} AND status = 'redeemed'`
  ).get(branchId, branchId, month, branchId) as { own_ct: number | null; cross_ct: number | null };

  return {
    month,
    topMenus,
    ownVsCross: { own: oc.own_ct ?? 0, cross: oc.cross_ct ?? 0 },
    totals: { issued, redeemed, unused: Math.max(0, issued - redeemed) }
  };
}
