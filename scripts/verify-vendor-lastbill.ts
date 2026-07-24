// Fixture: vendorLastBills — the most-recent CONFIRMED bill per vendor feeds the
// expense-form auto-prefill (owner 2026-07-24). Validates the "newest per vendor
// wins, drafts excluded" query against an in-memory DB.
// Run:  node --import tsx scripts/verify-vendor-lastbill.ts
import Database from "better-sqlite3";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE accounta_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER, vendor_name TEXT,
    category TEXT, description TEXT, doc_type TEXT, payment_method TEXT, payment_status TEXT,
    has_tax_invoice INTEGER DEFAULT 0, wht_rate REAL DEFAULT 0, is_fixed INTEGER DEFAULT 0,
    due_mode TEXT, capex_bucket TEXT, bill_date TEXT, review_status TEXT DEFAULT 'confirmed'
  );
`);
const ins = db.prepare(`INSERT INTO accounta_expenses
  (branch_id,vendor_name,category,description,payment_method,payment_status,has_tax_invoice,wht_rate,is_fixed,bill_date,review_status)
  VALUES (1,?,?,?,?,?,?,?,?,?,?)`);
// Vendor A: older + newer confirmed → newer should win.
ins.run("บ.เอ", "ค่าเช่า", "ค่าเช่าเก่า", "transfer", "unpaid", 1, 0.05, 1, "2026-05-01", "confirmed");
ins.run("บ.เอ", "สาธารณูปโภค", "ค่าเช่าใหม่", "cash", "paid", 0, 0, 1, "2026-07-01", "confirmed");
// Vendor A even newer but DRAFT → must be ignored.
ins.run("บ.เอ", "เบ็ดเตล็ด", "ดราฟต์", "cash", "paid", 0, 0, 0, "2026-07-20", "draft");
// Vendor B: single confirmed.
ins.run("บ.บี", "สินค้า/เวชภัณฑ์", "ของสด", "cash", "paid", 0, 0, 0, "2026-06-10", "confirmed");

const rows = db.prepare(
  `SELECT vendor_name, category, description, payment_method, payment_status,
          has_tax_invoice, wht_rate, is_fixed
     FROM accounta_expenses
    WHERE branch_id = 1 AND vendor_name IS NOT NULL AND review_status = 'confirmed'
    ORDER BY bill_date DESC, id DESC`
).all() as Array<Record<string, unknown>>;
const map: Record<string, Record<string, unknown>> = {};
for (const r of rows) { const { vendor_name, ...rest } = r; if (!((vendor_name as string) in map)) map[vendor_name as string] = rest; }

const a = map["บ.เอ"];
assert(a.description === "ค่าเช่าใหม่", "vendor A → newest confirmed bill wins (not the older, not the draft)");
assert(a.category === "สาธารณูปโภค" && a.payment_status === "paid" && a.has_tax_invoice === 0,
  "vendor A snapshot carries category/status/vat of the newest confirmed");
const b = map["บ.บี"];
assert(b.description === "ของสด" && b.category === "สินค้า/เวชภัณฑ์", "vendor B → its single confirmed bill");
assert(Object.keys(map).length === 2, "only vendors with a confirmed bill are mapped");

console.log("\nALL VENDOR-LASTBILL FIXTURES PASSED");
