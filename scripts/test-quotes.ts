// Quotation comparison. Run: node --import tsx scripts/test-quotes.ts
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const TMP = path.join(process.cwd(), "data", "test-quotes.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/memos");
  const P = await import("../src/lib/purchasing");
  const Q = await import("../src/lib/quotes");
  const S = await import("../src/lib/quotes-score");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof Error && "code" in e ? String((e as { code: string }).code) : e instanceof Error ? e.message : String(e); } };

  const b1 = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b1','NAMA')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,pin_hash) VALUES (?,?,?,?, 'active', ?, ?)").run(u, "x", u, role, c, bcrypt.hashSync("1234", 4)).lastInsertRowid);
  const author = mk("author", "admin"), other = mk("other", "admin"), e1 = mk("exec1", "admin", 1);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(author, b1);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(other, b1);
  const V = P.viewerOf({ id: author, role: "admin", adminBranchIds: [b1] }), VO = P.viewerOf({ id: other, role: "admin", adminBranchIds: [] }), VE = P.viewerOf({ id: e1, role: "admin", adminBranchIds: [] });
  db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (NULL, NULL, 'one_exec', 1)").run();
  if (!db.prepare("SELECT 1 FROM accounta_categories LIMIT 1").get()) db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run();
  const category = (db.prepare("SELECT name FROM accounta_categories LIMIT 1").get() as { name: string }).name;
  const sup = Number(db.prepare("INSERT INTO inventa_suppliers (branch_id, name, active) VALUES (?, 'ซัพพลายเออร์ A', 1)").run(b1).lastInsertRowid);
  M.saveSignature(e1, "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");

  ok("the score is the weighted mix of price and other benefits", S.combinedScore(80, 40, 60) === 64 && S.combinedScore(80, 40, 100) === 80 && S.combinedScore(80, 40, 0) === 40 && S.clampPct(150) === 100);

  const id = M.createMemo({ branchId: b1, subject: "ขอซื้อเครื่องตรวจ", category, items: [{ description: "เครื่องตรวจ", qty: 1, unit: "เครื่อง", unit_price: 10000 }], signerIds: [e1] }, V);
  ok("a purchase memo cannot be sent without a comparison", code(() => M.submitMemo(id, V)) === "compare_required");
  ok("only the author edits quotes, only while the memo is a draft", code(() => Q.saveQuote("memo", id, { vendorName: "X", amount: 1, priceScore: 50, benefitScore: 50 }, VO)) === "forbidden");

  ok("sole source needs a real reason", (() => { Q.setSoleSource("memo", id, true, "สั้นไป", V); return Q.getCompare("memo", id).ready.ok === false; })());
  Q.setSoleSource("memo", id, true, "เป็นเครื่องเดียวที่ได้รับรองจาก อย.ในประเทศ", V);
  ok("sole source with a reason passes", Q.getCompare("memo", id).ready.ok && Q.compareProblems("memo", id).length === 0);

  const qa = Q.saveQuote("memo", id, { vendorId: sup, amount: 10500, quoteNo: "A-1", priceScore: 60, priceReason: "ถูกกว่าเล็กน้อย", benefitScore: 90, benefitReason: "รับประกัน 3 ปี ซ่อมถึงที่" }, V);
  ok("adding a rival quote switches sole source off; one quote alone is not a comparison", !Q.getCompare("memo", id).soleSource && Q.getCompare("memo", id).ready.problems.some((p) => p.includes("2 ราย")));
  ok("the same vendor cannot be quoted twice", code(() => Q.saveQuote("memo", id, { vendorName: "ซัพพลายเออร์ A", amount: 1, priceScore: 50, benefitScore: 50 }, V)) === "duplicate_vendor");
  const qb = Q.saveQuote("memo", id, { vendorName: "บริษัท B", amount: 9800, priceScore: 90, priceReason: "ถูกสุด", benefitScore: 40, benefitReason: "" }, V);
  let c = Q.getCompare("memo", id);
  ok("every quote needs reasons for both sides, and a winner must be chosen", c.ready.problems.some((p) => p.includes("บริษัท B") && p.includes("เหตุผล")) && c.ready.problems.some((p) => p.includes("ยังไม่ได้เลือก")));
  Q.saveQuote("memo", id, { id: qb, vendorName: "บริษัท B", amount: 9800, priceScore: 90, priceReason: "ถูกสุด", benefitScore: 40, benefitReason: "ไม่มีรับประกันในไทย" }, V);
  ok("scores stay within 0–100", code(() => Q.saveQuote("memo", id, { vendorName: "C", amount: 1, priceScore: 120, benefitScore: 50 }, V)) !== "");
  ok("choosing needs a reason", code(() => Q.chooseQuote("memo", id, qa, 40, " ", V)) === "invalid");
  Q.chooseQuote("memo", id, qa, 40, "ให้น้ำหนักประโยชน์มากกว่า: รับประกันและบริการหลังขาย", V);
  c = Q.getCompare("memo", id);
  ok("the choice keeps the weight in force and sets the memo's vendor", c.ready.ok && c.chosenQuoteId === qa && c.weightPrice === 40 && (db.prepare("SELECT vendor_name FROM memos WHERE id = ?").get(id) as { vendor_name: string }).vendor_name === "ซัพพลายเออร์ A");
  ok("with weight 40 % price: A scores 78 vs B 62 — A wins; with 80 % price B would", S.combinedScore(60, 90, 40) === 78 && S.combinedScore(90, 40, 40) === 60 && S.combinedScore(90, 40, 80) > S.combinedScore(60, 90, 80));

  M.submitMemo(id, V);
  ok("memo sent; quotes are frozen while it is pending", code(() => Q.saveQuote("memo", id, { id: qa, vendorName: "ซัพพลายเออร์ A", amount: 1, priceScore: 50, benefitScore: 50 }, V)) === "bad_status" && !Q.permsFor("memo", id, V).edit);
  M.signMemo(id, e1, "1234");
  const o = M.openPrFromMemo(id, V, "งบ");
  const pc = Q.getCompare("pr", o.prId);
  ok("the PR opened from the memo inherits the comparison (a copy, chosen quote remapped)", pc.quotes.length === 2 && pc.ready.ok && pc.chosenQuoteId != null && pc.quotes.find((q) => q.id === pc.chosenQuoteId)?.vendorName === "ซัพพลายเออร์ A" && Q.getCompare("memo", id).quotes.length === 2);
  ok("an executive may re-choose on a sent PR until the first approval; others may not", Q.permsFor("pr", o.prId, VE).choose && !Q.permsFor("pr", o.prId, VO).choose && !Q.permsFor("pr", o.prId, VE).edit);
  const qb2 = pc.quotes.find((q) => q.vendorName === "บริษัท B")!.id;
  Q.chooseQuote("pr", o.prId, qb2, 80, "ราคาต่ำกว่ามาก ผู้บริหารเห็นว่าคุ้มกว่า", VE);
  ok("the re-choice is recorded and the PR vendor follows", Q.getCompare("pr", o.prId).chosenQuoteId === qb2 && P.getPr(o.prId)!.vendorName === "บริษัท B");
  P.decidePr(o.prId, true, "", VE);
  ok("after an approval the choice is locked", !Q.permsFor("pr", o.prId, VE).choose);

  // a PR opened directly has to carry its own comparison
  const direct = P.createPr({ branchId: b1, category, title: "ซื้อหมึก", vendorName: "ร้าน A", overBudgetReason: "งบ", items: [{ description: "หมึก", qty: 1, unit_price: 500 }] }, V);
  ok("a direct PR cannot be sent without quotes", code(() => P.submitPr(direct, V)) === "compare_required");
  Q.setSoleSource("pr", direct, true, "อะไหล่แท้ของเครื่องรุ่นนี้ มีตัวแทนเดียว", V);
  ok("…but can with a sole-source reason", P.submitPr(direct, V).status === "submitted");

  // funding memos and the switch
  const acct = (n: string) => Number(db.prepare("INSERT INTO accounta_cash_accounts (name, type, active) VALUES (?, 'bank', 1)").run(n).lastInsertRowid);
  const fid = M.createMemo({ kind: "funding", branchId: b1, subject: "ขอเบิกเงิน", category: "", fromAccountId: acct("SCB"), toAccountId: acct("KBANK"), amount: 20000, items: [], signerIds: [e1] }, V);
  ok("funding requests need no comparison", Q.compareProblems("memo", fid).length === 0 && M.submitMemo(fid, V).status === "pending");
  const id3 = M.createMemo({ branchId: b1, subject: "อีกใบ", category, items: [{ description: "x", qty: 1, unit_price: 1 }], signerIds: [e1] }, V);
  Q.setQuotesRequired(false, e1);
  ok("the owner can switch the rule off", M.submitMemo(id3, V).status === "pending" && !Q.quotesRequired());
  Q.setQuotesRequired(true, e1);
  ok("…and on again", Q.quotesRequired());

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall quote comparison checks passed");
})();
