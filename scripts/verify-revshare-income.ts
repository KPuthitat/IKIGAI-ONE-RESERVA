// Fixture: postRevshareDailyIncome — mirrors a revenue-share partner's daily
// sales into the seller branch's ACCOUNTA รายรับ on "ส่งยอดวันนี้" (owner
// 2026-07-25). Replicates the helper's delete-then-insert SQL against an
// in-memory DB (getDb can't bootstrap a fresh DB) to lock: VAT-inclusive
// amount, source='revshare' idempotency, per-partner channel scoping, is_vat.
// Run:  node --import tsx scripts/verify-revshare-income.ts
import Database from "better-sqlite3";
import { salesVat } from "../src/lib/revshare";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE branches (id INTEGER PRIMARY KEY, company_id INTEGER);
  CREATE TABLE accounta_income_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, name TEXT, sort_order INTEGER, active INTEGER DEFAULT 1
  );
  CREATE TABLE accounta_income (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, company_id INTEGER, income_date TEXT,
    channel TEXT, amount REAL, note TEXT, created_by INTEGER,
    source TEXT NOT NULL DEFAULT 'manual', is_vat INTEGER DEFAULT 1, is_revenue INTEGER DEFAULT 1
  );
`);
db.prepare("INSERT INTO branches (id, company_id) VALUES (7, 3)").run(); // ศาลาชิลล์

// Replica of postRevshareDailyIncome's transaction body.
function post(d: { branchId: number; date: string; channel: string; amount: number; isVat: boolean; userId: number }) {
  const amt = Math.round((d.amount + 1e-9) * 100) / 100;
  const channel = d.channel.trim() || null;
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(d.branchId) as { company_id: number } | undefined)?.company_id ?? null;
  const txn = db.transaction(() => {
    if (channel) {
      const ex = db.prepare("SELECT id FROM accounta_income_channels WHERE branch_id=? AND name=? COLLATE NOCASE").get(d.branchId, channel) as { id: number } | undefined;
      if (!ex) db.prepare("INSERT INTO accounta_income_channels (branch_id,name,sort_order) VALUES (?,?,10)").run(d.branchId, channel);
    }
    db.prepare("DELETE FROM accounta_income WHERE branch_id=? AND income_date=? AND source='revshare' AND channel IS ?").run(d.branchId, d.date, channel);
    if (amt <= 0) return;
    db.prepare(
      `INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, created_by, source, is_vat, is_revenue)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'revshare', ?, 1)`
    ).run(d.branchId, companyId, d.date, channel, amt, `ยอดขายส่วนแบ่งยอดขายรายวัน · ${channel}`, d.userId, d.isVat ? 1 : 0);
  });
  txn();
}

const rows = () => db.prepare("SELECT * FROM accounta_income WHERE source='revshare' ORDER BY id").all() as Array<Record<string, unknown>>;

// gross 2,630 → รวม VAT 2,814.10, is_vat=1, posted to ศาลาชิลล์ (branch 7).
const total = salesVat(2630, 0.07, false).total;
post({ branchId: 7, date: "2026-07-25", channel: "จ้อจี้ & friends", amount: total, isVat: true, userId: 1 });
let r = rows();
assert(r.length === 1, "one revshare income row after first post");
assert(r[0].amount === 2814.1, "amount = รวม VAT (2,814.10)");
assert(r[0].is_vat === 1 && r[0].is_revenue === 1, "row is VAT-bearing revenue");
assert(r[0].branch_id === 7 && r[0].company_id === 3, "posted to seller branch + its company");
assert(r[0].channel === "จ้อจี้ & friends", "channel = partner name");
assert((db.prepare("SELECT COUNT(*) c FROM accounta_income_channels WHERE branch_id=7").get() as { c: number }).c === 1, "channel registered for the manual dropdown");

// Re-send same day → still one row (idempotent), amount refreshed if it changed.
post({ branchId: 7, date: "2026-07-25", channel: "จ้อจี้ & friends", amount: salesVat(3000, 0.07, false).total, isVat: true, userId: 1 });
r = rows();
assert(r.length === 1, "re-sending the day does not double-post");
assert(r[0].amount === 3210, "re-post refreshes the amount (3,000 × 1.07)");

// A second partner on the same day → separate row (channel scopes the dedupe).
post({ branchId: 7, date: "2026-07-25", channel: "ร้านอื่น", amount: salesVat(1000, 0.07, false).total, isVat: true, userId: 1 });
assert(rows().length === 2, "different partner same day → its own row, not a clobber");

// VAT disabled → is_vat=0, amount = the raw figure (salesVat with rate 0).
post({ branchId: 7, date: "2026-07-26", channel: "จ้อจี้ & friends", amount: salesVat(500, 0, false).total, isVat: false, userId: 1 });
const nv = db.prepare("SELECT * FROM accounta_income WHERE income_date='2026-07-26'").get() as Record<string, unknown>;
assert(nv.is_vat === 0 && nv.amount === 500, "VAT-disabled partner → is_vat=0, amount unchanged");

console.log("\nALL REVSHARE-INCOME FIXTURES PASSED");
