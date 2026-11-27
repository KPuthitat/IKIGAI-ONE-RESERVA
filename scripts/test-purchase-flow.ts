// Purchase flow chart. Run: node --import tsx scripts/test-purchase-flow.ts
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const TMP = path.join(process.cwd(), "data", "test-purchase-flow.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/memos");
  const P = await import("../src/lib/purchasing");
  const F = await import("../src/lib/purchase-flow");
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO purchasing_settings (key, value) VALUES ('quotes_required', '0')").run();   // these checks are about other rules; quote comparison has its own test
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  const b1 = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b1','NAMA')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,pin_hash) VALUES (?,?,?,?, 'active', ?, ?)").run(u, "x", u, role, c, bcrypt.hashSync("1234", 4)).lastInsertRowid);
  const author = mk("author", "admin"), e1 = mk("exec1", "admin", 1), e2 = mk("exec2", "admin", 1);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(author, b1);
  const V = P.viewerOf({ id: author, role: "admin", adminBranchIds: [b1] }), VE = P.viewerOf({ id: e1, role: "admin", adminBranchIds: [] });
  db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (NULL, NULL, 'one_exec', 1)").run();
  if (!db.prepare("SELECT 1 FROM accounta_categories LIMIT 1").get()) db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run();
  const category = (db.prepare("SELECT name FROM accounta_categories LIMIT 1").get() as { name: string }).name;
  M.saveSignature(e1, SIG); M.saveSignature(e2, SIG);
  const state = (f: ReturnType<typeof F.buildFlow>, k: string) => f.steps.find((s) => s.key === k)!.state;

  // direct PR: the memo steps are skipped
  const direct = P.createPr({ branchId: b1, category, title: "ซื้อหมึกพิมพ์", vendorName: "ร้าน A", overBudgetReason: "งบ", items: [{ description: "หมึก", qty: 1, unit_price: 500 }] }, V);
  let f = F.buildFlow({ prId: direct });
  ok("a PR opened directly shows the memo steps as skipped and waits for its author to submit", state(f, "memo") === "skipped" && state(f, "sign") === "skipped" && state(f, "pr") === "current" && /ยังเป็นร่าง/.test(f.headline) && f.waitingIds.includes(author));
  P.submitPr(direct, V);
  f = F.buildFlow({ prId: direct });
  ok("submitted: at the approval step, waiting for the executives who may approve", state(f, "approve") === "current" && f.waitingIds.includes(e1) && f.waitingIds.includes(e2) && /รออนุมัติ PR/.test(f.headline));

  // memo path
  const id = M.createMemo({ branchId: b1, subject: "ขอซื้อโต๊ะ", category, items: [{ description: "โต๊ะ", qty: 2, unit: "ตัว", unit_price: 3000 }], signerIds: [e1, e2] }, V);
  f = F.buildFlow({ memoId: id });
  ok("draft memo: current step is the memo, waiting for the author", state(f, "memo") === "current" && f.waitingIds.join() === String(author));
  M.submitMemo(id, V);
  f = F.buildFlow({ memoId: id });
  ok("pending: both signers are waited for", state(f, "sign") === "current" && f.waitingIds.length === 2 && /รอลงนาม Memo/.test(f.headline));
  M.signMemo(id, e1, "1234");
  f = F.buildFlow({ memoId: id });
  ok("one signed: only the other is still waited for, the signed one is marked done", f.waitingIds.join() === String(e2) && f.steps[1].people.find((p) => p.id === e1)?.status === "done");
  M.signMemo(id, e2, "1234");
  f = F.buildFlow({ memoId: id });
  ok("memo approved: the author is asked to open the PR", state(f, "sign") === "done" && state(f, "pr") === "current" && f.waitingIds.join() === String(author));
  const o = M.openPrFromMemo(id, V, "งบ");
  f = F.buildFlow({ prId: o.prId });
  ok("the chart can be built from the PR side and finds the memo", f.memoId === id && state(f, "sign") === "done" && state(f, "approve") === "current");
  P.decidePr(o.prId, true, "", VE);
  f = F.buildFlow({ memoId: id });
  ok("approved: the approval step is done and the PO is next", state(f, "approve") === "done" && state(f, "po") === "current" && /เปิดใบสั่งซื้อ/.test(f.headline));
  P.issuePo(o.prId, { vendorName: "ร้านเฟอร์นิเจอร์" }, V);
  f = F.buildFlow({ memoId: id });
  ok("ordered: waiting for the goods", state(f, "po") === "done" && state(f, "receive") === "current" && /รอรับของ/.test(f.headline));
  P.receivePo(o.prId, "", V);
  f = F.buildFlow({ memoId: id });
  ok("received: waiting for the bills to close it", state(f, "receive") === "done" && state(f, "bill") === "current" && !f.finished);

  // rejection stops the chart
  const rid = M.createMemo({ branchId: b1, subject: "ขอซื้อเก้าอี้", category, items: [{ description: "เก้าอี้", qty: 1, unit_price: 100 }], signerIds: [e1] }, V);
  M.submitMemo(rid, V); M.rejectMemo(rid, e1, "แพง");
  f = F.buildFlow({ memoId: rid });
  ok("a declined memo stops at the signature step", f.failed && state(f, "sign") === "failed" && f.steps[1].people[0].status === "rejected");

  // funding
  const acct = (n: string) => Number(db.prepare("INSERT INTO accounta_cash_accounts (name, type, active) VALUES (?, 'bank', 1)").run(n).lastInsertRowid);
  const scb = acct("SCB"), kb = acct("KBANK");
  const fid = M.createMemo({ kind: "funding", branchId: b1, subject: "ขอเบิกเงิน", category: "", fromAccountId: scb, toAccountId: kb, amount: 20000, items: [], signerIds: [e1] }, V);
  M.submitMemo(fid, V);
  f = F.buildFlow({ memoId: fid });
  ok("funding memo has its own chain and waits for the signer", f.kind === "funding" && f.steps.length === 4 && state(f, "sign") === "current");
  M.signMemo(fid, e1, "1234");
  f = F.buildFlow({ memoId: fid });
  ok("fully signed: waiting for finance to transfer", state(f, "transfer") === "current" && /ฝ่ายการเงิน/.test(f.headline));
  const tid = (db.prepare("SELECT id FROM fund_transfers WHERE memo_id = ?").get(fid) as { id: number }).id;
  const Fd = await import("../src/lib/funding");
  Fd.markTransferred(tid, { transferredOn: "2026-12-01" }, e1, "1234");
  f = F.buildFlow({ memoId: fid });
  ok("transferred: the chain is finished", f.finished && state(f, "funds") === "done");

  // tracker
  const rows = F.listInFlight(VE, [b1]);
  ok("the tracker lists what is still moving (not the finished funding memo), people waited for come first", rows.length >= 2 && !rows.some((r) => r.number.startsWith("MEMO") && r.flow.kind === "funding") && rows[0].waitingMe);
  ok("a PR that came from a memo is listed once", rows.filter((r) => r.number.includes(P.getPr(o.prId)!.prNo)).length === 1);

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall purchase flow checks passed");
})();
