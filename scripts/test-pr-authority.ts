// PR approval authority by account and amount. Run: node --import tsx scripts/test-pr-authority.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-pr-authority.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const P = await import("../src/lib/purchasing");
  const A = await import("../src/lib/pr-authority");
  const AD = await import("../src/lib/pr-authority-admin");
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO purchasing_settings (key, value) VALUES ('quotes_required', '0')").run();   // these checks are about other rules; quote comparison has its own test
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof P.PurchasingError ? e.code : e instanceof Error ? e.message : String(e); } };

  const br = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b','NAMA')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0, top = 0) => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,is_top_exec) VALUES (?,?,?,?, 'active', ?, ?)").run(u, "x", u, role, c, top).lastInsertRowid);
  const author = mk("author", "admin"), e1 = mk("exec1", "admin", 1), e2 = mk("exec2", "admin", 1), kb = mk("kbexec", "admin", 1), top = mk("top", "admin", 1, 1), plain = mk("plainadmin", "admin"), owner = mk("owner", "super_admin");
  const v = (id: number, role: "admin" | "super_admin" = "admin") => P.viewerOf({ id, role, adminBranchIds: [br] });
  const acct = (n: string) => Number(db.prepare("INSERT INTO accounta_cash_accounts (name, type, bank_name) VALUES (?, 'bank', ?)").run(n, n).lastInsertRowid);
  const scb = acct("SCB"), kbank = acct("KBANK"), sme = acct("SME D BANK");
  const cat = (db.prepare("SELECT name FROM accounta_categories WHERE active = 1 LIMIT 1").get() as { name: string } | undefined)?.name ?? (db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run(), "วัตถุดิบ");
  const pr = (account: number | null, total: number) => {
    const id = P.createPr({ branchId: br, category: cat, title: "ทดสอบ", payAccountId: account, overBudgetReason: "ไม่มีงบ", items: [{ description: "x", qty: 1, unit_price: total }] }, v(author));
    P.submitPr(id, v(author)); return id;
  };
  const status = (id: number) => P.getPr(id)!.status;

  // ── default: two executives, or the top executive
  const p1 = pr(scb, 5000);
  ok("default rule (no tiers): two executives, or one top executive", A.ruleFor(scb, 5000) === "two_execs_or_top" && A.ruleFor(null, 1e9) === "two_execs_or_top");
  ok("a plain admin (not an executive) cannot approve", code(() => P.decidePr(p1, true, "", v(plain))) === "forbidden");
  P.decidePr(p1, true, "", v(e1));
  ok("one executive: the PR stays submitted, 1 of 2 recorded, and says what is still needed", status(p1) === "submitted" && A.approvalState(p1).approveCount === 1 && A.approvalState(p1).remainingText.includes("อีก 1 คน"));
  ok("the same executive cannot count twice", (P.decidePr(p1, true, "again", v(e1)), status(p1) === "submitted" && A.approvalState(p1).approveCount === 1));
  P.decidePr(p1, true, "ok", v(e2));
  ok("a second executive approves it; the last approver is recorded", status(p1) === "approved" && P.getPr(p1)!.decidedBy === e2 && A.approvalState(p1).approved);
  const p2 = pr(scb, 5000);
  P.decidePr(p2, true, "", v(top));
  ok("the top executive alone is enough", status(p2) === "approved");
  const p3 = pr(scb, 5000);
  ok("the requester cannot approve their own PR", code(() => P.decidePr(p3, true, "", P.viewerOf({ id: author, role: "admin", adminBranchIds: [br] }))) === "forbidden");

  // ── rejection by one executive
  const p4 = pr(scb, 5000);
  ok("a rejection needs a reason, and one rejection rejects the PR", code(() => P.decidePr(p4, false, " ", v(e1))) === "reject_note_required" && (P.decidePr(p4, false, "แพง", v(e1)), status(p4) === "rejected"));
  P.reopenPr(p4, v(author)); P.submitPr(p4, v(author));
  ok("a re-sent PR starts its approvals again", A.approvalState(p4).approveCount === 0 && A.approvalState(p4).approvals.length === 0);

  // ── tiers by amount on SCB
  db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (?, 20000, 'one_exec', 1), (?, 100000, 'two_execs_or_top', 2), (?, NULL, 'top_only', 3)").run(scb, scb, scb);
  ok("tiers pick the rule by total: ≤20,000 one executive · ≤100,000 two or top · above that the top executive only", A.ruleFor(scb, 20000) === "one_exec" && A.ruleFor(scb, 20000.01) === "two_execs_or_top" && A.ruleFor(scb, 100000) === "two_execs_or_top" && A.ruleFor(scb, 100001) === "top_only");
  const s1 = pr(scb, 15000); P.decidePr(s1, true, "", v(e1));
  ok("a small PR: one executive is enough", status(s1) === "approved");
  const s2 = pr(scb, 150000);
  ok("a large PR: ordinary executives are refused; only the top executive approves", code(() => P.decidePr(s2, true, "", v(e1))) === "not_authorised" && (P.decidePr(s2, true, "", v(top)), status(s2) === "approved"));
  ok("another account without tiers keeps the company default", A.ruleFor(kbank, 500000) === "two_execs_or_top");

  // ── KBANK: its own approver
  db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (?, NULL, 'one_exec', 1)").run(kbank);
  db.prepare("INSERT INTO account_approvers (account_id, user_id) VALUES (?,?)").run(kbank, kb);
  const k1 = pr(kbank, 80000);
  ok("KBANK: only its named approver may approve, and one is enough", code(() => P.decidePr(k1, true, "", v(e1))) === "not_authorised" && (P.decidePr(k1, true, "", v(kb)), status(k1) === "approved"));
  ok("who may approve is listed for the screen / notices", A.eligibleApprovers(kbank, "one_exec").join() === String(kb) && A.eligibleApprovers(scb, "top_only").join() === String(top));

  // ── no top executive flagged: the super admin stands in
  db.prepare("UPDATE users SET is_top_exec = 0").run();
  const s3 = pr(scb, 150000);
  ok("with nobody flagged as top executive the super admin can approve a top-only PR (no lock-out)", (P.decidePr(s3, true, "", v(owner, "super_admin")), status(s3) === "approved"));

  // ── editing the rules (owner only through the API)
  const bad = (fn: () => unknown) => { try { fn(); return ""; } catch (e) { return e instanceof AD.AuthorityError ? e.code : String(e); } };
  ok("tier editing is validated: limits must rise, the last tier has no limit, bad rule refused", bad(() => AD.setTiers(sme, [{ upTo: 100, rule: "one_exec" }, { upTo: 50, rule: "top_only" }, { upTo: null, rule: "top_only" }], owner)) === "invalid" && bad(() => AD.setTiers(sme, [{ upTo: 100, rule: "one_exec" }], owner)) === "invalid" && bad(() => AD.setTiers(sme, [{ upTo: null, rule: "anyone" }], owner)) === "invalid" && bad(() => AD.setTiers(99999, [], owner)) === "not_found");
  AD.setTiers(sme, [{ upTo: 10000, rule: "one_exec" }, { upTo: null, rule: "two_execs_or_top" }], owner);
  ok("saved tiers apply at once; clearing them returns the account to the company default", A.ruleFor(sme, 9000) === "one_exec" && A.ruleFor(sme, 10001) === "two_execs_or_top" && (AD.setTiers(sme, [], owner), A.ruleFor(sme, 9000) === "two_execs_or_top"));
  ok("account approvers must be executives; the top-executive flag can be set and read back", bad(() => AD.setAccountApprovers(kbank, [plain], owner)) === "invalid" && (AD.setAccountApprovers(kbank, [kb, e1], owner), A.accountApproverIds(kbank).sort().join() === [kb, e1].sort().join()) && (AD.setTopExec(top, true, owner), A.topExecIds().join() === String(top)));
  ok("the snapshot lists accounts, their own and effective tiers, people and who is top", (() => { const sn = AD.authoritySnapshot(); return sn.accounts.length === 3 && sn.people.some((x) => x.top) && sn.defaultTiers.length >= 1; })());

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall PR authority checks passed");
})();
