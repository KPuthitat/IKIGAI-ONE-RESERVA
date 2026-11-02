// Weekly transfer to a revenue-share partner booked as an ACCOUNTA expense — Run: node --import tsx scripts/test-revshare-transfer-expense.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-revshare-transfer-expense.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/revshare-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof R.TransferPostError ? e.code : `other:${(e as Error).message}`; } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บ')").run().lastInsertRowid);
  const seller = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('hypo','HYPO',?)").run(co).lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const user = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','a','admin','active')").run().lastInsertRowid);
  const p = R.createPartner(seller, { name: "บริษัท ศาลาชิลล์ จำกัด", venue: "จ้อจี้ & friends", start_date: "2026-06-01", vat_enabled: true, sales_base: "gross" } as never)!;
  const day = (iso: string, amount: number) => R.createRound(p, seller, { period_start: iso, period_end: iso, sales_amount: amount }, user);
  // week Mon 19 – Sun 25 Oct 2026 = 18,970 (the example on screen: 20,297.90 incl. VAT 1,327.90)
  day("2026-10-19", 10000); day("2026-10-20", 8970);
  day("2026-10-26", 5413);

  const weeks = R.listWeekTransfers(p, seller, 2026, 10)!;
  const w1 = weeks.find((w) => w.weekStart === "2026-10-19")!;
  ok("each week shows the amount to book, VAT-inclusive (18,970 + 7% = 20,297.90), and nothing booked yet", w1.sales === 18970 && w1.amount === 20297.9 && w1.posted === null);
  ok("the suggested transfer date is the Monday after the week", w1.defaultDate === "2026-10-26");
  const r1 = R.postWeekTransferExpense(p, seller, 2026, 10, "2026-10-19", "2026-10-26", user);
  const row = db.prepare("SELECT * FROM accounta_expenses WHERE id = ?").get(r1.expenseId) as Record<string, unknown>;
  ok("it is an expense in the ส่วนแบ่งจ่ายพันธมิตร category for the partner company, on the transfer day", row.category === "ส่วนแบ่งจ่ายพันธมิตร" && row.vendor_name === "บริษัท ศาลาชิลล์ จำกัด" && row.bill_date === "2026-10-26" && row.branch_id === seller && row.company_id === co);
  ok("amount 20,297.90 with VAT 1,327.90 shown as input tax, base 18,970", Math.abs((row.amount_total as number) - 20297.9) < 0.005 && Math.abs((row.vat_amount as number) - 1327.9) < 0.005 && Math.abs((row.base_amount as number) - 18970) < 0.005 && row.has_tax_invoice === 1);
  ok("it is already paid by transfer on that day (no 'จ่ายแล้ว' left to click) and not a fixed cost", row.payment_status === "paid" && row.payment_method === "transfer" && row.paid_date === "2026-10-26" && row.is_fixed === 0);
  ok("nothing is booked as income (the sales are already in the shift-close revenue)", (db.prepare("SELECT COUNT(*) n FROM accounta_income").get() as { n: number }).n === 0);
  ok("the week now reports what was booked", (() => { const x = R.listWeekTransfers(p, seller, 2026, 10)!.find((w) => w.weekStart === "2026-10-19")!; return x.posted?.expenseId === r1.expenseId && x.posted.amount === 20297.9; })());
  R.postWeekTransferExpense(p, seller, 2026, 10, "2026-10-19", "2026-10-26", user);
  ok("booking the same week again does not add a second expense", (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE category = 'ส่วนแบ่งจ่ายพันธมิตร'").get() as { n: number }).n === 1);
  const rid = (db.prepare("SELECT id FROM revshare_rounds WHERE partner_id = ? AND period_start = '2026-10-20'").get(p) as { id: number }).id;
  R.updateRound(rid, p, seller, { sales_amount: 9970 }, user);
  R.postWeekTransferExpense(p, seller, 2026, 10, "2026-10-19", "2026-10-27", user);
  ok("after the week's sales changed, re-booking updates the same row (new amount and date)", (() => { const r = db.prepare("SELECT amount_total a, bill_date d FROM accounta_expenses WHERE category = 'ส่วนแบ่งจ่ายพันธมิตร'").all() as Array<{ a: number; d: string }>; return r.length === 1 && Math.abs(r[0].a - 21367.9) < 0.005 && r[0].d === "2026-10-27"; })());
  ok("a different week is its own expense", (() => { R.postWeekTransferExpense(p, seller, 2026, 10, "2026-10-26", "2026-11-02", user); return (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE category = 'ส่วนแบ่งจ่ายพันธมิตร'").get() as { n: number }).n === 2; })());
  ok("an unknown week is refused", code(() => R.postWeekTransferExpense(p, seller, 2026, 10, "2026-10-12", "2026-10-19", user)) === "week_not_found");
  ok("another branch cannot book this partner", code(() => R.postWeekTransferExpense(p, other, 2026, 10, "2026-10-19", "2026-10-26", user)) === "not_found" && R.listWeekTransfers(p, other, 2026, 10) === null);

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
