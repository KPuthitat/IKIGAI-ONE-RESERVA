// INSIGNA CRM Phase 1 (owner 2026-09-24) — bill↔customer links + per-customer
// roll-up (spend/cadence/favourites/hour). Run: node --import tsx scripts/test-insigna-bills.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-insigna-bills.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { linkBill, unlinkBill, listLinkedBills, customerBillStats, findReceiptByReceiptId } = await import("../src/lib/insigna");

  // The canonical "link by scanned id" flow (mirrors the bills API route):
  // resolve the id → (the route also guards branch access here) → linkBill.
  const linkByReceiptId = (customer_hash: string, receipt_id: string) => {
    const ref = findReceiptByReceiptId(receipt_id);
    if (!ref) return { result: "receipt_not_found" as const, ref: null };
    return { result: linkBill({ customer_hash, ...ref }), ref };
  };
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const rec = db.prepare("INSERT INTO salesa_receipts (branch_id,sale_date,bill_no,hour,table_name,gross,discount,nett,payment,receipt_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const item = db.prepare("INSERT INTO salesa_receipt_items (branch_id,sale_date,bill_no,name,qty) VALUES (?,?,?,?,?)");
  rec.run(A, "2026-09-20", "1001", 12, "T1", 300, 0, 300, "cash", "823Z_4w8g");
  rec.run(A, "2026-09-20", "1002", 19, "T2", 500, 0, 500, "cash", "914A_5x9h");
  rec.run(A, "2026-09-22", "1003", 12, "T3", 400, 0, 400, "cash", "K72Q_1b3c");
  item.run(A, "2026-09-20", "1001", "กะเพรา", 2); item.run(A, "2026-09-20", "1001", "ชาเย็น", 1);
  item.run(A, "2026-09-20", "1002", "กะเพรา", 1);
  item.run(A, "2026-09-22", "1003", "ต้มยำ", 1); item.run(A, "2026-09-22", "1003", "กะเพรา", 1);

  ok("link a real receipt → 'linked'", linkBill({ customer_hash: "cust1", branch_id: A, sale_date: "2026-09-20", bill_no: "1001" }) === "linked");
  ok("link same bill to same customer → 'already_yours'", linkBill({ customer_hash: "cust1", branch_id: A, sale_date: "2026-09-20", bill_no: "1001" }) === "already_yours");
  ok("link a non-existent receipt → 'receipt_not_found'", linkBill({ customer_hash: "cust1", branch_id: A, sale_date: "2026-09-20", bill_no: "9999" }) === "receipt_not_found");
  ok("link a bill already owned by another → 'linked_to_other'", linkBill({ customer_hash: "cust2", branch_id: A, sale_date: "2026-09-20", bill_no: "1001" }) === "linked_to_other");

  linkBill({ customer_hash: "cust1", branch_id: A, sale_date: "2026-09-20", bill_no: "1002" });
  linkBill({ customer_hash: "cust1", branch_id: A, sale_date: "2026-09-22", bill_no: "1003" });

  ok("listLinkedBills newest first, 3 rows", (() => {
    const l = listLinkedBills("cust1");
    return l.length === 3 && l[0].sale_date === "2026-09-22" && l[2].sale_date === "2026-09-20";
  })());

  ok("stats: 3 bills, ฿1200 total, ฿400 avg", (() => {
    const s = customerBillStats("cust1");
    return s.billCount === 3 && s.totalNett === 1200 && s.avgNett === 400;
  })());
  ok("stats: distinctDays = 2 (frequency), first/last visit", (() => {
    const s = customerBillStats("cust1");
    return s.distinctDays === 2 && s.firstVisit === "2026-09-20" && s.lastVisit === "2026-09-22";
  })());
  ok("stats: peakHour = 12 (two lunch bills vs one dinner)", customerBillStats("cust1").peakHour === 12);
  ok("stats: favourite item = กะเพรา ×4", (() => {
    const s = customerBillStats("cust1");
    return s.topItems[0].name === "กะเพรา" && s.topItems[0].qty === 4;
  })());

  unlinkBill(A, "2026-09-20", "1001");
  ok("unlink drops the bill → 2 left, ฿900", (() => {
    const s = customerBillStats("cust1");
    return s.billCount === 2 && s.totalNett === 900 && listLinkedBills("cust1").length === 2;
  })());
  ok("after unlink the bill can be relinked to another customer", linkBill({ customer_hash: "cust2", branch_id: A, sale_date: "2026-09-20", bill_no: "1001" }) === "linked");
  ok("empty customer → zeroed stats", (() => {
    const s = customerBillStats("nobody");
    return s.billCount === 0 && s.avgNett === null && s.topItems.length === 0;
  })());

  // ── link by FeedMe's long receipt id (owner 2026-09-24) ──
  // A fresh, unlinked receipt so the by-id link path starts clean.
  rec.run(A, "2026-09-23", "1004", 13, "T4", 250, 0, 250, "cash", "FREE_9z9z");

  ok("findReceiptByReceiptId resolves the (branch,date,bill) key", (() => {
    const ref = findReceiptByReceiptId("914A_5x9h");
    return ref?.branch_id === A && ref?.sale_date === "2026-09-20" && ref?.bill_no === "1002";
  })());
  ok("findReceiptByReceiptId unknown id → null", findReceiptByReceiptId("NOPE_00000") === null);
  ok("findReceiptByReceiptId blank id → null", findReceiptByReceiptId("   ") === null);

  ok("link-by-id: unknown id → 'receipt_not_found'", (() => {
    const r = linkByReceiptId("cust3", "NOPE_00000");
    return r.result === "receipt_not_found" && r.ref === null;
  })());
  ok("link-by-id: links a real id → 'linked' + ref", (() => {
    const r = linkByReceiptId("cust3", "FREE_9z9z");
    return r.result === "linked" && r.ref?.bill_no === "1004" && listLinkedBills("cust3").length === 1;
  })());
  ok("link-by-id: same id same customer → 'already_yours'",
    linkByReceiptId("cust3", "FREE_9z9z").result === "already_yours");
  ok("link-by-id: id owned by another → 'linked_to_other'",
    linkByReceiptId("cust4", "FREE_9z9z").result === "linked_to_other");
  ok("listLinkedBills exposes receipt_id", (() => {
    const l = listLinkedBills("cust3");
    return l[0].receipt_id === "FREE_9z9z";
  })());

  // ── favourite folds renamed dishes via the branch alias map (Phase 2) ──
  const ROOT = "tabwan";
  const alias = db.prepare("INSERT INTO salesa_menu_alias (branch_id, name, root) VALUES (?,?,?)");
  alias.run(A, "ตับหวาน", ROOT);
  alias.run(A, "ตับหวานอัลตราสมูธ", ROOT);
  rec.run(A, "2026-08-01", "2001", 12, "T1", 100, 0, 100, "cash", "FOLD-1");
  rec.run(A, "2026-08-02", "2002", 12, "T2", 100, 0, 100, "cash", "FOLD-2");
  item.run(A, "2026-08-01", "2001", "ตับหวาน", 2);
  item.run(A, "2026-08-02", "2002", "ตับหวานอัลตราสมูธ", 3);
  linkBill({ customer_hash: "custfold", branch_id: A, sale_date: "2026-08-01", bill_no: "2001" });
  linkBill({ customer_hash: "custfold", branch_id: A, sale_date: "2026-08-02", bill_no: "2002" });
  ok("favourite folds two spellings of one dish into a group (qty summed)", (() => {
    const s = customerBillStats("custfold");
    return s.topItems.length === 1 && s.topItems[0].qty === 5 && s.topItems[0].name === "ตับหวาน / ตับหวานอัลตราสมูธ";
  })());
  ok("un-aliased dishes still show under their own name", (() => {
    item.run(A, "2026-08-01", "2001", "น้ำเปล่า", 1);
    const s = customerBillStats("custfold");
    return !!s.topItems.find((t) => t.name === "น้ำเปล่า" && t.qty === 1);
  })());
  ok("cross-branch: a raw spelling at a branch without the alias folds under the group label", (() => {
    const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','HYPO')").run().lastInsertRowid);
    rec.run(B, "2026-08-03", "3001", 12, "T1", 100, 0, 100, "cash", "FOLD-B1");
    item.run(B, "2026-08-03", "3001", "ตับหวาน", 4); // branch B has NO alias for this name
    linkBill({ customer_hash: "custfold", branch_id: B, sale_date: "2026-08-03", bill_no: "3001" });
    const g = customerBillStats("custfold").topItems.find((t) => t.name === "ตับหวาน / ตับหวานอัลตราสมูธ");
    return !!g && g.qty === 9; // A: 2 + 3, B: 4
  })());

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
