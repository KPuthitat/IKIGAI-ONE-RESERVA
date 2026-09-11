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

  // ── 8) FREEZE: a reviewed line survives a full recompute untouched ──
  // (owner 2026-09-02: "ติ๊กตรวจแล้ว เวลาออกจากหน้านี้ ข้อมูลต้องไม่เปลี่ยน").
  // Sign the line off AND tamper its stored numbers; a full recompute must keep
  // both the tampered figures and the review, and report it as locked.
  db.prepare(
    "UPDATE payroll_lines SET reviewed_at = CURRENT_TIMESTAMP, reviewed_by = 1, base_pay = 999, gross_pay = 999, net_pay = 999 WHERE period_id=? AND user_id=?"
  ).run(pid, d1);
  const frozenRes = payroll.computePayrollPeriod(db, pid);
  const dLine3 = db.prepare("SELECT base_pay, gross_pay, net_pay, reviewed_at FROM payroll_lines WHERE period_id=? AND user_id=?").get(pid, d1) as
    { base_pay: number; gross_pay: number; net_pay: number; reviewed_at: string | null };
  ok("freeze: reviewed line keeps its stored numbers (999)", near(dLine3.base_pay, 999) && near(dLine3.gross_pay, 999) && near(dLine3.net_pay, 999));
  ok("freeze: reviewed line stays reviewed after recompute", dLine3.reviewed_at != null);
  ok("freeze: recompute reports locked >= 1", frozenRes.locked >= 1);
  // Un-tick → the next recompute recomputes it back to the real DF figures.
  db.prepare("UPDATE payroll_lines SET reviewed_at = NULL, reviewed_by = NULL WHERE period_id=? AND user_id=?").run(pid, d1);
  payroll.computePayrollPeriod(db, pid);
  const dLine4 = db.prepare("SELECT base_pay, other_additions, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?").get(pid, d1) as
    { base_pay: number; other_additions: number; net_pay: number };
  ok("unlock: recompute restores real DF figures (base 0, add 300, net 300)", near(dLine4.base_pay, 0) && near(dLine4.other_additions, 300) && near(dLine4.net_pay, 300));

  // ── 9) WEEKLY ROUNDS: daily revenue → Monday cut → pay + WHT → accounta ──
  // (owner 2026-09-11: pay DF via a weekly transfer that posts to accounta,
  // instead of through payroll). Weeks must be on/after DF_WEEKLY_START_DATE
  // (2026-10-05, a Monday). d1 is a clinic doctor; give a 3% WHT rate and put
  // HSC 1000 net on 2026-10-07 (a Wednesday) → 30% = 300 fee, rostered that day.
  const rounds = await import("../src/lib/df-rounds");
  ok("setDoctorWhtRate 3%", df.setDoctorWhtRate(d1, 0.03));
  df.importInvoiceLines(bid, [
    { invoiceNo: "W1", lineDate: "2026-10-07", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 1000, discount: 0, net: 1000 }
  ], "wk.xlsx");
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, "2026-10-07", p1, d1, sc);

  // week helpers snap to Monday.
  ok("mondayOf(2026-10-07 Wed) = 2026-10-05", rounds.mondayOf("2026-10-07") === "2026-10-05");
  ok("sundayOf(2026-10-07) = 2026-10-11", rounds.sundayOf("2026-10-07") === "2026-10-11");

  // preview: gross 300, WHT 9 (3%), net 291.
  const pv = rounds.previewDfRound(bid, "2026-10-07");
  ok("preview snaps to the Mon–Sun week", pv.weekStart === "2026-10-05" && pv.weekEnd === "2026-10-11");
  ok("preview totals: fee 300, wht 9, net 291", near(pv.totalFee, 300) && near(pv.totalWht, 9) && near(pv.totalNet, 291));
  const pvDoc = pv.doctors.find((x) => x.user_id === d1);
  ok("preview doctor: gross 300 / wht 9 / net 291", !!pvDoc && near(pvDoc.grossFee, 300) && near(pvDoc.whtAmount, 9) && near(pvDoc.netFee, 291));
  ok("preview: no stored round yet, on/after cutover", pv.round === null && pv.stale === false && pv.beforeCutover === false);

  // save (draft) → snapshot.
  const saved = rounds.saveDfRound(bid, "2026-10-07", 1);
  ok("save: draft round with totals", saved.status === "draft" && near(saved.total_fee, 300) && near(saved.total_net, 291));
  ok("save: one snapshot line", rounds.listRoundLines(saved.id).length === 1);
  ok("getRound resolves by any in-week date", rounds.getRound(bid, "2026-10-09")?.id === saved.id);

  // pay → paid + posts to accounta (expense 291 paid, WHT 9 payable).
  const paid = rounds.payDfRound(bid, "2026-10-07", 1);
  ok("pay: status paid + paid_at stamped", paid.status === "paid" && paid.paid_at != null);
  const dfExp = db.prepare("SELECT category, amount_total, payment_status FROM accounta_expenses WHERE df_round_id=? ORDER BY category").all(saved.id) as Array<{ category: string; amount_total: number; payment_status: string }>;
  ok("accounta: exactly 2 rows tagged df_round_id", dfExp.length === 2);
  const feeRow = dfExp.find((r) => r.category === "ค่าตอบแทนแพทย์ (DF)");
  const whtRow = dfExp.find((r) => r.category === "ภาษีหัก ณ ที่จ่าย");
  ok("accounta: DF expense 291 paid", !!feeRow && near(feeRow.amount_total, 291) && feeRow.payment_status === "paid");
  ok("accounta: WHT payable 9 unpaid", !!whtRow && near(whtRow.amount_total, 9) && whtRow.payment_status === "unpaid");

  // re-pay is idempotent (delete-then-insert): still exactly 2 rows.
  rounds.payDfRound(bid, "2026-10-07", 1);
  ok("re-pay idempotent: still 2 accounta rows", (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE df_round_id=?").get(saved.id) as { n: number }).n === 2);

  // stale: revenue re-imported after payment → live recompute differs from the
  // frozen snapshot, flagged for the admin.
  df.importInvoiceLines(bid, [
    { invoiceNo: "W2", lineDate: "2026-10-08", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 500, discount: 0, net: 500 }
  ], "late.xlsx");
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, "2026-10-08", p1, d1, sc);
  ok("stale: paid round flagged when revenue changes under it", rounds.previewDfRound(bid, "2026-10-07").stale === true);

  // revert → draft + un-post accounta.
  const reverted = rounds.revertDfRound(bid, "2026-10-07");
  ok("revert: back to draft", reverted?.status === "draft" && reverted?.paid_at == null);
  ok("revert: accounta rows removed", (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE df_round_id=?").get(saved.id) as { n: number }).n === 0);

  // re-cut after revert picks up the corrected revenue (Oct 7 300 + Oct 8 150 = 450 fee).
  const recut = rounds.payDfRound(bid, "2026-10-07", 1);
  ok("re-cut after revert: fee 450, net 436.5", near(recut.total_fee, 450) && near(recut.total_net, 436.5));
  ok("accounta re-posts after re-cut", (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE df_round_id=?").get(saved.id) as { n: number }).n === 2);

  // paid rounds cannot be silently re-cut via save (must revert first).
  let refused = false;
  try { rounds.saveDfRound(bid, "2026-10-07", 1); } catch { refused = true; }
  ok("save refuses to edit a paid round", refused);

  // A clinic doctor NOT on DF comp (no df_started_at) must be EXCLUDED from the
  // weekly round — payroll still pays them ค่าเวร, so paying here would double-pay.
  // d2 is a clinical doctor with df_started_at still NULL at this point.
  df.importInvoiceLines(bid, [
    { invoiceNo: "Q1", lineDate: "2026-10-14", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 200, discount: 0, net: 200 }
  ], "w2.xlsx");
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, "2026-10-14", p2, d2, sc);
  ok("non-DF clinic doctor excluded (no df_started_at)", rounds.previewDfRound(bid, "2026-10-14").doctors.length === 0);

  // Put d2 on DF comp with a 0% WHT rate → now paid weekly; net = gross, no WHT row.
  db.prepare("UPDATE users SET df_wht_rate = 0, df_started_at = '2026-10-01' WHERE id = ?").run(d2);
  const w2 = rounds.payDfRound(bid, "2026-10-14", 1);   // Oct 14 = Wed, week of Oct 12
  ok("0% WHT: net = gross 60, no WHT withheld", near(w2.total_fee, 60) && near(w2.total_wht, 0) && near(w2.total_net, 60));
  ok("0% WHT: one accounta row (expense only)", (db.prepare("SELECT COUNT(*) n FROM accounta_expenses WHERE df_round_id=?").get(w2.id) as { n: number }).n === 1);
  ok("two distinct weekly rounds exist", rounds.listRounds(bid).length === 2);

  // ── 10) CUTOVER: payroll ↔ weekly split (no double-pay, no gap) ──
  // The effective cutover is snapped to a Monday so the boundary is clean even if
  // the constant is set to a mid-week date.
  ok("cutover snaps to a Monday", df.dfWeeklyStartMonday() === "2026-10-05");
  // dfPayrollEnd clamps how much DF payroll still folds in.
  ok("cutover: fully pre-cutover month → full period", df.dfPayrollEnd("2026-08-01", "2026-08-31") === "2026-08-31");
  ok("cutover: straddling month → clamped to the day before", df.dfPayrollEnd("2026-10-01", "2026-10-31") === "2026-10-04");
  ok("cutover: fully post-cutover month → null (no payroll DF)", df.dfPayrollEnd("2026-11-01", "2026-11-30") === null);

  // Weekly program refuses a week before the cutover (would double-pay payroll).
  let preRefused = false;
  try { rounds.saveDfRound(bid, "2026-09-30", 1); } catch { preRefused = true; }
  ok("cutover: weekly round refused before cutover", preRefused);
  ok("cutover: preview still viewable + flags beforeCutover", rounds.previewDfRound(bid, "2026-09-30").beforeCutover === true);

  // Integration: an October clinic payroll period pays DF ONLY for pre-cutover
  // days (Oct 1–4). Put HSC 400 net on Oct 2 (Fri, pre-cutover) → 120 fee; the
  // Oct 7 revenue (paid via the weekly round above) must NOT appear in payroll.
  df.importInvoiceLines(bid, [
    { invoiceNo: "PC1", lineDate: "2026-10-02", itemCode: "GEN001", tag: "HSC", description: "[HSC]", qty: 1, gross: 400, discount: 0, net: 400 }
  ], "pre.xlsx");
  db.prepare("INSERT INTO roster_assignments (branch_id,assignment_date,position_id,user_id,shift_code_id) VALUES (?,?,?,?,?)").run(bid, "2026-10-02", p1, d1, sc);
  const octPid = Number(db.prepare(
    "INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-10-01','2026-10-31','2026-11-05','draft',?,'ft','auto')"
  ).run(bid).lastInsertRowid);
  payroll.computePayrollPeriod(db, octPid);
  const octLine = db.prepare("SELECT base_pay, other_additions, net_pay FROM payroll_lines WHERE period_id=? AND user_id=?").get(octPid, d1) as
    { base_pay: number; other_additions: number; net_pay: number } | undefined;
  ok("cutover: Oct payroll folds DF for pre-cutover days only (120)", !!octLine && near(octLine.other_additions, 120) && near(octLine.base_pay, 0));

  console.log(`\ndf test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
