// Weekly funding SCB → KBANK: memo (kind funding) → signatures → transfer to make → recorded (PIN / bank statements) → warning on PRs. Run: node --import tsx scripts/test-funding.ts
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const TMP = path.join(process.cwd(), "data", "test-funding.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/memos");
  const P = await import("../src/lib/purchasing");
  const F = await import("../src/lib/funding");
  const R = await import("../src/lib/bank-recon");
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO purchasing_settings (key, value) VALUES ('quotes_required', '0')").run();   // these checks are about other rules; quote comparison has its own test
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  const br = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b','NAMA')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0, top = 0) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,is_top_exec,pin_hash) VALUES (?,?,?,?, 'active', ?, ?, ?)").run(u, "x", u, role, c, top, bcrypt.hashSync("1234", 4)).lastInsertRowid);
  const buyer = mk("buyer", "admin"), e1 = mk("e1", "admin", 1), e2 = mk("e2", "admin", 1), kb = mk("kbexec", "admin", 1), fin = mk("finance", "admin");
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(buyer, br);
  const v = (id: number) => P.viewerOf({ id, role: "admin", adminBranchIds: [br] });
  const acct = (n: string) => Number(db.prepare("INSERT INTO accounta_cash_accounts (name, type, bank_name) VALUES (?, 'bank', ?)").run(n, n).lastInsertRowid);
  const scb = acct("SCB หมุนเวียน"), kbank = acct("KBANK จัดซื้อ"), sme = acct("SME D BANK");
  const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  for (const u of [e1, e2, kb]) M.saveSignature(u, SIG);
  const fund = (signers: number[], amount = 80000, from = scb, to = kbank) => M.createMemo({ kind: "funding", branchId: br, subject: "ขอเบิกเงินรายสัปดาห์ (จัดซื้อ)", category: "", fromAccountId: from, toAccountId: to, weekStart: "2026-12-01", amount, items: [], signerIds: signers }, v(buyer));

  ok("a funding memo needs two different bank accounts and a positive amount", err(() => fund([e1, e2], 80000, scb, scb)) === "bad_account" && err(() => fund([e1, e2], 0)) === "invalid" && err(() => fund([e1, e2], 1000, 99999, kbank)) === "bad_account");
  ok("signers must satisfy the source account's rule for that amount (default: two executives or the top executive)", err(() => fund([e1])) === "signers_not_authorised" && err(() => fund([fin])) === "bad_signer" || err(() => fund([e1])) === "signers_not_authorised");
  const id = fund([e1, e2]);
  const m0 = M.getMemoDetail(id);
  ok("kind funding: total is the amount, no items, accounts and week kept", m0.kind === "funding" && m0.total === 80000 && m0.items.length === 0 && m0.fromAccountName === "SCB หมุนเวียน" && m0.toAccountName === "KBANK จัดซื้อ" && m0.weekStart === "2026-12-01");
  ok("a funding memo cannot open a PR", (M.submitMemo(id, v(buyer)), M.signMemo(id, e1, "1234"), M.signMemo(id, e2, "1234"), err(() => M.openPrFromMemo(id, v(buyer))) === "bad_status"));
  ok("approved → one transfer is waiting for finance", F.listTransfers("awaiting").length === 1 && F.listTransfers("awaiting")[0].amount === 80000 && F.countAwaiting() === 1);

  // finance records it
  const t = F.listTransfers("awaiting")[0];
  ok("recording needs the person's own PIN", err(() => F.markTransferred(t.id, { transferredOn: "2026-12-01" }, fin, "0000")) === "bad_pin" && F.countAwaiting() === 1);
  ok("bad date / amount refused", err(() => F.markTransferred(t.id, { transferredOn: "01/12/2026" }, fin, "1234")) === "invalid" && err(() => F.markTransferred(t.id, { transferredOn: "2026-12-01", actualAmount: -5 }, fin, "1234")) === "invalid");
  const done = F.markTransferred(t.id, { transferredOn: "2026-12-01", actualAmount: 75000, note: "โอนน้อยกว่าที่ขอ" }, fin, "1234");
  ok("recorded with the amount actually sent (75,000 of 80,000); cannot be recorded twice", done.status === "transferred" && done.actualAmount === 75000 && err(() => F.markTransferred(t.id, { transferredOn: "2026-12-02" }, fin, "1234")) === "bad_status");

  // PR warning
  const pr = (total: number) => { const x = P.createPr({ branchId: br, category: (db.prepare("SELECT name FROM accounta_categories WHERE active = 1 LIMIT 1").get() as { name: string } | undefined)?.name ?? (db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run(), "วัตถุดิบ"), title: "ซื้อ", payAccountId: kbank, overBudgetReason: "-", items: [{ description: "x", qty: 1, unit_price: total }] }, v(buyer)); return x; };
  const p1 = pr(60000);
  ok("a PR within the transferred money: no warning; the account is tracked", F.fundWarning({ id: p1, payAccountId: kbank, total: 60000 })?.over === false && F.fundSummary(kbank).remaining === 75000);
  P.submitPr(p1, v(buyer)); db.prepare("UPDATE purchase_requests SET status = 'approved' WHERE id = ?").run(p1);
  const p2 = pr(20000);
  const w = F.fundWarning({ id: p2, payAccountId: kbank, total: 20000 })!;
  ok("after 60,000 is committed only 15,000 remains: a 20,000 PR is warned about (short by 5,000) — only a warning", w.over && w.shortBy === 5000 && w.remaining === 15000 && err(() => P.submitPr(p2, v(buyer))) === "");
  ok("an account that is not funded by transfers (SCB, SME D BANK) is never warned", F.fundWarning({ id: 1, payAccountId: scb, total: 1e9 }) === null && F.fundWarning({ id: 1, payAccountId: sme, total: 1e9 }) === null && F.fundWarning({ id: 1, payAccountId: null, total: 5 }) === null);

  // bank statements mark the next transfer by themselves
  const id2 = fund([e1, e2], 50000); M.submitMemo(id2, v(buyer)); M.signMemo(id2, e1, "1234"); M.signMemo(id2, e2, "1234");
  const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8");
  const u = fin;
  R.importStatement(scb, "scb.csv", R.parseStatement(csv([["วันที่", "รายละเอียด", "ถอน", "ฝาก", "ยอดคงเหลือ"], ["08/12/2026", "โอนไป KBANK", "50000.00", "", "100000.00"]]), "scb.csv"), u);
  R.importStatement(kbank, "kb.csv", R.parseStatement(csv([["วันที่", "รายละเอียด", "ถอน", "ฝาก", "ยอดคงเหลือ"], ["08/12/2026", "รับโอนจาก SCB", "", "50000.00", "65000.00"]]), "kb.csv"), u);
  const t2 = F.listTransfers().find((x) => x.memoId === id2)!;
  ok("both statements show it → the transfer is recorded from the bank (date + amount from the statement, marked auto)", t2.status === "transferred" && t2.actualAmount === 50000 && t2.transferredOn === "2026-12-08" && t2.autoLinked && F.fundSummary(kbank).received === 125000);
  const outLine = (db.prepare("SELECT id FROM bank_lines WHERE account_id = ? AND debit > 0").get(scb) as { id: number }).id;
  R.unmatchLine(outLine);
  ok("un-matching the bank lines puts it back to awaiting", F.listTransfers().find((x) => x.memoId === id2)!.status === "awaiting");
  ok("a transfer that has not been recorded can be cancelled; a recorded one cannot", (F.cancelTransfer(t2.id, fin), F.listTransfers().find((x) => x.memoId === id2)!.status === "cancelled") && err(() => F.cancelTransfer(t.id, fin)) === "bad_status");

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall funding checks passed");
})();
