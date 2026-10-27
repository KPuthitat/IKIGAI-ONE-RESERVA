// npx tsx scripts/test-purchasing.ts — OPEX/CAPEX budgets + PR → approval → PO → receive → bills (owner 2026-10-27)
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-purchasing.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); process.env.DATABASE_PATH = TMP;
let failed = 0;
const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
(async () => {
  const { getDb } = await import("../src/lib/db");
  const P = await import("../src/lib/purchasing");
  const { CAPEX_CATEGORY_NAME } = await import("../src/lib/accounta");
  const db = getDb();
  const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof P.PurchasingError ? e.code : `other:${(e as Error).message}`; } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บ')").run().lastInsertRowid);
  const nama = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('nama','NAMA',?)").run(co).lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('hypo','HYPO',?)").run(co).lastInsertRowid);
  const mk = (u: string, role: string, extra: { c?: number; line?: string | null } = {}) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,line_user_id) VALUES (?,?,?,?,'active',?,?)")
    .run(u, "x", u, role, extra.c ?? 0, extra.line === undefined ? `U-${u}` : extra.line).lastInsertRowid);
  const owner = mk("owner", "super_admin"), mgr = mk("mgr", "admin"), ceo = mk("ceo", "admin", { c: 1 }), other = mk("other", "admin");
  const v = (id: number, role: "admin" | "super_admin", adminBranchIds: number[]) => P.viewerOf({ id, role, adminBranchIds });
  const vMgr = v(mgr, "admin", [nama]), vCeo = v(ceo, "admin", [hypo]), vOwner = v(owner, "super_admin", []), vOther = v(other, "admin", [hypo]);

  const cats = (db.prepare("SELECT name FROM accounta_categories WHERE active = 1 AND name != ?").all(CAPEX_CATEGORY_NAME) as Array<{ name: string }>).map((c) => c.name);
  const opex = cats[0];
  ok("the CapEx category exists and is classified capex; others opex", !!db.prepare("SELECT 1 FROM accounta_categories WHERE name = ?").get(CAPEX_CATEGORY_NAME) && P.kindOfCategory(CAPEX_CATEGORY_NAME) === "capex" && P.kindOfCategory(opex) === "opex");

  // budget
  ok("only an approver sets a budget", P.isApprover(vCeo) && !P.isApprover(vMgr) && code(() => P.setBudget({ year: 2026, branchId: nama, category: opex, amount: 10000, viewer: vMgr })) === "forbidden");
  P.setBudget({ year: 2026, branchId: nama, category: opex, amount: 10000, viewer: vCeo });
  P.setBudget({ year: 2026, branchId: nama, category: CAPEX_CATEGORY_NAME, amount: 50000, viewer: vOwner });
  ok("budgets are stored per branch and category with the derived kind", P.usageOf(2026, nama, opex).budget === 10000 && P.usageOf(2026, nama, CAPEX_CATEGORY_NAME).kind === "capex" && P.usageOf(2026, hypo, opex).budget === 0);
  ok("a bad category or a negative amount is refused", code(() => P.setBudget({ year: 2026, branchId: nama, category: "ไม่มี", amount: 1, viewer: vCeo })) === "invalid_category" && code(() => P.setBudget({ year: 2026, branchId: nama, category: opex, amount: -1, viewer: vCeo })) === "invalid_amount");

  // PR create / edit
  const items = [{ description: "เก้าอี้", qty: 2, unit: "ตัว", unit_price: 1500 }, { description: "โต๊ะ", qty: 1, unit_price: 2000 }];
  const input = { branchId: nama, category: opex, title: "เฟอร์นิเจอร์", neededDate: "2026-11-15", vatRate: 7, items };
  ok("only a branch admin (or approver) can open a PR for the branch", code(() => P.createPr({ ...input, branchId: hypo }, vMgr)) === "forbidden");
  const pr = P.createPr(input, vMgr);
  let row = P.getPr(pr)!;
  ok("totals are computed: subtotal 5000, VAT 7% = 350, total 5350; numbered PR-YYYY-0001, draft", row.subtotal === 5000 && row.vatAmount === 350 && row.total === 5350 && /^PR-\d{4}-0001$/.test(row.prNo) && row.status === "draft");
  ok("a PR needs valid items", code(() => P.createPr({ ...input, items: [] }, vMgr)) === "no_items" && code(() => P.createPr({ ...input, items: [{ description: "", qty: 1, unit_price: 1 }] }, vMgr)) === "invalid_item");
  P.updatePr(pr, { ...input, items: [{ description: "เก้าอี้", qty: 2, unit_price: 1500 }] }, vMgr);
  ok("a draft can be edited", P.getPr(pr)!.total === 3210 && P.listItems(pr).length === 1);

  // submit: within budget → committed
  P.updatePr(pr, input, vMgr);
  P.submitPr(pr, vMgr);
  ok("a PR within budget is submitted and counts as committed", P.getPr(pr)!.status === "submitted" && !P.getPr(pr)!.overBudget && P.usageOf(2026, nama, opex).committed === 5350 && P.usageOf(2026, nama, opex).remaining === 4650);
  ok("a draft cannot be edited after submitting", code(() => P.updatePr(pr, input, vMgr)) === "bad_status");

  // over budget
  const pr2 = P.createPr({ ...input, title: "ตู้เย็น", items: [{ description: "ตู้เย็น", qty: 1, unit_price: 9000 }] }, vMgr);
  ok("an over-budget PR cannot be submitted without a reason", code(() => P.submitPr(pr2, vMgr)) === "over_budget_reason_required");
  P.updatePr(pr2, { ...input, title: "ตู้เย็น", items: [{ description: "ตู้เย็น", qty: 1, unit_price: 9000 }], overBudgetReason: "ตู้เดิมพัง" }, vMgr);
  P.submitPr(pr2, vMgr);
  ok("…with a reason it is submitted and flagged over budget", P.getPr(pr2)!.overBudget === true && P.usageOf(2026, nama, opex).remaining < 0);
  ok("a category without any budget counts as over budget", P.budgetImpact(P.getPr(P.createPr({ ...input, category: cats[1], items: [{ description: "x", qty: 1, unit_price: 10 }] }, vMgr))!).over === true);

  // approval
  ok("a requester or a plain admin cannot approve", code(() => P.decidePr(pr, true, "", vMgr)) === "forbidden" && code(() => P.decidePr(pr, true, "", vOther)) === "forbidden");
  ok("rejecting needs a reason", code(() => P.decidePr(pr2, false, " ", vCeo)) === "reject_note_required");
  P.decidePr(pr2, false, "เกินงบ รอปีหน้า", vCeo);
  ok("a rejected PR stops counting as committed", P.getPr(pr2)!.status === "rejected" && P.usageOf(2026, nama, opex).committed === 5350);
  const own = P.createPr({ ...input, branchId: hypo, items: [{ description: "x", qty: 1, unit_price: 10 }] }, vCeo);
  P.updatePr(own, { ...input, branchId: hypo, overBudgetReason: "ไม่มีงบ", items: [{ description: "x", qty: 1, unit_price: 10 }] }, vCeo);
  P.submitPr(own, vCeo);
  ok("an approver cannot approve their own PR, super_admin can", code(() => P.decidePr(own, true, "", vCeo)) === "own_request" && P.decidePr(own, true, "", vOwner).status === "approved");
  P.reopenPr(pr2, vMgr);
  ok("a rejected PR can be reopened as a draft", P.getPr(pr2)!.status === "draft");
  P.cancelPr(pr2, vMgr);
  ok("a PR can be cancelled before ordering", P.getPr(pr2)!.status === "cancelled");
  const appr = P.decidePr(pr, true, "ok", vCeo);
  ok("the C-level approves; the decision is recorded", appr.status === "approved" && appr.decidedBy === ceo && appr.decisionNote === "ok");

  // PO
  ok("only an approved PR gets a PO, by a branch admin", code(() => P.issuePo(pr2, {}, vMgr)) === "bad_status" && code(() => P.issuePo(pr, { vendorName: "x" }, vOther)) === "forbidden");
  ok("a PO needs a vendor", code(() => P.issuePo(pr, {}, vMgr)) === "invalid_vendor");
  const po = P.issuePo(pr, { vendorName: "ร้านเฟอร์", expectedDate: "2026-11-20" }, vMgr);
  ok("the PO copies the PR total, is numbered PO-YYYY-0001 and the PR is ordered", po.total === 5350 && /^PO-\d{4}-0001$/.test(po.poNo) && P.getPr(pr)!.status === "ordered" && P.getPr(pr)!.poNo === po.poNo);
  ok("an ordered PR still counts as committed", P.usageOf(2026, nama, opex).committed === 5350);

  // receive + bills
  const bill = (amt: number, extra: { branch?: number; status?: string; cat?: string } = {}) => Number(db.prepare("INSERT INTO accounta_expenses (branch_id, bill_date, category, amount_total, review_status) VALUES (?, '2026-11-18', ?, ?, ?)")
    .run(extra.branch ?? nama, extra.cat ?? opex, amt, extra.status ?? "confirmed").lastInsertRowid);
  const b1 = bill(5350), bDraft = bill(10, { status: "draft" }), bOther = bill(10, { branch: hypo });
  ok("only confirmed bills of the same branch can be linked", code(() => P.linkBills(pr, [bDraft], vMgr)) === "bill_invalid" && code(() => P.linkBills(pr, [bOther], vMgr)) === "bill_invalid");
  ok("linkable bills lists the same branch/category bill", P.listLinkableBills(pr).map((b) => b.expenseId).join() === String(b1));
  P.receivePo(pr, "ครบ", vMgr);
  ok("receiving moves it to received (still committed until a bill is linked)", P.getPr(pr)!.status === "received" && P.usageOf(2026, nama, opex).committed === 5350);
  P.linkBills(pr, [b1], vMgr);
  const u = P.usageOf(2026, nama, opex);
  ok("linking the bill closes the PR; the bill is now the actual spend and nothing is counted twice", P.getPr(pr)!.status === "closed" && u.committed === 0 && u.actual === 5350 && u.remaining === 4650);
  ok("a bill belongs to one PO only", code(() => P.linkBills(own, [b1], vOwner)) === "bad_status" && P.listLinkedBills(pr).length === 1 && P.listLinkableBills(pr).length === 0);
  P.unlinkBill(pr, b1, vMgr);
  ok("unlinking the only bill reopens it as received and the commitment returns", P.getPr(pr)!.status === "received" && P.usageOf(2026, nama, opex).committed === 5350);

  ok("the list is branch-scoped and filterable by status", P.listPrs({ branchIds: [nama], year: 2026 }).length === 3 && P.listPrs({ branchIds: [hypo] }).length === 1 && P.listPrs({ branchIds: [nama], status: ["received"] }).length === 1);
  ok("approver recipients are the C-level and super_admin with a LINE id", P.approverRecipients().map((r) => r.userId).sort().join() === [owner, ceo].sort().join());
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
