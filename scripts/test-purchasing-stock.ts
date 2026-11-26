// Purchasing ↔ INVENTA: low stock → memo → PR → PO → receive adds stock once. Run: node --import tsx scripts/test-purchasing-stock.ts
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const TMP = path.join(process.cwd(), "data", "test-purchasing-stock.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/memos");
  const P = await import("../src/lib/purchasing");
  const S = await import("../src/lib/inventa-stock");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof Error && "code" in e ? String((e as { code: string }).code) : e instanceof Error ? e.message : String(e); } };

  const b1 = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b1','NAMA')").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b2','HYPO')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,pin_hash) VALUES (?,?,?,?, 'active', ?, ?)").run(u, "x", u, role, c, bcrypt.hashSync("1234", 4)).lastInsertRowid);
  const author = mk("author", "admin"), e1 = mk("exec1", "admin", 1);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(author, b1);
  const V = P.viewerOf({ id: author, role: "admin", adminBranchIds: [b1] });
  const VE = P.viewerOf({ id: e1, role: "admin", adminBranchIds: [] });
  db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (NULL, NULL, 'one_exec', 1)").run();
  if (!db.prepare("SELECT 1 FROM accounta_categories LIMIT 1").get()) db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run();
  const category = (db.prepare("SELECT name FROM accounta_categories LIMIT 1").get() as { name: string }).name;
  const sup = Number(db.prepare("INSERT INTO inventa_suppliers (branch_id, name, active) VALUES (?, 'ซัพพลายเออร์ A', 1)").run(b1).lastInsertRowid);
  const item = (branch: number, name: string, qty: number, safety: number, extra = "") => Number(db.prepare(`INSERT INTO inventa_items (branch_id, name, unit, unit_cost, current_qty, safety_stock, supplier_id, active ${extra ? ", count_mode" : ""}) VALUES (?, ?, 'กล่อง', 20, ?, ?, ?, 1 ${extra ? ", 'fractional'" : ""})`).run(branch, name, qty, safety, sup).lastInsertRowid);
  const low = item(b1, "พาราเซตามอล", 10, 50), fine = item(b1, "ผ้าก๊อซ", 80, 50), frac = item(b1, "น้ำเกลือ", 0, 50, "fractional"), other = item(b2, "ของอีกสาขา", 1, 50);

  const li = S.lowStockItems(b1);
  ok("low stock = active items of the branch under safety stock, fractional and other branches left out", li.length === 1 && li[0].itemId === low && li[0].suggestQty === 40 && li[0].unitCost === 20 && li[0].supplierId === sup);

  const input = (items: Array<{ description: string; qty: number; unit: string; unit_price: number; inventa_item_id?: number | null }>) => ({ branchId: b1, subject: "ขอซื้อของเข้าคลัง", body: "", category, vendorId: sup, items, signerIds: [e1] });
  ok("a memo line can only point at a stock item of the memo's branch", code(() => M.createMemo(input([{ description: "x", qty: 1, unit: "กล่อง", unit_price: 1, inventa_item_id: other }]), V)) === "invalid");
  const id = M.createMemo(input([{ description: "พาราเซตามอล", qty: 40, unit: "กล่อง", unit_price: 20, inventa_item_id: low }, { description: "ค่าขนส่ง", qty: 1, unit: "ครั้ง", unit_price: 100 }]), V);
  ok("the stock link is kept on the memo", M.getMemoDetail(id).items[0].inventaItemId === low && M.getMemoDetail(id).items[1].inventaItemId === null);
  M.submitMemo(id, V);
  M.saveSignature(e1, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
  M.signMemo(id, e1, "1234");
  const o = M.openPrFromMemo(id, V, "ยังไม่ได้ตั้งงบ");
  ok("the PR opened from the memo keeps the stock link", P.listItems(o.prId).filter((i) => i.inventaItemId === low).length === 1);
  P.decidePr(o.prId, true, "", VE);
  P.issuePo(o.prId, {}, V);
  const before = (db.prepare("SELECT current_qty FROM inventa_items WHERE id = ?").get(low) as { current_qty: number }).current_qty;
  ok("nothing reaches the stock before the goods arrive", before === 10);
  const rc = P.receivePo(o.prId, "ครบ", V);
  const q = (i: number) => (db.prepare("SELECT current_qty FROM inventa_items WHERE id = ?").get(i) as { current_qty: number }).current_qty;
  ok("receiving the PO adds the ordered quantity to the linked item only", rc.stockLines === 1 && q(low) === 50 && q(fine) === 80 && q(other) === 1);
  ok("the PO is stamped so the stock cannot be added twice", !!P.getPo(o.prId)?.stockAppliedAt && code(() => P.receivePo(o.prId, "", V)) === "bad_status" && q(low) === 50);
  ok("after the top-up the item is no longer low", S.lowStockItems(b1).length === 0);

  // a line pointing at another branch's item (e.g. edited by hand) never touches that stock
  const id2 = M.createMemo(input([{ description: "x", qty: 5, unit: "กล่อง", unit_price: 1, inventa_item_id: low }]), V);
  M.submitMemo(id2, V); M.signMemo(id2, e1, "1234");
  const o2 = M.openPrFromMemo(id2, V, "งบ");
  db.prepare("UPDATE purchase_request_items SET inventa_item_id = ? WHERE pr_id = ?").run(other, o2.prId);
  P.decidePr(o2.prId, true, "", VE); P.issuePo(o2.prId, {}, V);
  ok("a PR line pointing at another branch's stock is ignored on receipt", P.receivePo(o2.prId, "", V).stockLines === 0 && q(other) === 1);

  // editing a draft PR must not drop the link
  const pr3 = P.createPr({ branchId: b1, category, title: "t", items: [{ description: "ยา", qty: 3, unit: "กล่อง", unit_price: 10, inventa_item_id: low }] }, V);
  P.updatePr(pr3, { branchId: b1, category, title: "t2", items: [{ description: "ยา", qty: 4, unit: "กล่อง", unit_price: 10, inventa_item_id: low }] }, V);
  ok("a draft PR keeps the stock link through an edit", P.listItems(pr3)[0].inventaItemId === low && P.listItems(pr3)[0].qty === 4);

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall purchasing↔stock checks passed");
})();
