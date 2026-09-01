// Doctor Fee (DF) proof — parser + import + roster-attribution compute.
//
// Self-contained: builds its own throwaway DB with a clinic branch, a rule,
// two doctors and a roster, then proves:
//   • the .xlsx parser matches the leading [TAG], parses Buddhist dates, and
//     skips non-earning lines
//   • importInvoiceLines is idempotent (re-import → all updated, no dupes)
//   • computeDoctorFees splits each day's HSC×rate across the rostered doctors
//     (equal split on shared days), reconciles, and flags unassigned days
//
// Run:  node --import tsx scripts/test-df.ts   (or: npm run test:df)

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const TMP = path.join(process.cwd(), "data", "test-df.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const parse = await import("../src/lib/df-invoice-parse");
  const df = await import("../src/lib/df-db");

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

  // ── 1) pure helpers ──
  ok("parseThaiDate Buddhist", parse.parseThaiDate("01/08/2569") === "2026-08-01");
  ok("parseThaiDate Gregorian", parse.parseThaiDate("01/08/2026") === "2026-08-01");
  ok("parseThaiDate junk → null", parse.parseThaiDate("-") === null);
  ok("leadingTag HSC", parse.leadingTag("[HSC] ค่าบริการ") === "HSC");
  ok("leadingTag drug bin", parse.leadingTag("[#D1Y][NSAIDs] Ibup") === "#D1Y");

  // ── 2) parser on an in-memory workbook ──
  const aoa = [
    ["เลขที่ใบแจ้งหนี้", "วัน", "รหัส", "รายการ", "จำนวน", "ราคารวม", "ส่วนลด", "ราคาสุทธิ"],
    ["BL1", "01/08/2569", "GEN001", "[HSC] ค่าบริการผู้ป่วยนอก", 1, 300, 0, 300],
    ["BL1", "01/08/2569", "IKGPH/A1", "[#D1Y][NSAIDs] Ibuprofen", 10, 70, 10.5, 59.5],   // drug → skip
    ["BL2", "02/08/2569", "GEN002", "[HSC-GRP] ค่าบริการ (ประกันกลุ่ม)", 1, 300, 0, 300],
    ["BL3", "03/08/2569", "GEN001", "[HSC] ค่าบริการ (ลดเต็ม)", 1, 300, 300, 0]           // waived → net 0
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Invoice Report");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const parsed = parse.parseInvoiceBuffer(buf, ["HSC", "HSC-GRP"]);
  ok("parser keeps only tagged service lines", parsed.lines.length === 3);
  ok("parser skips drug line", parsed.lines.every((l) => l.tag === "HSC" || l.tag === "HSC-GRP"));
  ok("parser net sum = 600 (waived counts 0)", near(parsed.lines.reduce((s, l) => s + l.net, 0), 600));
  ok("parser period span", parsed.periodStart === "2026-08-01" && parsed.periodEnd === "2026-08-03");

  // ── 3) fixtures ──
  const db = getDb();
  const bid = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('c','CLINIC')").run().lastInsertRowid);
  db.prepare("UPDATE branches SET df_enabled = 1 WHERE id = ?").run(bid);
  db.prepare(`INSERT INTO df_fee_rules (branch_id,name,item_tags,rate,active,sort_order) VALUES (?,'HSC','["HSC","HSC-GRP"]',0.30,1,0)`).run(bid);
  ok("isDfBranch true", df.isDfBranch(bid));
  ok("wantedTags from active rule", df.wantedTags(bid).sort().join(",") === "HSC,HSC-GRP");

  const d1 = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,clinical_role,status) VALUES ('doc1','x','หมอเอ','admin','doctor','active')").run().lastInsertRowid);
  const d2 = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,clinical_role,status) VALUES ('doc2','x','หมอบี','admin','doctor','active')").run().lastInsertRowid);
  const sc = Number(db.prepare("INSERT INTO shift_codes (branch_id,code,name,start_time,end_time,kind,active) VALUES (?,'D','Day','09:00','17:00','work',1)").run(bid).lastInsertRowid);
  const p1 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title,active) VALUES (?,'แพทย์',1)").run(bid).lastInsertRowid);
  const p2 = Number(db.prepare("INSERT INTO roster_positions (branch_id,title,active) VALUES (?,'แพทย์2',1)").run(bid).lastInsertRowid);
  const roster = (uid: number, date: string, pos: number) =>
    db.prepare("INSERT OR REPLACE INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, date, pos, uid, sc);

  // ── 4) import (idempotent) ──
  const imp = df.importInvoiceLines(bid, parsed.lines, "mem.xlsx");
  ok("import inserted 3", imp.inserted === 3 && imp.updated === 0);
  const imp2 = df.importInvoiceLines(bid, parsed.lines, "mem.xlsx");
  ok("re-import all updated (no dupes)", imp2.inserted === 0 && imp2.updated === 3);
  ok("line store has exactly 3", (db.prepare("SELECT COUNT(*) n FROM df_invoice_lines WHERE branch_id=?").get(bid) as { n: number }).n === 3);

  // ── 5) compute ──
  // Roster: Aug 1 → d1 only; Aug 2 → d1 & d2 (shared); Aug 3 → nobody.
  roster(d1, "2026-08-01", p1);
  roster(d1, "2026-08-02", p1);
  roster(d2, "2026-08-02", p2);
  const res = df.computeDoctorFees(bid, "2026-08-01", "2026-08-31");
  ok("pool 600, fee 180 (30%)", near(res.totalPool, 600) && near(res.totalFee, 180));
  // Aug1 pool 300 → fee 90 → d1. Aug2 pool 300 → fee 90 → split d1/d2 = 45 each.
  // Aug3 pool 0 (waived) → fee 0, no unassigned.
  const feeOf = (uid: number) => res.doctors.find((x) => x.user_id === uid)?.totalFee ?? 0;
  ok("d1 = 90 + 45 = 135", near(feeOf(d1), 135));
  ok("d2 = 45 (shared day only)", near(feeOf(d2), 45));
  ok("assigned = 180, unassigned = 0", near(res.assignedFee, 180) && near(res.unassignedFee, 0));
  ok("reconcile: assigned+unassigned = totalFee", near(res.assignedFee + res.unassignedFee, res.totalFee));
  ok("reconcile: Σ doctor fees = assigned", near(res.doctors.reduce((s, d) => s + d.totalFee, 0), res.assignedFee));
  ok("shared day marked doctorCount=2", (res.doctors.find((x) => x.user_id === d1)?.days.find((dd) => dd.date === "2026-08-02")?.doctorCount) === 2);

  // Unassigned: move a revenue day to a date with no doctor rostered.
  db.prepare("UPDATE df_invoice_lines SET line_date='2026-08-10' WHERE invoice_no='BL2' AND branch_id=?").run(bid);
  const res2 = df.computeDoctorFees(bid, "2026-08-01", "2026-08-31");
  ok("moving a day off-roster creates an unassigned bucket", res2.unassignedDays.length === 1 && near(res2.unassignedFee, 90));
  ok("branch scoping: other branch sees nothing", df.computeDoctorFees(bid + 9999, "2026-08-01", "2026-08-31").totalPool === 0);

  // ── 6) multiple rules, DIFFERENT rates (owner 2026-08: หัตถการแต่ละอย่าง % ไม่เท่ากัน) ──
  // Reset lines, add an IM procedure rule at 40% alongside HSC 30%.
  db.prepare("DELETE FROM df_invoice_lines WHERE branch_id=?").run(bid);
  db.prepare(`INSERT INTO df_fee_rules (branch_id,name,item_tags,rate,active,sort_order) VALUES (?,'ฉีดยา (IM)','["IM"]',0.40,1,1)`).run(bid);
  df.importInvoiceLines(bid, [
    { invoiceNo: "X1", lineDate: "2026-08-01", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 1000, discount: 0, net: 1000 },
    { invoiceNo: "X1", lineDate: "2026-08-01", itemCode: "NUR", tag: "IM", description: "[IM]", qty: 1, gross: 500, discount: 0, net: 500 }
  ], "mix.xlsx");
  const res3 = df.computeDoctorFees(bid, "2026-08-01", "2026-08-31");
  // HSC 1000×30% = 300, IM 500×40% = 200 → fee 500, all to d1 (rostered Aug 1).
  ok("mixed rates: fee = 300 + 200 = 500", near(res3.totalFee, 500));
  ok("mixed rates: HSC rule fee = 300", near(res3.rules.find((r) => r.name === "HSC")?.fee ?? -1, 300));
  ok("mixed rates: IM rule fee = 200", near(res3.rules.find((r) => r.name === "ฉีดยา (IM)")?.fee ?? -1, 200));
  ok("mixed rates: d1 gets all 500", near(res3.doctors.find((x) => x.user_id === d1)?.totalFee ?? 0, 500));

  // ── 7) ORCHESTRATOR: computePayrollPeriod auto-folds DF into the line ──
  // A DF doctor (df_started_at set, FT with no salary) rostered at the clinic
  // for a monthly period must get a payroll line with base=0 and the DF sitting
  // in other_additions (= gross = net, no withholding).
  const payroll = await import("../src/lib/payroll-compute");
  // Make d1 a DF doctor from Aug: FT, no salary, df_started_at, clinical doctor.
  db.prepare("UPDATE users SET employment_type='ft', monthly_salary=0, df_started_at='2026-08-01', clinical_role='doctor' WHERE id=?").run(d1);
  db.prepare("INSERT OR IGNORE INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(d1, bid);
  // Clean, known invoice: HSC 1000 net on Aug 5 → 30% = 300.
  db.prepare("DELETE FROM df_invoice_lines WHERE branch_id=?").run(bid);
  db.prepare("DELETE FROM df_fee_rules WHERE branch_id=?").run(bid);
  db.prepare(`INSERT INTO df_fee_rules (branch_id,name,item_tags,rate,active,sort_order) VALUES (?,'HSC','["HSC"]',0.30,1,0)`).run(bid);
  df.importInvoiceLines(bid, [
    { invoiceNo: "P1", lineDate: "2026-08-05", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 1000, discount: 0, net: 1000 }
  ], "p.xlsx");
  // Roster d1 on Aug 5 at the clinic.
  db.prepare("DELETE FROM roster_assignments WHERE branch_id=?").run(bid);
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, "2026-08-05", p1, d1, sc);
  // A draft monthly payroll period for the clinic covering August.
  const pid = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-08-01','2026-08-31','2026-09-05','draft',?,'ft','auto')"
  ).run(bid).lastInsertRowid);
  payroll.computePayrollPeriod(db, pid);
  const dLine = db.prepare("SELECT base_pay, ot_pay, other_additions, gross_pay, sso_amount, tax_amount, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?").get(pid, d1) as
    { base_pay: number; ot_pay: number; other_additions: number; gross_pay: number; sso_amount: number; tax_amount: number; net_pay: number } | undefined;
  ok("orchestrator: DF doctor got a payroll line", !!dLine);
  if (dLine) {
    ok("orchestrator: base_pay = 0 (no ค่าเวร)", near(dLine.base_pay, 0));
    ok("orchestrator: other_additions = DF 300", near(dLine.other_additions, 300));
    ok("orchestrator: gross = 300", near(dLine.gross_pay, 300));
    ok("orchestrator: no WHT / no SSO", near(dLine.tax_amount, 0) && near(dLine.sso_amount, 0));
    ok("orchestrator: net = 300 (จ่ายเต็ม)", near(dLine.net_pay, 300));
  }
  // recomputeLine (single user) keeps DF too.
  payroll.recomputeLine(db, pid, d1);
  const dLine2 = db.prepare("SELECT base_pay, other_additions, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?").get(pid, d1) as
    { base_pay: number; other_additions: number; net_pay: number };
  ok("recomputeLine keeps DF (base 0, add 300, net 300)", near(dLine2.base_pay, 0) && near(dLine2.other_additions, 300) && near(dLine2.net_pay, 300));

  console.log(`\ndf test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
