// สร้างเอกสารสรุปค่าตอบแทน (owner 2026-09-06).
//
// Proves buildPayrollSummaryDoc aggregates per company/branch with the pay-round
// list + marked deductions, and that all three renderers (CSV / XLSX / PDF)
// produce valid output without throwing.
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

  // ── Fixture: one company, one branch, FT (sso) + PT (wht) ─────────────
  const co = Number(db.prepare("INSERT INTO companies (name_th, tax_id) VALUES ('บริษัท อิคิไก จำกัด','0105500000001')").run().lastInsertRowid);
  const branch = Number(db.prepare("INSERT INTO branches (slug,name,company_id,status) VALUES ('nama','NAMA',?, 'open')").run(co).lastInsertRowid);
  const mkUser = (name: string, type: "ft" | "pt") => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type) VALUES (?,?,?,'staff','active',?)"
  ).run(name, "x", name, type).lastInsertRowid);
  const ftUser = mkUser("สมชาย", "ft"), ptUser = mkUser("สมหญิง", "pt");
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?,?,1)").run(ftUser, branch);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_primary) VALUES (?,?,1)").run(ptUser, branch);

  const per = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,target,data_source,period_start,period_end,pay_date,status,branch_id) VALUES ('monthly','ft','auto','2026-09-01','2026-09-30','2026-09-30','finalized',?)"
  ).run(branch).lastInsertRowid);
  const mkLine = (uid: number, name: string, type: string, taxMode: string, gross: number, sso: number, tax: number, net: number) =>
    db.prepare(`INSERT INTO payroll_lines
      (period_id,user_id,employee_code,display_name,employment_type,pay_cycle_snapshot,
       hourly_rate_snapshot,monthly_salary_snapshot,salary_tax_mode_snapshot,
       base_pay,ot_pay,service_charge,other_additions,gross_pay,sso_amount,tax_amount,other_deductions,net_pay,days_worked,leave_days)
      VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?,?)`)
      .run(per, uid, "E" + uid, name, type, "monthly", null, gross, taxMode, gross, 0, 0, 0, gross, sso, tax, 0, net, 20, 0);
  mkLine(ftUser, "สมชาย", "ft", "sso", 20000, 750, 0, 19250);
  mkLine(ptUser, "สมหญิง", "pt", "wht", 9000, 0, 270, 8730);

  console.log("buildPayrollSummaryDoc (scope=all):");
  const docAll = doclib.buildPayrollSummaryDoc("2026-09", { kind: "all" });
  ok("มี 1 ส่วน (บริษัทเดียว)", docAll.sections.length === 1);
  const sec = docAll.sections[0];
  ok("ชื่อบริษัทถูก + เลขผู้เสียภาษีติดมา", sec.title.includes("อิคิไก") && sec.taxId === "0105500000001");
  ok("มีพนักงาน 2 คน", sec.rows.length === 2);
  ok("เรียง FT ก่อน PT", sec.rows[0].empTypeLabel.startsWith("ประจำ") && sec.rows[1].empTypeLabel.startsWith("พาร์ท"));
  ok("ค่าตอบแทนรวม = 29000", sec.totals.comp === 29000);
  ok("ประกันสังคมรวม = 750 (เป็นรายหัก)", sec.totals.sso === 750);
  ok("ภาษีรวม = 270", sec.totals.tax === 270);
  ok("รวมรับจริง = 19250 + 8730", sec.totals.take === 27980);
  ok("มีรอบจ่าย 1 รอบ", sec.payRounds.length === 1 && sec.payRounds[0].payDate === "2026-09-30");
  ok("เดือน label ไทย", docAll.monthLabel === "กันยายน 2569");

  console.log("\nscope=company / branch:");
  const docCo = doclib.buildPayrollSummaryDoc("2026-09", { kind: "company", id: co });
  ok("company scope → 1 ส่วน + ยอดตรงกัน", docCo.sections.length === 1 && docCo.sections[0].totals.comp === 29000);
  const docBr = doclib.buildPayrollSummaryDoc("2026-09", { kind: "branch", id: branch });
  ok("branch scope → 1 ส่วน + ยอดตรงกัน", docBr.sections.length === 1 && docBr.sections[0].totals.comp === 29000);

  console.log("\nlistExportScopes / parseScope:");
  const scopes = doclib.listExportScopes(db, "2026-09");
  ok("มี all + company + branch", scopes.some((s) => s.kind === "all") && scopes.some((s) => s.kind === "company") && scopes.some((s) => s.kind === "branch"));
  ok("parseScope company:null → id null", JSON.stringify(doclib.parseScope("company:null")) === JSON.stringify({ kind: "company", id: null }));
  ok("parseScope branch:5 → id 5", JSON.stringify(doclib.parseScope("branch:5")) === JSON.stringify({ kind: "branch", id: 5 }));
  ok("parseScope bad → null", doclib.parseScope("bogus:x") === null);

  console.log("\nrenderers:");
  const csv = doclib.renderPayrollSummaryCsv(docAll, "6 ก.ย. 2569 12:00", "สำหรับ ภ.ง.ด.1");
  ok("CSV มี BOM", csv.charCodeAt(0) === 0xfeff);
  ok("CSV มีหัวข้อรายหัก + ค่าติดลบ", csv.includes("ประกันสังคม (หัก)") && csv.includes("-750.00"));
  ok("CSV มีบล็อครอบจ่าย", csv.includes("รอบจ่ายที่กระทบยอดในเดือนนี้"));
  ok("CSV มีหมายเหตุ", csv.includes("สำหรับ ภ.ง.ด.1"));

  const xlsx = renderPayrollSummaryXlsx(docAll, "6 ก.ย. 2569 12:00", null);
  ok("XLSX เป็น buffer (PK zip)", Buffer.isBuffer(xlsx) && xlsx[0] === 0x50 && xlsx[1] === 0x4b);

  const pdf = await generatePayrollSummaryPdf(docAll, "6 ก.ย. 2569 12:00", "ส่งบัญชี");
  ok("PDF เริ่มด้วย %PDF", Buffer.isBuffer(pdf) && pdf.subarray(0, 4).toString() === "%PDF");

  console.log("\nempty month → no throw:");
  const empty = doclib.buildPayrollSummaryDoc("2026-01", { kind: "all" });
  ok("เดือนว่าง → 0 ส่วน", empty.sections.length === 0);
  ok("CSV เดือนว่างยัง render ได้", doclib.renderPayrollSummaryCsv(empty, "x").length > 0);

  console.log(`\ntest-payroll-summary-doc: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})();
