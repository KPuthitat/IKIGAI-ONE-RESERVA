// CLINICA → ACCOUNTA income posting tests (owner 2026-10-04): sales by invoice
// date, channel split from receipts, receivables per bill that only turn into cash
// on a CONFIRMED settlement, shift-close supersede, idempotent re-post.
// Run:  node --import tsx scripts/test-clinica-accounta.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-clinica-accounta.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const A = await import("../src/lib/clinica-accounta");
  const acc = await import("../src/lib/accounta-db");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('AT HOME CLINIC')").run().lastInsertRowid);
  const br = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('clinic','AT HOME',?)").run(co).lastInsertRowid);
  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('adm','x','Adm','admin','active')").run().lastInsertRowid);

  const bill = (no: string, date: string, payer: string, net: number, due: number) =>
    db.prepare("INSERT INTO clinica_bills (branch_id,bill_no,bill_date,payer_group,net,paid,due) VALUES (?,?,?,?,?,?,?)").run(br, no, date, payer, net, net - due, due);
  const receipt = (no: string, billNo: string, date: string, channel: string, paid: number, outstanding = 0) =>
    db.prepare("INSERT INTO clinica_receipts (branch_id,receipt_no,installment,bill_no,receipt_date,channel,paid,outstanding) VALUES (?,?,1,?,?,?,?,?)").run(br, no, billNo, date, channel, paid, outstanding);
  const settle = (billNo: string, billDate: string, amount: number, status: "pending" | "confirmed", settled: string, channel: string | null = null) =>
    Number(db.prepare("INSERT INTO clinica_settlements (branch_id,bill_no,bill_date,payer_group,amount,detected_on,settled_date,channel,status) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(br, billNo, billDate, "ประกันกลุ่ม เอ", amount, settled, settled, channel, status).lastInsertRowid);
  const rows = (where = "1=1", ...a: unknown[]) => db.prepare(`SELECT * FROM accounta_income WHERE branch_id=? AND source='clinic' AND ${where} ORDER BY income_date, ref`).all(br, ...a) as Array<{ income_date: string; channel: string | null; amount: number; is_outstanding: number; settled_date: string | null; ref: string }>;
  const sum = (rs: Array<{ amount: number }>) => rs.reduce((s, r) => s + r.amount, 0);

  const CASH = "เงินสด (เงินสด)", BANK = "ธนาคาร (ธนาคารกสิกรไทย KSHOP)", INS = "อื่นๆ (ประกันกลุ่ม เอ)";
  // 09-01: two counter payments + one insurer bill; 09-02: a bill with no receipt imported yet.
  bill("A", "2026-09-01", "ผู้ป่วยทั่วไป", 1000, 0); receipt("R-A", "A", "2026-09-01", CASH, 1000);
  bill("B", "2026-09-01", "ผู้ป่วยทั่วไป", 865, 0);  receipt("R-B", "B", "2026-09-01", BANK, 865);
  bill("C", "2026-09-01", "ประกันกลุ่ม เอ", 1200, 1200); receipt("R-C", "C", "2026-09-01", INS, 0, 1200);
  bill("D", "2026-09-02", "ผู้ป่วยทั่วไป", 500, 0);

  // The shift-close mirror already put a lump + channelled rows on 09-01 (and a lump on 09-05, untouched).
  acc.replaceShiftCloseIncome(br, "2026-09-01", uid, [{ channel: "เงินสด", amount: 999 }, { channel: null, amount: 3065 }]);
  acc.replaceShiftCloseIncome(br, "2026-09-05", uid, [{ channel: null, amount: 700 }]);

  ok("switch is off by default", A.isClinicaAutopost(br) === false);
  const r1 = A.postClinicaToAccounta(br, uid);
  ok("post: 2 days", r1.days === 2);
  const d1 = rows("income_date='2026-09-01'");
  ok("09-01 cash by channel: เงินสด 1000 + KSHOP 865", d1.some((r) => r.channel === "เงินสด" && near(r.amount, 1000) && r.is_outstanding === 0) && d1.some((r) => r.channel === "ธนาคารกสิกรไทย KSHOP" && near(r.amount, 865)));
  const open = d1.find((r) => r.ref === "C#open")!;
  ok("09-01 insurer bill = receivable row under the payer, open", !!open && open.channel === "ประกันกลุ่ม เอ" && near(open.amount, 1200) && open.is_outstanding === 1 && open.settled_date === null);
  ok("09-01 sales (accrual) = 3,065", near(sum(d1), 3065));
  ok("09-02 bill without a receipt → posted with no channel", rows("income_date='2026-09-02'").length === 1 && rows("income_date='2026-09-02'")[0].channel === null && near(r1.unknownChannelAmount, 500));
  ok("shift-close rows of covered days are superseded; other days untouched", (db.prepare("SELECT COUNT(*) n FROM accounta_income WHERE branch_id=? AND source='shift_close' AND income_date='2026-09-01'").get(br) as { n: number }).n === 0
    && (db.prepare("SELECT COUNT(*) n FROM accounta_income WHERE branch_id=? AND source='shift_close' AND income_date='2026-09-05'").get(br) as { n: number }).n === 1 && r1.supersededShiftCloseDays === 1);
  ok("a later shift-close submit cannot re-add rows on a clinic day", (acc.replaceShiftCloseIncome(br, "2026-09-01", uid, [{ channel: null, amount: 5000 }]), (db.prepare("SELECT COUNT(*) n FROM accounta_income WHERE branch_id=? AND source='shift_close' AND income_date='2026-09-01'").get(br) as { n: number }).n === 0));
  ok("channels registered; payer channel flagged credit", (db.prepare("SELECT is_credit c FROM accounta_income_channels WHERE branch_id=? AND name='ประกันกลุ่ม เอ'").get(br) as { c: number } | undefined)?.c === 1);

  // Idempotent.
  const before = rows().length;
  A.postClinicaToAccounta(br, uid);
  ok("re-post is idempotent (same rows, no doubling)", rows().length === before && near(sum(rows("income_date='2026-09-01'")), 3065));

  // A detected-but-unconfirmed payment must NOT turn the receivable into cash.
  const pend = settle("C", "2026-09-01", 1200, "pending", "2026-09-20");
  A.postClinicaToAccounta(br, uid);
  ok("pending settlement: receivable stays open", rows("ref='C#open'").length === 1 && rows("ref='C#open'")[0].settled_date === null && near(sum(rows("income_date='2026-09-01'")), 3065));

  // Confirm it → settled row dated by the confirmed date; accrual unchanged.
  db.prepare("UPDATE clinica_settlements SET status='confirmed', settled_date='2026-09-18', channel=? WHERE id=?").run(BANK, pend);
  A.postClinicaToAccounta(br, uid, { from: "2026-09-01", to: "2026-09-01" });
  const cs = rows(`ref='C#s${pend}'`)[0];
  ok("confirmed: settled row with the confirmed date, no open row left", !!cs && cs.settled_date === "2026-09-18" && near(cs.amount, 1200) && rows("ref='C#open'").length === 0);
  ok("accrual of 09-01 still 3,065 (income_date = bill date)", near(sum(rows("income_date='2026-09-01'")), 3065));
  ok("range re-post left 09-02 alone", rows("income_date='2026-09-02'").length === 1);

  // Partial confirmed settlement.
  bill("E", "2026-09-03", "ประกันกลุ่ม เอ", 800, 500); receipt("R-E", "E", "2026-09-03", INS, 0, 800);
  settle("E", "2026-09-03", 300, "confirmed", "2026-09-25", BANK);
  A.postClinicaToAccounta(br, uid);
  ok("partial: settled 300 + open 500", near(rows("ref LIKE 'E#s%'")[0].amount, 300) && near(rows("ref='E#open'")[0].amount, 500));

  // Counter payment + insurer share on one bill.
  bill("F", "2026-09-04", "ประกันกลุ่ม เอ", 1000, 400); receipt("R-F", "F", "2026-09-04", CASH, 600);
  A.postClinicaToAccounta(br, uid);
  const f = rows("income_date='2026-09-04'");
  ok("split bill: cash 600 + open 400", f.some((r) => r.channel === "เงินสด" && near(r.amount, 600)) && near(rows("ref='F#open'")[0].amount, 400));

  // Insurer paid later and the HIS back-dated a bank receipt to the service day: the late
  // money must not also be counted as same-day cash.
  bill("G", "2026-09-04", "ประกันกลุ่ม เอ", 1000, 0); receipt("R-G1", "G", "2026-09-04", INS, 0, 1000); receipt("R-G2", "G", "2026-09-04", BANK, 1000);
  settle("G", "2026-09-04", 1000, "confirmed", "2026-09-28", BANK);
  A.postClinicaToAccounta(br, uid);
  const g = rows("income_date='2026-09-04'").filter((r) => r.ref.startsWith("G#") || r.ref.startsWith("cash"));
  ok("late payment with a back-dated receipt is a settled receivable, not extra same-day cash", rows("ref LIKE 'G#s%'").length === 1 && near(sum(rows("ref LIKE 'G#%'")), 1000) && !g.some((r) => r.ref === "cash:2026-09-04:ธนาคารกสิกรไทย KSHOP"));
  ok("day total for 09-04 = F 1000 + G 1000", near(sum(rows("income_date='2026-09-04'")), 2000));

  // A dismissed settlement is not a payment and changes nothing.
  db.prepare("INSERT INTO clinica_settlements (branch_id,bill_no,bill_date,payer_group,amount,detected_on,settled_date,status) VALUES (?,?,?,?,?,?,?,'dismissed')").run(br, "F", "2026-09-04", "ประกันกลุ่ม เอ", 400, "2026-09-30", "2026-09-30");
  A.postClinicaToAccounta(br, uid);
  ok("dismissed settlement ignored", near(rows("ref='F#open'")[0].amount, 400));

  // A bill that left the outstanding report (due 0) whose detected "payment" was DISMISSED
  // is not paid: it stays an open receivable and never becomes same-day cash.
  bill("H", "2026-09-06", "ประกันกลุ่ม เอ", 700, 0); receipt("R-H", "H", "2026-09-06", INS, 0, 700);
  db.prepare("INSERT INTO clinica_settlements (branch_id,bill_no,bill_date,payer_group,amount,detected_on,settled_date,status) VALUES (?,?,?,?,?,?,?,'dismissed')").run(br, "H", "2026-09-06", "ประกันกลุ่ม เอ", 700, "2026-10-01", "2026-10-01");
  A.postClinicaToAccounta(br, uid);
  ok("dismissed drop with no receipt proof stays open (not same-day cash)", near(rows("ref='H#open'")[0]?.amount ?? 0, 700) && rows("income_date='2026-09-06'").every((r) => r.is_outstanding === 1));

  // Existing channels are left exactly as the owner set them.
  db.prepare("UPDATE accounta_income_channels SET active=0, is_credit=0 WHERE branch_id=? AND name='ประกันกลุ่ม เอ'").run(br);
  A.postClinicaToAccounta(br, uid);
  const ch = db.prepare("SELECT active, is_credit FROM accounta_income_channels WHERE branch_id=? AND name='ประกันกลุ่ม เอ'").get(br) as { active: number; is_credit: number };
  ok("re-post does not reactivate / re-flag an existing channel", ch.active === 0 && ch.is_credit === 0);

  // ACCOUNTA side guards.
  const cOpen = db.prepare("SELECT id FROM accounta_income WHERE branch_id=? AND ref='F#open'").get(br) as { id: number };
  ok("ACCOUNTA cannot mark a clinic receivable collected", acc.settleReceivable(cOpen.id, br, "2026-10-01") === false);
  const manual = acc.createIncome(uid, { branch_id: br, company_id: co, income_date: "2026-09-10", channel: "x", amount: 100, note: null });
  db.prepare("UPDATE accounta_income SET is_outstanding=1 WHERE id=?").run(manual);
  ok("a manual receivable can still be settled there", acc.settleReceivable(manual, br, "2026-10-01") === true);
  ok("isClinicReceivable tells the clinic rows apart", acc.isClinicReceivable(cOpen.id, br) === true && acc.isClinicReceivable(manual, br) === false);
  ok("open receivable list carries the source", acc.listOutstandingReceivables(br).some((r) => r.source === "clinic"));

  // Shift-close cash check: cash the drawer should hold per the receipts of that day.
  const cdb = await import("../src/lib/clinica-db");
  const e1 = cdb.clinicaCashExpected(br, "2026-09-01");
  ok("expected drawer cash = cash receipts of the day (1,000), bank kept apart (865)", near(e1.cash, 1000) && near(e1.nonCash, 865) && e1.receipts === 3);
  const e0 = cdb.clinicaCashExpected(br, "2026-01-01");
  ok("a day with no receipt file reports receipts = 0", e0.receipts === 0 && e0.cash === 0);

  // Status + switch.
  A.setClinicaAutopost(br, true);
  const st = A.clinicaPostStatus(br);
  ok("status: enabled, posted days, open receivables", st.enabled && st.postedDays >= 4 && st.openReceivableCount >= 2 && st.openReceivable > 0);
  const auto = A.autopostClinicaIfEnabled(br, uid, { from: "2026-09-01", to: "2026-09-30" });
  ok("autopost runs when the switch is on", auto.posted != null && auto.error === undefined);
  A.setClinicaAutopost(br, false);
  ok("autopost does nothing when off", A.autopostClinicaIfEnabled(br, uid).posted === null);

  // Another branch is never touched.
  const br2 = Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('other','OTHER',?)").run(co).lastInsertRowid);
  A.postClinicaToAccounta(br2, uid);
  ok("posting for an empty branch writes nothing and leaves others alone", (db.prepare("SELECT COUNT(*) n FROM accounta_income WHERE branch_id=? AND source='clinic'").get(br2) as { n: number }).n === 0 && rows().length > 0);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
