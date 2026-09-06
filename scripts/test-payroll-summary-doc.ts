// สร้างเอกสารสรุปค่าตอบแทน — Phase 1 (owner 2026-09-06): คำนวณระดับบริษัท,
// แยกหัวข้อสาขา, แจกแจงรายรอบ (ก่อนหัก/หัก/สุทธิ) + สรุปรวมต่อคน.
//
// Proves buildPayrollSummaryDoc groups by company → branch → rounds, reconciles
// deductions from the STORED net (so posted rounds aren't altered), and that all
// three renderers (CSV / XLSX / PDF) produce valid output.
//
// Run:  node --import tsx scripts/test-payroll-summary-doc.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-payroll-summary.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const doclib = await import("../src/lib/payroll-summary-doc");
  const { renderPayrollSummaryXlsx } = await import("../src/lib/payroll-summary-xlsx");
  const { generatePayrollSummaryPdf } = await import("../src/lib/payroll-summary-pdf");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  // ── Fixture: one company, two branches, FT + PT ─────────────────────
  const co = Number(db.prepare("INSERT INTO companies (name_th, tax_id) VALUES ('บริษัท อิคิไก จำกัด','0105500000001')").run().lastInsertRowid);
  const b1 = Number(db.prepare("INSERT INTO branches (slug,name,company_id,status) VALUES ('nps','NAMA PASTA SRIRACHA',?, 'open')").run(co).lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name,company_id,status) VALUES ('hypo','HYPOPLARAEMIA',?, 'open')").run(co).lastInsertRowid);
  const mkUser = (name: string, type: "ft" | "pt", home: number) => {
    const u = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES (?,?,?,'staff','active',?)").run(name, "x", name, type).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?,?,1)").run(u, home);
    return u;
  };
  const ftA = mkUser("สมชาย", "ft", b1), ptB = mkUser("สมหญิง", "pt", b1), ftC = mkUser("สมศักดิ์", "ft", b2);

  const mkPeriod = (br: number, cyc: string, tgt: string, ps: string, pe: string, pd: string) => Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,target,data_source,period_start,period_end,pay_date,status,branch_id) VALUES (?,?,'auto',?,?,?,'paid',?)"
  ).run(cyc, tgt, ps, pe, pd, br).lastInsertRowid);
  const mkLine = (per: number, uid: number, name: string, type: string, taxMode: string, gross: number, sso: number, tax: number, other: number, net: number) =>
    db.prepare(`INSERT INTO payroll_lines
      (period_id,user_id,employee_code,display_name,employment_type,pay_cycle_snapshot,
       hourly_rate_snapshot,monthly_salary_snapshot,salary_tax_mode_snapshot,
       base_pay,ot_pay,service_charge,other_additions,gross_pay,sso_amount,tax_amount,other_deductions,net_pay,days_worked,leave_days)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`)
      .run(per, uid, "E" + uid, name, type, "monthly", null, gross, taxMode, gross, 0, 0, 0, gross, sso, tax, other, net, 20, 0);

  // b1: FT monthly round + PT weekly round; b2: FT monthly round.
  const p1 = mkPeriod(b1, "monthly", "ft", "2026-09-01", "2026-09-30", "2026-09-30");
  mkLine(p1, ftA, "สมชาย", "ft", "sso", 20000, 750, 0, 250, 19000); // has 250 "other" deduction
  const p2 = mkPeriod(b1, "weekly", "pt", "2026-09-01", "2026-09-07", "2026-09-08");
  mkLine(p2, ptB, "สมหญิง", "pt", "wht", 9000, 0, 270, 0, 8730);
  const p3 = mkPeriod(b2, "monthly", "ft", "2026-09-01", "2026-09-30", "2026-09-30");
  mkLine(p3, ftC, "สมศักดิ์", "ft", "sso", 30000, 750, 0, 0, 29250);

  console.log("buildPayrollSummaryDoc (scope=all):");
  const doc = doclib.buildPayrollSummaryDoc("2026-09", { kind: "all" });
  ok("1 บริษัท", doc.companies.length === 1);
  const c = doc.companies[0];
  ok("เลขผู้เสียภาษีติดมา", c.taxId === "0105500000001");
  ok("2 สาขา (แยกหัวข้อ)", c.branches.length === 2);
  const bl1 = c.branches.find((b) => b.branchName === "NAMA PASTA SRIRACHA")!;
  const bl2 = c.branches.find((b) => b.branchName === "HYPOPLARAEMIA")!;
  ok("สาขา b1 มี 2 รอบ (ประจำ+พาร์ทไทม์)", bl1.roundGroups.length === 2);
  ok("ประจำมาก่อนพาร์ทไทม์", bl1.roundGroups[0].info.cycle === "monthly" && bl1.roundGroups[1].info.cycle === "weekly");

  console.log("\nper-round member breakdown (ก่อนหัก/หัก/สุทธิ):");
  const ftRound = bl1.roundGroups[0];
  const mA = ftRound.members[0];
  ok("สมชาย ก่อนหัก = 20000", mA.before === 20000);
  ok("สมชาย หัก = 1000 (สะท้อน gross−net จริง: ปกส750+ภาษี0+อื่น250)", mA.deduction === 1000);
  ok("สมชาย สุทธิ = 19000 (ตามที่บันทึก)", mA.net === 19000);

  console.log("\nfinal rollup (ก่อนหัก · หัก · สุทธิ + อื่นๆ):");
  const rA = bl1.rollup.find((r) => r.name.includes("สมชาย"))!;
  ok("ก่อนหัก(income) = 20000 (ยังไม่มี SVC)", rA.income === 20000);
  ok("ปกส. = 750", rA.sso === 750);
  ok("หักอื่นๆ = 250 (เครื่องดื่ม/มื้ออาหาร)", rA.other === 250);
  ok("รวมหัก = 1000", rA.deduction === 1000);
  ok("สุทธิ = 19000 (= ก่อนหัก − รวมหัก)", rA.take === 19000);
  ok("รวมสาขา b1 สุทธิ = 19000 + 8730", bl1.totals.take === 27730);
  ok("รวมสาขา b2 สุทธิ = 29250", bl2.totals.take === 29250);
  ok("รวมบริษัท สุทธิ = 19000+8730+29250", c.totals.take === 56980);

  console.log("\nbranch scope → 1 สาขา:");
  const docB = doclib.buildPayrollSummaryDoc("2026-09", { kind: "branch", id: b2 });
  ok("branch scope → 1 บริษัท 1 สาขา", docB.companies.length === 1 && docB.companies[0].branches.length === 1);
  ok("เป็นสาขา b2", docB.companies[0].branches[0].branchName === "HYPOPLARAEMIA");

  console.log("\nlistExportScopes / parseScope:");
  const scopes = doclib.listExportScopes(db, "2026-09");
  ok("มี all + company + branch", scopes.some((s) => s.kind === "all") && scopes.some((s) => s.kind === "company") && scopes.some((s) => s.kind === "branch"));
  ok("parseScope company:null", JSON.stringify(doclib.parseScope("company:null")) === JSON.stringify({ kind: "company", id: null }));
  ok("parseScope bad → null", doclib.parseScope("bogus:x") === null);

  console.log("\nrenderers:");
  const csv = doclib.renderPayrollSummaryCsv(doc, "6 ก.ย. 2569 12:00", "สำหรับ ภ.ง.ด.1");
  ok("CSV มี BOM", csv.charCodeAt(0) === 0xfeff);
  ok("CSV มีหัวข้อสาขา", csv.includes("◆ สาขา: NAMA PASTA SRIRACHA"));
  ok("CSV มีบล็อครอบจ่าย + ก่อนหัก/หัก/สุทธิ", csv.includes("ยอดก่อนหัก") && csv.includes("ยอดสุทธิ"));
  ok("CSV หักเป็นค่าติดลบ", csv.includes("-1000.00"));
  ok("CSV มีหมายเหตุ", csv.includes("สำหรับ ภ.ง.ด.1"));

  const xlsx = renderPayrollSummaryXlsx(doc, "6 ก.ย. 2569 12:00", null);
  ok("XLSX เป็น buffer (PK zip)", Buffer.isBuffer(xlsx) && xlsx[0] === 0x50 && xlsx[1] === 0x4b);

  const pdf = await generatePayrollSummaryPdf(doc, "6 ก.ย. 2569 12:00", "ส่งบัญชี");
  ok("PDF เริ่มด้วย %PDF", Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === "%PDF");

  console.log("\nempty month → no throw:");
  const empty = doclib.buildPayrollSummaryDoc("2026-01", { kind: "all" });
  ok("เดือนว่าง → 0 บริษัท", empty.companies.length === 0);
  ok("CSV เดือนว่างยัง render ได้", doclib.renderPayrollSummaryCsv(empty, "x").length > 0);

  console.log(`\ntest-payroll-summary-doc: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
