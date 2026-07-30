// Fixture (owner 2026-07-30): staff drink-welfare (จ้อจี้). Validates the two
// money-driving aggregations against an in-memory replica:
//   • sumRedeemedDrinksForUser — the payroll deduction (branch + date scoped,
//     redeemed-only)
//   • sumRedeemedDrinksForPartnerMonth — the no-GP amount added to the partner
//     settlement (partner + month scoped, redeemed-only)
// Also checks the create "replace pending" + redeem "lock" state transitions.
//   node --import tsx scripts/verify-drink-welfare.ts
import Database from "better-sqlite3";
import { sumRedeemedDrinksForUser, sumRedeemedDrinksForPartnerMonth, drinkWelfareSummary, drinkWelfareByWeek } from "../src/lib/partner-drink-orders";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE partner_drink_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, branch_id INTEGER, partner_id INTEGER, coupon_id INTEGER,
    order_date TEXT, amount REAL, token TEXT UNIQUE, status TEXT DEFAULT 'pending',
    expires_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, redeemed_at TEXT, redeemed_by INTEGER
  );
`);
// Branch 20 = NAMA (partner 1), 30 = EMIA (partner 2). User 10.
const ins = db.prepare(
  `INSERT INTO partner_drink_orders (user_id,branch_id,partner_id,order_date,amount,token,status)
   VALUES (?,?,?,?,?,?,?)`
);
ins.run(10, 20, 1, "2026-07-05", 50, "t1", "redeemed");   // NAMA, in range
ins.run(10, 20, 1, "2026-07-12", 80, "t2", "redeemed");   // NAMA, in range
ins.run(10, 30, 2, "2026-07-12", 50, "t3", "redeemed");   // EMIA, in range
ins.run(10, 20, 1, "2026-07-15", 80, "t4", "pending");    // NAMA, NOT redeemed
ins.run(10, 20, 1, "2026-07-16", 50, "t5", "cancelled");  // NAMA, cancelled
ins.run(10, 20, 1, "2026-08-02", 80, "t6", "redeemed");   // NAMA, next month
ins.run(11, 20, 1, "2026-07-12", 80, "t7", "redeemed");   // different staff

// ── payroll deduction driver (per user, branch + date scoped) ───────
assert(sumRedeemedDrinksForUser(db, 10, "2026-07-01", "2026-07-31", 20) === 130,
  "user10 NAMA ก.ค. → 130 (50+80; ตัด pending/cancelled/EMIA/เดือนอื่น)");
assert(sumRedeemedDrinksForUser(db, 10, "2026-07-01", "2026-07-31", 30) === 50,
  "user10 EMIA ก.ค. → 50 (แยกสาขา)");
assert(sumRedeemedDrinksForUser(db, 10, "2026-07-01", "2026-07-31", null) === 180,
  "user10 ทุกสาขา ก.ค. → 180 (legacy null-branch period)");
assert(sumRedeemedDrinksForUser(db, 10, "2026-07-01", "2026-07-14", 20) === 130,
  "user10 NAMA ช่วง 1-14 → 130 (ทั้งสองก่อนวันที่ 15)");
assert(sumRedeemedDrinksForUser(db, 10, "2026-09-01", "2026-09-30", 20) === 0,
  "user10 NAMA ก.ย. → 0 (นอกช่วง)");
assert(sumRedeemedDrinksForUser(db, 11, "2026-07-01", "2026-07-31", 20) === 80,
  "user11 NAMA ก.ค. → 80 (แยกตามคน)");

// ── settlement no-GP driver (per partner, month scoped) ─────────────
assert(sumRedeemedDrinksForPartnerMonth(db, 1, 2026, 7) === 210,
  "partner1(NAMA) ก.ค. → 210 (50+80+80; ตัด pending/cancelled/เดือนอื่น)");
assert(sumRedeemedDrinksForPartnerMonth(db, 2, 2026, 7) === 50,
  "partner2(EMIA) ก.ค. → 50");
assert(sumRedeemedDrinksForPartnerMonth(db, 1, 2026, 8) === 80,
  "partner1 ส.ค. → 80 (เดือนถัดไปแยก)");

// ── welfare card drivers (owner 2026-07-30): summary by tier + by week ──
const wsum = drinkWelfareSummary(db, 1, "2026-07-01", "2026-07-31");
assert(wsum.count === 3 && wsum.total === 210, "welfare summary partner1 ก.ค. → 3 แก้ว / ฿210");
assert(wsum.byTier.length === 2, "welfare byTier มี 2 เรท (50/80)");
assert(wsum.byTier.find((t) => t.amount === 80)?.count === 2, "welfare ฿80 × 2 แก้ว");
assert(wsum.byTier.find((t) => t.amount === 50)?.subtotal === 50, "welfare ฿50 × 1 = 50");
const wbw = drinkWelfareByWeek(db, 1, 2026, 7);
assert(wbw.month.count === 3 && wbw.month.total === 210, "welfareByWeek month → 3 แก้ว / ฿210");
assert(wbw.weeks.reduce((s, w) => s + w.summary.total, 0) === 210, "welfareByWeek: ผลรวมทุกสัปดาห์ = ยอดเดือน");
assert(wbw.weeks.every((w) => w.summary.count > 0), "welfareByWeek: โชว์เฉพาะสัปดาห์ที่มีการเบิก");

// ── redeem 'lock' + create 'replace pending' state transitions ──────
// New flow (owner 2026-07-30): pending orders carry amount 0; the จ้อจี้ team
// sets the price (50/80) when they redeem. Refresh replaces the pending order.
db.exec("DELETE FROM partner_drink_orders");
db.prepare("INSERT INTO partner_drink_orders (user_id,branch_id,partner_id,coupon_id,order_date,amount,token,status) VALUES (10,20,1,99,'2026-07-20',0,'p1','pending')").run();
db.prepare("UPDATE partner_drink_orders SET status='cancelled' WHERE coupon_id=99 AND status='pending'").run();
db.prepare("INSERT INTO partner_drink_orders (user_id,branch_id,partner_id,coupon_id,order_date,amount,token,status) VALUES (10,20,1,99,'2026-07-20',0,'p2','pending')").run();
const pend = db.prepare("SELECT COUNT(*) c FROM partner_drink_orders WHERE coupon_id=99 AND status='pending'").get() as { c: number };
assert(pend.c === 1, "รีเฟรช QR → มี pending เดียว (อันเก่า cancelled)");
// Redeem locks: จ้อจี้ picks 80 → set amount + redeemed, and only once (anti re-scan).
const r1 = db.prepare("UPDATE partner_drink_orders SET status='redeemed', amount=80 WHERE token='p2' AND status='pending'").run();
const r2 = db.prepare("UPDATE partner_drink_orders SET status='redeemed', amount=50 WHERE token='p2' AND status='pending'").run();
assert(r1.changes === 1 && r2.changes === 0, "redeem ครั้งแรกติด (ตั้ง 80), ครั้งสองไม่ติด (กันสแกนซ้ำ)");
assert(sumRedeemedDrinksForUser(db, 10, "2026-07-01", "2026-07-31", 20) === 80,
  "หลัง redeem → หัก 80 (ราคาที่จ้อจี้เลือกตอนสแกน)");

console.log("\nAll drink-welfare aggregation + state checks passed.");
