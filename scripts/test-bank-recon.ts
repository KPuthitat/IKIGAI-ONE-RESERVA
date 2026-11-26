// Monthly bank reconciliation. Run: node --import tsx scripts/test-bank-recon.ts
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
const TMP = path.join(process.cwd(), "data", "test-bank-recon.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/bank-recon");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof R.ReconError ? e.code : e instanceof Error ? e.message : String(e); } };

  const user = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('acc','x','บัญชี','admin','active')").run().lastInsertRowid);
  const acct = (name: string, bank: string, no: string) => Number(db.prepare("INSERT INTO accounta_cash_accounts (name, type, bank_name, account_no) VALUES (?, 'bank', ?, ?)").run(name, bank, no).lastInsertRowid);
  const scb = acct("SCB หมุนเวียน", "SCB", "111-2-33333-4"), kbank = acct("KBANK จัดซื้อ", "KBANK", "222-3-44444-5");
  ok("bank accounts list shows only the last 4 digits", R.listBankAccounts().map((a) => a.accountLast4).sort().join() === "3334,4445");
  R.setPurpose(scb, "working"); ok("an account gets its purpose; a bad purpose is refused", R.listBankAccounts().find((a) => a.id === scb)!.purpose === "working" && err(() => R.setPurpose(scb, "nonsense")) === "bad_status");

  // what ACCOUNTA already knows
  const exp = (vendor: string, amount: number, date: string, method = "transfer") => Number(db.prepare("INSERT INTO accounta_expenses (bill_date, vendor_name, description, amount_total, payment_status, payment_method, paid_date, review_status) VALUES (?,?,?,?, 'paid', ?, ?, 'confirmed')").run(date, vendor, vendor, amount, method, date).lastInsertRowid);
  const e1 = exp("บจก. แม็คโคร", 12500, "2026-11-05"), e2 = exp("ร้านวัสดุก่อสร้าง", 3200, "2026-11-10"), e3 = exp("ซัพพลายเออร์ A", 4000, "2026-11-12"), e4 = exp("ซัพพลายเออร์ B", 4000, "2026-11-12"), e5 = exp("ค่าน้ำ", 999, "2026-11-27");
  const inc = Number(db.prepare("INSERT INTO accounta_income (income_date, channel, amount) VALUES ('2026-11-15','โอน/QR',20000)").run().lastInsertRowid);

  // ── SCB-style: separate debit / credit columns, Buddhist 2-digit year, NEWEST FIRST, with balance
  const scbRows = [
    ["รายการเคลื่อนไหวบัญชี", "", "", "", ""],
    ["วันที่", "รายละเอียด", "ถอน", "ฝาก", "ยอดคงเหลือ"],
    ["30/11/69", "ค่าธรรมเนียมรายเดือน", "100.00", "", "58,000.00"],
    ["25/11/69", "โอนไป KBANK จัดซื้อ", "50,000.00", "", "58,100.00"],
    ["15/11/69", "รับโอน QR", "", "20,000.00", "108,100.00"],
    ["12/11/69", "จ่าย ซัพพลายเออร์ A", "4,000.00", "", "88,100.00"],
    ["10/11/69", "ร้านวัสดุก่อสร้าง", "3,200.00", "", "92,100.00"],
    ["05/11/69", "แม็คโคร สาขาโคราช", "12,500.00", "", "95,300.00"],
    ["01/11/69", "ยอดยกมา/เงินเดือนเข้า", "", "107,800.00", "107,800.00"]
  ];
  const csv1 = Buffer.from(scbRows.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n"), "utf8");
  const p1 = R.parseStatement(csv1, "scb.csv");
  if (process.env.DBG) console.log(JSON.stringify({ c: p1.columns, n: p1.lines.length, o: p1.order, pr: p1.problems, ch: p1.chainBreaks, op: p1.opening, cl: p1.closing, f: p1.firstDate, l: p1.lastDate, l0: p1.lines.slice(0, 2) }));
  ok("SCB-style: columns found from the Thai headings, 7 movements, Buddhist 2-digit years read, newest-first order detected", p1.columns?.debit === 2 && p1.columns?.credit === 3 && p1.lines.length === 7 && p1.order === "desc" && p1.firstDate === "2026-11-01" && p1.lastDate === "2026-11-30");
  ok("balance chain is intact (no missing line); opening 0 and closing 58,000 are derived", p1.chainBreaks === 0 && p1.opening === 0 && p1.closing === 58000);
  const i1 = R.importStatement(scb, "scb.csv", p1, user);
  ok("imported 7 lines; auto-match found the unique ones (3 expenses + 1 income)", i1.inserted === 7 && i1.matched === 4);
  let m = R.monthSummary(scb, "2026-11");
  const st = (desc: string) => m.lines.find((l) => l.description.includes(desc))!;
  ok("Makro, hardware and supplier-A lines matched by amount + date (supplier A needed its name: two bills of 4,000)", st("แม็คโคร").status === "matched" && st("แม็คโคร").kind === "expense" && st("แม็คโคร").ref === e1 && st("ร้านวัสดุ").ref === e2 && st("ซัพพลายเออร์ A").ref === e3 && st("รับโอน QR").kind === "income" && st("รับโอน QR").ref === inc);
  ok("the transfer to KBANK, the bank fee and the opening salary line wait for a person (never guessed)", st("โอนไป KBANK").status === "unmatched" && st("ค่าธรรมเนียม").status === "unmatched" && st("ยอดยกมา").status === "unmatched");
  ok("month summary: totals, balance ok, 'paid by transfer but not in the bank' lists supplier B and the water bill", m.totalDebit === 69800 && m.totalCredit === 127800 && m.balanceOk === true && m.counts.unmatched === 3 && m.missingInBank.map((x) => x.amount).sort().join() === "4000,999");

  // ── re-import is idempotent
  const i1b = R.importStatement(scb, "scb.csv", p1, user);
  ok("importing the same file again adds nothing", i1b.inserted === 0 && i1b.duplicates === 7);

  // ── KBANK-style: one signed amount column, ISO dates, oldest first, includes the incoming transfer
  const kRows = [["Date", "Description", "Amount", "Balance"], ["2026-11-25", "Transfer from SCB", "50000.00", "50000.00"], ["2026-11-28", "จ่าย ค่าน้ำ", "-999.00", "49001.00"]];
  const xlsxBuf = (() => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kRows), "S"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; })();
  const p2 = R.parseStatement(xlsxBuf, "kbank.xlsx");
  ok("KBANK-style (Excel, signed amount, English headings): debit/credit split by sign, chain ok", p2.columns?.amount === 2 && p2.lines[0].credit === 50000 && p2.lines[1].debit === 999 && p2.chainBreaks === 0 && p2.opening === 0);
  const i2 = R.importStatement(kbank, "kbank.xlsx", p2, user);
  m = R.monthSummary(scb, "2026-11");
  ok("the SCB→KBANK transfer is matched on both sides automatically (same amount, 0 days apart), and the water bill on KBANK", i2.matched === 3 && st("โอนไป KBANK").kind === "transfer" && R.monthSummary(kbank, "2026-11").lines.every((l) => l.status === "matched"));
  ok("'paid by transfer but not in the bank' now lists only supplier B", R.monthSummary(scb, "2026-11").missingInBank.map((x) => x.amount).join() === "4000");

  // ── manual work
  const fee = st("ค่าธรรมเนียม"), salary = st("ยอดยกมา");
  ok("explaining needs a reason; then the line is 'ignored' with that reason", err(() => R.explainLine(fee.id, " ", user)) === "reason_required" && (R.explainLine(fee.id, "ค่าธรรมเนียมธนาคาร", user), R.monthSummary(scb, "2026-11").lines.find((l) => l.id === fee.id)!.reason === "ค่าธรรมเนียมธนาคาร"));
  ok("candidates for a credit line with no match: none; a wrong-amount manual match is refused", R.candidatesFor(salary.id).length === 0 && err(() => R.matchLine(salary.id, "income", inc, user)) === "amount_mismatch");
  ok("close is refused while a line is unmatched", err(() => R.closePeriod(scb, "2026-11", "", user)) === "unmatched_remain");
  R.explainLine(salary.id, "เงินยกมา/เงินเดือนเข้า", user);
  ok("one expense cannot be claimed by two bank lines", err(() => R.matchLine(fee.id, "expense", e1, user)) !== "");
  R.closePeriod(scb, "2026-11", "", user);
  const closed = R.monthSummary(scb, "2026-11");
  ok("closed month: opening / closing / totals kept, who and when recorded", closed.closed && closed.opening === 0 && closed.closing === 58000 && closed.totalDebit === 69800 && closed.counts.unmatched === 0);
  ok("a closed month cannot be changed (explain, unmatch) …", err(() => R.explainLine(fee.id, "x", user)) === "period_closed" && err(() => R.unmatchLine(fee.id)) === "period_closed");
  const i3 = R.importStatement(scb, "scb.csv", p1, user);
  ok("… and a later import skips its lines", i3.skippedClosed === 7 && i3.inserted === 0);
  R.reopenPeriod(scb, "2026-11");
  R.unmatchLine(st("โอนไป KBANK").id);
  ok("after reopening, un-matching a transfer frees both sides", R.monthSummary(scb, "2026-11").lines.find((l) => l.description.includes("โอนไป KBANK"))!.status === "unmatched" && R.monthSummary(kbank, "2026-11").lines[0].status === "unmatched");

  // ── a missing line is caught by the balance chain
  const gap = scbRows.filter((r) => !String(r[1]).includes("ร้านวัสดุ"));
  const p4 = R.parseStatement(Buffer.from(gap.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(",")).join("\n"), "utf8"), "gap.csv");
  ok("a line missing from the file breaks the balance chain and is reported (1 break)", p4.chainBreaks === 1 && p4.lines.length === 6);

  // ── parsing details
  ok("numbers and dates: (1,234.50) negative, trailing minus, Thai month names, Buddhist 4-digit year, Excel serial", R.parseNumber("(1,234.50)") === -1234.5 && R.parseNumber("1,000.00-") === -1000 && R.parseNumber("฿ 99") === 99 && R.parseDate("5 พ.ย. 69") === "2026-11-05" && R.parseDate("05/11/2569") === "2026-11-05" && R.parseDate(46331) === "2026-11-05");
  ok("a file with no recognisable columns says so; manual mapping then works", (() => { const bad = Buffer.from("a,b,c\n1,2,3\n", "utf8"); const r = R.parseStatement(bad, "x.csv"); const mp = R.parseStatement(Buffer.from("x,y,z\n05/11/2026,foo,100\n", "utf8"), "y.csv", { date: 0, desc: 1, debit: null, credit: null, amount: 2, type: null, balance: null }); return r.columns === null && mp.lines.length === 1 && mp.lines[0].credit === 100; })());

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall bank reconciliation checks passed");
})();
