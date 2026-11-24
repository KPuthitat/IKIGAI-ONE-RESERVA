// Payslip PDFs: round payslip (admin / staff view) + A4 bank payslip. Run: node --import tsx scripts/test-payslip-pdf.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-payslip-pdf.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const PS = await import("../src/lib/payslip");
  const PP = await import("../src/lib/payslip-pdf");
  const BP = await import("../src/lib/bank-payslip-pdf");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const isPdf = (b: Buffer) => b.subarray(0, 5).toString() === "%PDF-" && b.length > 2000;

  const co = Number(db.prepare("INSERT INTO companies (name_th, name_en, tax_id) VALUES ('บริษัท ทดสอบ จำกัด','TEST CO','0105569000001')").run().lastInsertRowid);
  const br = Number(db.prepare("INSERT INTO branches (slug,name,company_id,tax_branch_code) VALUES ('nama','NAMA',?,'00001')").run(co).lastInsertRowid);
  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,title_prefix,bank_name,bank_account,employee_code) VALUES ('u1','x','พนักงาน ทดสอบ','staff','active','นาย','ไทยพาณิชย์','5051234567','E001')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(uid, br);
  const period = Number(db.prepare("INSERT INTO payroll_periods (cycle,target,period_start,period_end,pay_date,status,branch_id) VALUES ('monthly','all','2026-10-01','2026-10-31','2026-11-05','paid',?)").run(br).lastInsertRowid);
  db.prepare(`INSERT INTO payroll_lines (period_id,user_id,employee_code,display_name,employment_type,days_worked,base_pay,ot_pay,service_charge,other_additions,gross_pay,sso_amount,tax_amount,other_deductions,net_pay,special_payment,special_paid_out)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(period, uid, "E001", "พนักงาน ทดสอบ", "ft", 26, 15000, 500, 800, 0, 16300, 750, 0, 0, 15550, 0, 0);

  const view = PS.buildPayslipView(db, period, uid);
  ok("the payslip view builds", !!view);
  if (view) {
    const f = PS.payslipFigures(view);
    ok("figures tie out: income − deductions = net", Math.abs(f.incomeTotalRound - f.dedTotalRound - f.netTotalRound) < 0.01);
    const a = await PP.generatePayslipPdf(view, "admin");
    const s = await PP.generatePayslipPdf(view, "staff");
    ok("admin PDF renders", isPdf(a));
    ok("staff PDF renders", isPdf(s));
  }
  ok("a missing round has no view", PS.buildPayslipView(db, 9999, uid) === null);

  const BPm = await import("../src/lib/payslip-bank");
  const bank = BPm.buildBankPayslip(db, uid, "2026-10");
  if (bank) ok("bank A4 PDF renders", isPdf(await BP.generateBankPayslipPdf(bank)));
  else console.log("  – bank payslip skipped (no monthly rollup for the fixture)");

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll payslip PDF tests passed");
})();
