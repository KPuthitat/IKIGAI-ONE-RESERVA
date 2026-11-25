// Move ACCOUNTA bills / income to another branch. Run: node --import tsx scripts/test-accounta-move.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-accounta-move.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/accounta-move");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  const co1 = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ก')").run().lastInsertRowid), co2 = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ข')").run().lastInsertRowid);
  const brA = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('a','สาขา A',?)").run(co1).lastInsertRowid), brB = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('b','สาขา B',?)").run(co2).lastInsertRowid);
  const brC = Number(db.prepare("INSERT INTO branches (slug,name,company_id,status) VALUES ('c','สาขา C',?, 'closed')").run(co2).lastInsertRowid);
  const mk = (u: string, role: string) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?,?, 'active')").run(u, "x", u, role).lastInsertRowid);
  const owner = mk("owner", "super_admin"), bk = mk("bookkeeper", "admin"), bkAB = mk("bk-ab", "admin");
  db.prepare("INSERT INTO accounta_access (user_id, branch_id, can_confirm, granted_by) VALUES (?,?,1,?)").run(bk, brA, owner);
  db.prepare("INSERT INTO accounta_access (user_id, branch_id, can_confirm, granted_by) VALUES (?,?,1,?)").run(bkAB, brA, owner);
  db.prepare("INSERT INTO accounta_access (user_id, branch_id, can_confirm, granted_by) VALUES (?,?,1,?)").run(bkAB, brB, owner);
  const exp = (branch: number, co: number, amt: number) => Number(db.prepare("INSERT INTO accounta_expenses (branch_id, company_id, bill_date, vendor_name, amount_total, base_amount, review_status) VALUES (?,?, '2026-11-10', 'ผู้ขาย', ?, ?, 'confirmed')").run(branch, co, amt, amt).lastInsertRowid);
  const inc = (branch: number, co: number, amt: number, source = "manual") => Number(db.prepare("INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, source) VALUES (?,?, '2026-11-10', 'เงินสด', ?, ?)").run(branch, co, amt, source).lastInsertRowid);
  const O = { id: owner, role: "super_admin" }, BK = { id: bk, role: "admin" }, BKAB = { id: bkAB, role: "admin" };
  const e1 = exp(brA, co1, 100), e2 = exp(brA, co1, 250), e3 = exp(brA, co1, 80), i1 = inc(brA, co1, 900), iSys = inc(brA, co1, 5000, "shift_close"), iRev = inc(brA, co1, 70, "revshare"), iClinic = inc(brA, co1, 60, "clinic");
  const row = (t: string, id: number) => db.prepare(`SELECT branch_id, company_id, ${t === "accounta_expenses" ? "amount_total, bill_date" : "amount, income_date"} FROM ${t} WHERE id = ?`).get(id) as Record<string, number | string>;

  ok("without access to the target branch nothing moves", err(() => M.moveRows(BK, "expense", [e1], brB, null)) === "no_access" && row("accounta_expenses", e1).branch_id === brA);
  ok("a closed or unknown target is refused", err(() => M.moveRows(O, "expense", [e1], brC, null)) === "no_target" && err(() => M.moveRows(O, "expense", [e1], 9999, null)) === "no_target");
  ok("nothing selected is refused", err(() => M.moveRows(O, "expense", [], brB, null)) === "nothing" || err(() => M.moveRows(O, "expense", [-1], brB, null)) === "nothing");

  const r1 = M.moveRows(BKAB, "expense", [e1, e2, 99999, e1], brB, "ลงผิดสาขา");
  ok("several bills move at once; a missing id is reported; a repeated id counts once", r1.filter((r) => r.status === "moved").length === 2 && r1.some((r) => r.id === 99999 && r.status === "not_found") && r1.length === 3);
  ok("the bill is now on the new branch and the company follows the branch", row("accounta_expenses", e1).branch_id === brB && row("accounta_expenses", e1).company_id === co2 && row("accounta_expenses", e3).branch_id === brA);
  ok("amount and date are untouched", row("accounta_expenses", e1).amount_total === 100 && row("accounta_expenses", e1).bill_date === "2026-11-10");
  ok("every move is kept: who, from, to, why", (() => { const l = M.listMoves(O, 10); return l.length === 2 && l[0].to_name === "สาขา B" && l[0].from_name === "สาขา A" && l[0].reason === "ลงผิดสาขา" && l[0].by_name === "bk-ab"; })());
  ok("moving to the branch it is already on changes nothing", M.moveRows(BKAB, "expense", [e1], brB, null)[0].status === "same_branch" && M.listMoves(O, 10).length === 2);
  const back = M.moveRows(BKAB, "expense", [e1], brA, "ย้ายกลับ");
  ok("it can be moved back (that is the undo) and the company returns", back[0].status === "moved" && row("accounta_expenses", e1).branch_id === brA && row("accounta_expenses", e1).company_id === co1);
  const onlyB = mk("only-b2", "admin"); db.prepare("INSERT INTO accounta_access (user_id, branch_id, can_confirm, granted_by) VALUES (?,?,1,?)").run(onlyB, brB, owner);
  const blockedSrc = M.moveRows({ id: onlyB, role: "admin" }, "expense", [e3], brB, null);
  ok("…the row is blocked with a reason, not moved", blockedSrc[0].status === "blocked" && /สาขาต้นทาง/.test(blockedSrc[0].reason!) && row("accounta_expenses", e3).branch_id === brA);

  const ri = M.moveRows(O, "income", [i1, iSys, iRev, iClinic], brB, null);
  ok("manual income moves; system-owned income is refused with the reason", ri.find((r) => r.id === i1)!.status === "moved" && row("accounta_income", i1).branch_id === brB && row("accounta_income", i1).company_id === co2
    && [iSys, iRev, iClinic].every((id) => ri.find((r) => r.id === id)!.status === "blocked" && row("accounta_income", id).branch_id === brA) && /ยอดขายรายวัน/.test(ri.find((r) => r.id === iSys)!.reason!));

  // a bill tied to a purchase order cannot be moved away from it
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO purchase_order_bills (po_id, expense_id) VALUES (1, ?)").run(e3);
  db.pragma("foreign_keys = ON");
  const rp = M.moveRows(O, "expense", [e3], brB, null);
  ok("a bill linked to a purchase order is refused until it is unlinked", rp[0].status === "blocked" && /ใบสั่งซื้อ/.test(rp[0].reason!) && row("accounta_expenses", e3).branch_id === brA);

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll accounta move tests passed");
})();
