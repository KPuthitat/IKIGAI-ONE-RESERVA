// Fixture: purchase credit note (ใบลดหนี้ฝั่งซื้อ, owner 2026-08-23). A credit
// note is stored as a NEGATIVE accounta_expenses row (doc_type='credit_note')
// so it reduces expense + input VAT (ภาษีซื้อ) through the existing SUMs, and
// therefore RAISES ภพ.30 payable. Validates:
//   1. toCreditNoteInput negates amount/vat/base + derives the 7% split.
//   2. A negative row reduces SUM(amount_total) and SUM(vat_amount).
//   3. ภพ.30 (output − input) rises by exactly the credited input VAT.
// Run:  node --import tsx scripts/verify-credit-note.ts
import Database from "better-sqlite3";
import { toCreditNoteInput } from "../src/lib/accounta-validate";
import { round2 } from "../src/lib/accounta";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

// ── 1. toCreditNoteInput: negation + VAT split ──────────────────────
// ลดยอดรวม 107 มีใบกำกับ → base -100, vat -7, total -107.
const cn1 = toCreditNoteInput({
  credit_date: "2026-08-10", amount_total: 107, has_tax_invoice: true
} as never);
assert(cn1.amount_total === -107, `credit total negated: ${cn1.amount_total} (want -107)`);
assert(cn1.vat_amount === -7, `credit input VAT negated: ${cn1.vat_amount} (want -7)`);
assert(cn1.base_amount === -100, `credit base negated: ${cn1.base_amount} (want -100)`);
assert(cn1.doc_type === "credit_note", `doc_type = credit_note`);
assert(cn1.payment_status === "paid", `credit note settled (not a payable)`);

// ไม่มีใบกำกับ → ลดเฉพาะยอด ไม่ลดภาษีซื้อ.
const cn2 = toCreditNoteInput({
  credit_date: "2026-08-10", amount_total: 500, has_tax_invoice: false
} as never);
assert(cn2.amount_total === -500 && cn2.vat_amount === 0 && cn2.base_amount === -500,
  `no-tax-invoice credit: total -500, vat 0, base -500 (got ${cn2.amount_total}/${cn2.vat_amount}/${cn2.base_amount})`);

// override VAT.
const cn3 = toCreditNoteInput({
  credit_date: "2026-08-10", amount_total: 1000, has_tax_invoice: true, vat_amount: 65.42
} as never);
assert(cn3.vat_amount === -65.42 && cn3.base_amount === round2(-(1000 - 65.42)),
  `vat override negated: ${cn3.vat_amount}/${cn3.base_amount}`);

// ── 2 & 3. Aggregation: negative row reduces expense + input VAT ─────
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE accounta_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT, branch_id INTEGER,
    bill_date TEXT, category TEXT, doc_type TEXT,
    amount_total REAL NOT NULL DEFAULT 0, vat_amount REAL NOT NULL DEFAULT 0,
    review_status TEXT NOT NULL DEFAULT 'confirmed'
  );
`);
const ins = db.prepare(
  "INSERT INTO accounta_expenses (branch_id, bill_date, category, doc_type, amount_total, vat_amount) VALUES (?,?,?,?,?,?)"
);
// A confirmed purchase bill: 10,700 incl VAT 700.
ins.run(1, "2026-08-05", "สินค้า/เวชภัณฑ์", "tax_invoice", 10700, 700);
const sumRow = () => db.prepare(
  "SELECT COALESCE(SUM(amount_total),0) AS exp, COALESCE(SUM(vat_amount),0) AS vat FROM accounta_expenses WHERE review_status='confirmed' AND substr(bill_date,1,7)='2026-08'"
).get() as { exp: number; vat: number };

const before = sumRow();
assert(before.exp === 10700 && before.vat === 700, `before: expense 10700, input VAT 700`);

// Record the credit note (negated) → reduces both.
ins.run(1, cn1.bill_date, "สินค้า/เวชภัณฑ์", cn1.doc_type, cn1.amount_total, cn1.vat_amount);
const after = sumRow();
assert(after.exp === 10593, `expense reduced by credit: ${after.exp} (want 10700-107=10593)`);
assert(after.vat === 693, `input VAT reduced by credit: ${after.vat} (want 700-7=693)`);

// ภพ.30 = output VAT − input VAT. Less input credit ⇒ MORE payable.
const outputVat = 800; // hypothetical ภาษีขาย for the month
const vatBefore = round2(outputVat - before.vat); // 800 - 700 = 100
const vatAfter = round2(outputVat - after.vat);    // 800 - 693 = 107
assert(vatAfter === 107 && round2(vatAfter - vatBefore) === 7,
  `ภพ.30 rises by the credited input VAT: ${vatBefore} → ${vatAfter} (+7)`);

console.log("\nALL CREDIT-NOTE FIXTURES PASSED");
