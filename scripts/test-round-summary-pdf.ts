// Whole-round summary: shared data builder + the A4 landscape PDF. Run: node --import tsx scripts/test-round-summary-pdf.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-round-summary-pdf.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/round-summary");
  const P = await import("../src/lib/round-summary-pdf");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const pages = (b: Buffer) => (b.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

  const co = Number(db.prepare("INSERT INTO companies (name_th, name_en, tax_id) VALUES ('บริษัท ทดสอบ จำกัด','TEST CO','0105569000001')").run().lastInsertRowid);
  const br = Number(db.prepare("INSERT INTO branches (slug,name,company_id,tax_branch_code) VALUES ('nama','NAMA',?,'00001')").run(co).lastInsertRowid);
  const mk = (i: number) => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,title_prefix,bank_name,bank_account) VALUES (?,?,?,'staff','active','นาย','ไทยพาณิชย์','5051234567')").run(`u${i}`, "x", `พนักงาน ${i}`).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, br);
    return id;
  };
  const period = Number(db.prepare("INSERT INTO payroll_periods (cycle,target,period_start,period_end,pay_date,status,branch_id) VALUES ('monthly','all','2026-10-01','2026-10-31','2026-11-05','paid',?)").run(br).lastInsertRowid);
  const N = 45;
  for (let i = 1; i <= N; i++) {
    const u = mk(i);
    db.prepare(`INSERT INTO payroll_lines (period_id,user_id,employee_code,display_name,employment_type,days_worked,base_pay,ot_pay,service_charge,other_additions,gross_pay,sso_amount,tax_amount,other_deductions,net_pay,special_payment,special_paid_out)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(period, u, `E${i}`, `พนักงาน ${i}`, i <= 3 ? "ft" : "pt", 6, 3000, 100, 200, 0, 3300, i <= 3 ? 750 : 0, i % 5 === 0 ? 83.18 : 0, 0, i <= 3 ? 2550 : i % 5 === 0 ? 3216.82 : 3300, 0, 0);
  }
  const d = R.buildRoundSummary(db, period)!;
  ok("the builder returns the round, its people, the company and the branch", d.lines.length === N && d.company?.name_en === "TEST CO" && d.branch?.name === "NAMA" && d.period.pay_date === "2026-11-05");
  ok("totals are the column sums", d.tot.gross === 3300 * N && d.tot.sso === 750 * 3 && Math.round(d.tot.tax * 100) === Math.round(83.18 * 9 * 100));
  ok("gross − deductions = net (the footer ties out)", Math.abs(d.tot.gross - d.totalDeductions - d.tot.net) < 0.005);
  ok("full-time people come first", d.lines.slice(0, 3).every((l) => l.employment_type === "ft"));
  ok("the bank account is masked", R.maskAccount("5051234567") === "505-x-xxxxx-7" && R.maskAccount(null) === "—" && R.maskAccount("123") === "123");
  ok("branch tax label", R.branchTaxLabel("00000") === "สำนักงานใหญ่ (00000)" && R.branchTaxLabel("00001") === "สาขาที่ 00001" && R.branchTaxLabel(null) === "สำนักงานใหญ่ (00000)");
  ok("a missing round returns null", R.buildRoundSummary(db, 9999) === null);

  const pdf = await P.generateRoundSummaryPdf(d, "24 พ.ย. 2569 22:13");
  ok("it is a PDF", pdf.subarray(0, 5).toString() === "%PDF-" && pdf.length > 5000);
  ok(`45 people spill over onto more than one page (got ${pages(pdf)})`, pages(pdf) >= 2 && pages(pdf) <= 3);
  const one = await P.generateRoundSummaryPdf({ ...d, lines: d.lines.slice(0, 5) }, "x");
  ok("a short round fits on one page, with the totals and signatures", pages(one) === 1);
  const empty = await P.generateRoundSummaryPdf({ ...d, lines: [], tot: { base: 0, ot: 0, svc: 0, add: 0, gross: 0, sso: 0, tax: 0, ded: 0, welfare: 0, net: 0 }, totalDeductions: 0 }, "x");
  ok("an empty round still makes a valid one-page PDF", empty.subarray(0, 5).toString() === "%PDF-" && pages(empty) === 1);
  const noCompany = await P.generateRoundSummaryPdf({ ...d, company: null, branch: null, addressToShow: null, lines: d.lines.slice(0, 3) }, "x");
  ok("it renders without a company or branch", noCompany.subarray(0, 5).toString() === "%PDF-");

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
