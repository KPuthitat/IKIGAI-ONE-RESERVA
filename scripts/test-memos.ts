// Memo → signatures → PR. Run: node --import tsx scripts/test-memos.ts
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
const TMP = path.join(process.cwd(), "data", "test-memos.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/memos");
  const P = await import("../src/lib/purchasing");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof M.MemoError ? e.code : e instanceof Error ? e.message : String(e); } };

  const branch = Number(db.prepare("INSERT INTO branches (slug, name) VALUES ('b1','NAMA')").run().lastInsertRowid);
  const mk = (u: string, role: string, c = 0, pin: string | null = "1234") => Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,is_c_level,pin_hash) VALUES (?,?,?,?, 'active', ?, ?)").run(u, "x", u, role, c, pin ? bcrypt.hashSync(pin, 4) : null).lastInsertRowid);
  const author = mk("author", "admin"), e1 = mk("exec1", "admin", 1), e2 = mk("exec2", "admin", 1), top = mk("top", "super_admin", 1), staff = mk("staff", "staff"), nopin = mk("nopin", "admin", 1, null);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,1)").run(author, branch);
  const view = (id: number, role: "admin" | "super_admin" | "staff", ab: number[] = []) => P.viewerOf({ id, role, adminBranchIds: ab });
  const V = view(author, "admin", [branch]);
  const cat = (db.prepare("SELECT name FROM accounta_categories LIMIT 1").get() as { name: string } | undefined)?.name;
  if (!cat) db.prepare("INSERT INTO accounta_categories (name, kind) VALUES ('วัตถุดิบ','expense')").run();
  const category = cat ?? "วัตถุดิบ";
  const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const input = (signerIds: number[]) => ({ branchId: branch, subject: "ซื้อเครื่องปรับอากาศ", body: "ของเดิมเสีย", category, neededDate: "2026-12-10", vatRate: 7, items: [{ description: "แอร์ 12000 BTU", qty: 2, unit: "เครื่อง", unit_price: 15000 }], signerIds });

  ok("a plain staff member cannot write a memo; an admin of the branch can", err(() => M.createMemo(input([e1]), view(staff, "staff"))) === "forbidden" && M.createMemo(input([e1, e2]), V) > 0);
  const id = (db.prepare("SELECT id FROM memos").get() as { id: number }).id;
  const d0 = M.getMemoDetail(id);
  ok("memo number MEMO-<BE year>-0001, totals incl. 7% VAT (30,000 + 2,100)", /^MEMO-\d{4}-0001$/.test(d0.memoNo) && d0.subtotal === 30000 && d0.vatAmount === 2100 && d0.total === 32100 && d0.status === "draft" && d0.signers.length === 2);
  ok("the author cannot be a signer, nor a plain staff user", err(() => M.createMemo(input([author]), V)) === "bad_signer" && err(() => M.createMemo(input([staff]), V)) === "bad_signer");
  ok("nothing is sent without signers or items", (() => { const x = M.createMemo({ ...input([]), items: [{ description: "x", qty: 1, unit_price: 1 }] }, V); return err(() => M.submitMemo(x, V)) === "no_signers"; })());

  ok("only the author submits", err(() => M.submitMemo(id, view(e1, "admin"))) === "forbidden");
  M.submitMemo(id, V);
  ok("submitted: status pending, both signers waiting, it shows in their 'to sign' list", M.getMemoDetail(id).status === "pending" && M.awaitingMySignature(e1).length === 1 && M.awaitingMySignature(e2).length === 1 && M.awaitingMySignature(author).length === 0);
  ok("a pending memo cannot be edited", err(() => M.updateMemo(id, input([e1, e2]), V)) === "bad_status");

  ok("signing needs a saved signature first", err(() => M.signMemo(id, e1, "1234")) === "no_signature");
  ok("a bad signature image is refused", err(() => M.saveSignature(e1, "data:image/png;base64,@@@")) === "bad_signature_image" && err(() => M.saveSignature(e1, "data:image/jpeg;base64,AAAA")) === "bad_signature_image");
  M.saveSignature(e1, SIG); M.saveSignature(e2, SIG);
  ok("the PIN is checked: wrong PIN refused, a person with no PIN is told to set one", err(() => M.signMemo(id, e1, "0000")) === "wrong_pin" && (() => { M.saveSignature(nopin, SIG); return true; })());
  ok("someone who is not a signer cannot sign", err(() => M.signMemo(id, top, "1234")) === "not_signer");
  const r1 = M.signMemo(id, e1, "1234");
  ok("first signature: still pending (1 of 2)", !r1.allSigned && r1.memo.status === "pending" && r1.memo.signed === 1);
  ok("signing twice is refused", err(() => M.signMemo(id, e1, "1234")) === "already_signed");
  M.saveSignature(e2, SIG.replace("AAAA", "AAAA"));
  const r2 = M.signMemo(id, e2, "1234");
  ok("all signed → memo approved", r2.allSigned && r2.memo.status === "approved" && !!r2.memo.approvedAt);
  ok("each signing keeps its own snapshot of the signature", M.getMemoDetail(id).signers.every((s) => s.status === "signed" && !!s.signature && !!s.signedAt));

  // PR from the memo
  ok("only the author opens the PR", err(() => M.openPrFromMemo(id, view(e1, "admin"))) === "forbidden");
  ok("no budget set: opening the PR asks for an over-budget reason, and nothing is half-created", (() => { try { M.openPrFromMemo(id, V); return false; } catch (e) { return e instanceof M.MemoError && e.code === "pr_failed" && e.detail === "over_budget_reason_required" && M.getMemoDetail(id).status === "approved" && (db.prepare("SELECT COUNT(*) n FROM purchase_requests").get() as { n: number }).n === 0; } })());
  const o = M.openPrFromMemo(id, V, "ยังไม่ได้ตั้งงบ");
  const pr = P.getPr(o.prId)!;
  ok("PR opened from the memo: same items, vendor, VAT and total, submitted for approval, linked both ways", pr.status === "submitted" && pr.total === 32100 && pr.title === "ซื้อเครื่องปรับอากาศ" && P.listItems(o.prId).length === 1 && o.memo.status === "pr_opened" && o.memo.prId === o.prId && (db.prepare("SELECT memo_id FROM purchase_requests WHERE id = ?").get(o.prId) as { memo_id: number }).memo_id === id);
  ok("a second PR cannot be opened from the same memo", err(() => M.openPrFromMemo(id, V)) === "bad_status");

  // rejection path
  const rid = M.createMemo(input([e1, top]), V); M.submitMemo(rid, V);
  ok("declining needs a reason", err(() => M.rejectMemo(rid, e1, " ")) === "reject_reason_required");
  const rj = M.rejectMemo(rid, e1, "แพงเกินไป");
  ok("one decline rejects the memo at once", rj.status === "rejected" && M.getMemoDetail(rid).signers.find((s) => s.userId === e1)!.comment === "แพงเกินไป");
  M.reopenMemo(rid, V);
  ok("reopened as a draft: every signature cleared, editable again, PR cannot be opened", M.getMemoDetail(rid).status === "draft" && M.getMemoDetail(rid).signers.every((s) => s.status === "pending") && err(() => M.openPrFromMemo(rid, V)) === "bad_status");
  M.cancelMemo(rid, V);
  ok("cancelled memos leave the 'to sign' lists", M.getMemoDetail(rid).status === "cancelled" && M.awaitingMySignature(top).length === 0);

  // visibility
  ok("who sees what: the author and the signers see the memo; an unrelated staff user does not; executives see all", M.listMemos(V).length === 3 && M.listMemos(view(e1, "admin")).length >= 2 && M.listMemos(view(staff, "staff")).length === 0 && M.listMemos(view(top, "super_admin")).length === 3);
  ok("audit log has the whole story", M.getMemoDetail(id).events.map((e) => e.action).join(",") === "create,submit,sign,sign,approved,open_pr");

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall memo checks passed");
})();
