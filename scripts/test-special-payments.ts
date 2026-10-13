// เงินช่วยเหลือพิเศษ / เบิกล่วงหน้า — ledger, advance cap, and folding into payroll lines.
// Run: node --import tsx scripts/test-special-payments.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-payments.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const SP = await import("../src/lib/special-payments");
  const { computePayrollPeriod, recomputeLine } = await import("../src/lib/payroll-compute");
  const { addLineDeduction } = await import("../src/lib/payroll-deductions");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const throws = (f: () => unknown, code: string) => { try { f(); return false; } catch (e) { return e instanceof SP.PaymentError && e.code === code; } };

  const mk = (u: string, mode: "wht" | "sso", type = "ft", status = "active") => Number(db.prepare(
    "INSERT INTO users (username,password_hash,display_name,role,status,employment_type,track_attendance,monthly_salary,hourly_rate,pay_cycle,salary_tax_mode) VALUES (?,?,?,'staff',?,?,1,?,?, 'monthly',?)"
  ).run(u, "x", u, status, type, type === "ft" ? 12000 : null, type === "pt" ? 100 : null, mode).lastInsertRowid);
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const wht = mk("wht", "wht"), sso = mk("sso", "sso"), pt = mk("pt", "wht", "pt");
  const gone = mk("gone", "wht", "ft", "resigned");

  // 10 worked days (1st-10th Sept) for wht + sso (9h each); pt works 3 days x 8h
  const clock = (uid: number, day: number, hours: number) => {
    const d = `2026-09-${String(day).padStart(2, "0")}`;
    const t = (h: number) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00+07:00`).toISOString();
    db.prepare("INSERT INTO time_entries (user_id, type, ts) VALUES (?, 'in', ?)").run(uid, t(9));
    db.prepare("INSERT INTO time_entries (user_id, type, ts) VALUES (?, 'out', ?)").run(uid, t(9 + hours));
  };
  for (let d = 1; d <= 10; d++) { clock(wht, d, 9); clock(sso, d, 9); }
  for (let d = 1; d <= 3; d++) clock(pt, d, 8);

  // ── advance cap ────────────────────────────────────────────────
  const lim = SP.advanceLimit(wht, "2026-09-11");
  ok("12,000 salary = 400 a day; 10 days worked → may draw 4,000 on the 11th", lim.basis === "salary" && lim.workedDays === 10 && near(lim.earned, 4000) && near(lim.available, 4000));
  ok("the day itself is not counted (draw on the 10th → 9 days = 3,600)", near(SP.advanceLimit(wht, "2026-09-10").earned, 3600));
  const ptLim = SP.advanceLimit(pt, "2026-09-11");
  ok("hourly staff: 24 hours × 100 = 2,400", ptLim.basis === "hourly" && near(ptLim.earned, 2400));
  ok("nobody has already drawn anything → taken is 0", lim.taken === 0);

  ok("a draw above the limit is refused and says what is left", (() => { try { SP.recordPayment({ userId: wht, kind: "advance", paidOn: "2026-09-11", amount: 4000.01, reason: "ขอเบิกล่วงหน้า", actorId: owner }); return false; } catch (e) { return e instanceof SP.PaymentError && e.code === "advance_exceeds_limit" && near((e.detail?.available ?? -1), 4000); } })());
  ok("a reason is required", throws(() => SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-11", amount: 100, reason: "  ", actorId: owner }), "reason_required"));
  ok("amount must be positive", throws(() => SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-11", amount: 0, reason: "ทดสอบ", actorId: owner }), "amount_invalid"));
  ok("future dates are refused", throws(() => SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2999-01-01", amount: 100, reason: "ทดสอบ", actorId: owner }), "date_in_future"));
  ok("resigned staff cannot be paid this way", throws(() => SP.recordPayment({ userId: gone, kind: "aid", paidOn: "2026-09-11", amount: 100, reason: "ทดสอบ", actorId: owner }), "user_not_active"));
  ok("an admin account is accepted as a payee (admins are employees too)", (() => { db.prepare("UPDATE users SET role='admin' WHERE id = ?").run(sso); const id = SP.recordPayment({ userId: sso, kind: "aid", paidOn: "2026-09-02", amount: 1, reason: "ทดสอบ", actorId: owner }); SP.voidPayment({ id, reason: "ทดสอบ", actorId: owner }); db.prepare("UPDATE users SET role='staff' WHERE id = ?").run(sso); return true; })());

  // the payroll round exists BEFORE the payments (they must fold into the live round)
  const periodId = Number(db.prepare("INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-09-01','2026-09-30','2026-09-30','draft',NULL,'ft','auto')").run().lastInsertRowid);
  computePayrollPeriod(db, periodId);
  const line = (uid: number) => db.prepare("SELECT * FROM payroll_lines WHERE period_id = ? AND user_id = ?").get(periodId, uid) as Record<string, number> | undefined;
  const base = line(wht)!, baseSso = line(sso)!;
  ok("baseline: 12,000 salary, 3% withheld = 360, nothing special", near(base.gross_pay, 12000) && near(base.tax_amount, 360) && base.special_payment === 0 && near(base.net_pay, 11640));

  // ── the owner's two examples ──────────────────────────────────
  const aid = SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-11", amount: 2000, reason: "ช่วยเหลือพนักงานกรณีทางบ้านประสบอุทกภัย", actorId: owner });
  let l = line(wht)!;
  ok("aid 2,000: shows in the month's income (gross 14,000)", near(l.gross_pay, 14000) && near(l.special_payment, 2000));
  ok("aid 2,000: withholding is 3% of 14,000 = 420", near(l.tax_amount, 420) && near(l.special_tax, 60));
  ok("aid 2,000: payday transfer = 14,000 − 420 − 2,000 already paid = 11,580", near(l.net_pay, 11580) && near(l.special_paid_out, 2000));

  const adv = SP.recordPayment({ userId: wht, kind: "advance", paidOn: "2026-09-11", amount: 2000, reason: "ขอเบิกเงินล่วงหน้า", actorId: owner });
  l = line(wht)!;
  ok("advance 2,000: income unchanged by the advance (still 14,000), tax unchanged (420)", near(l.gross_pay, 14000) && near(l.tax_amount, 420));
  ok("advance 2,000: transfer = 14,000 − 420 − 2,000 − 2,000 = 9,580", near(l.net_pay, 9580) && near(l.special_paid_out, 4000));
  ok("a second draw may only use what is left (4,000 − 2,000 = 2,000)", near(SP.advanceLimit(wht, "2026-09-11").available, 2000) && throws(() => SP.recordPayment({ userId: wht, kind: "advance", paidOn: "2026-09-11", amount: 2000.01, reason: "อีกครั้ง", actorId: owner }), "advance_exceeds_limit"));
  ok("…and a draw that exactly fits is accepted", (() => { const id = SP.recordPayment({ userId: wht, kind: "advance", paidOn: "2026-09-11", amount: 2000, reason: "เต็มวงเงิน", actorId: owner }); SP.voidPayment({ id, reason: "ทดสอบ", actorId: owner }); return true; })());

  ok("pure advance for a withholding person: tax on the FULL pay (12,000 → 360), net = 12,000 − 360 − 2,000", (() => {
    SP.voidPayment({ id: aid, reason: "ยกเลิกเพื่อทดสอบ", actorId: owner });
    const x = line(wht)!; return near(x.gross_pay, 12000) && near(x.tax_amount, 360) && near(x.net_pay, 12000 - 360 - 2000) && x.special_payment === 0;
  })());
  ok("voiding the advance too restores the original line exactly", (() => { SP.voidPayment({ id: adv, reason: "ยกเลิก", actorId: owner }); const x = line(wht)!; return near(x.gross_pay, 12000) && near(x.tax_amount, 360) && near(x.net_pay, 11640) && x.special_paid_out === 0 && x.special_tax === 0; })());
  ok("a voided row cannot be voided again", throws(() => SP.voidPayment({ id: adv, reason: "ซ้ำ", actorId: owner }), "already_voided"));
  ok("the ledger shows the employee's title prefix with the name", (() => { const display = (db.prepare("SELECT display_name FROM users WHERE id = ?").get(wht) as { display_name: string }).display_name; db.prepare("UPDATE users SET title_prefix = 'นาย' WHERE id = ?").run(wht); const n = SP.listPayments({ userId: wht })[0].userName; db.prepare("UPDATE users SET title_prefix = NULL WHERE id = ?").run(wht); return n === `นาย ${display}`; })());
  ok("voided rows stay in the ledger with their reason", (() => { const r = SP.listPayments({ userId: wht }); return r.length >= 2 && r.every((x) => x.voidedAt != null && (x.voidReason ?? "").length > 0); })());

  // ── social-security staff: aid is not taxed, SSO stays on salary only ──
  SP.recordPayment({ userId: sso, kind: "aid", paidOn: "2026-09-12", amount: 2000, reason: "เงินช่วยเหลือ", actorId: owner });
  const s = line(sso)!;
  ok("social-security staff: aid adds income but no withholding", near(s.gross_pay, baseSso.gross_pay + 2000) && near(s.tax_amount, 0) && near(s.special_tax, 0));
  ok("social-security staff: SSO unchanged (salary only)", near(s.sso_amount, baseSso.sso_amount));
  ok("social-security staff: transfer is unchanged by aid (income − aid already paid)", near(s.net_pay, baseSso.net_pay));

  // ── idempotence and the other writers ─────────────────────────
  SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-20", amount: 1000, reason: "ทดสอบ", actorId: owner });
  const before = line(wht)!;
  SP.foldSpecialPayments(db, periodId, wht); SP.foldSpecialPayments(db, periodId, wht);
  const again = line(wht)!;
  ok("folding twice changes nothing", near(before.gross_pay, again.gross_pay) && near(before.tax_amount, again.tax_amount) && near(before.net_pay, again.net_pay));
  computePayrollPeriod(db, periodId);
  const rebuilt = line(wht)!;
  ok("rebuilding the whole round keeps the payment (gross 13,000, tax 390, net 13,000 − 390 − 1,000)", near(rebuilt.gross_pay, 13000) && near(rebuilt.tax_amount, 390) && near(rebuilt.net_pay, 13000 - 390 - 1000));
  recomputeLine(db, periodId, wht); recomputeLine(db, periodId, wht);
  const rc = line(wht)!;
  ok("recomputing one line (twice) does not double-count the payment", near(rc.gross_pay, 13000) && near(rc.tax_amount, 390) && near(rc.special_payment, 1000) && near(rc.net_pay, 13000 - 390 - 1000));
  addLineDeduction(periodId, wht, "ค่าปรับ", 100, owner);
  const withDed = line(wht)!;
  ok("an itemised deduction added afterwards still nets off what was already paid", near(withDed.net_pay, 13000 - 390 - 100 - 1000));

  // ── guard rails around closed rounds ───────────────────────────
  db.prepare("UPDATE payroll_lines SET reviewed_at = CURRENT_TIMESTAMP WHERE period_id = ? AND user_id = ?").run(periodId, wht);
  ok("a reviewed (checked) line refuses new payments", throws(() => SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-21", amount: 100, reason: "ทดสอบ", actorId: owner }), "line_reviewed"));
  ok("…and refuses voiding one that is already settled in it", throws(() => SP.voidPayment({ id: SP.listPayments({ userId: wht }).find((x) => !x.voidedAt)!.id, reason: "ทดสอบ", actorId: owner }), "line_reviewed"));
  db.prepare("UPDATE payroll_lines SET reviewed_at = NULL WHERE period_id = ? AND user_id = ?").run(periodId, wht);
  db.prepare("UPDATE payroll_periods SET status = 'finalized' WHERE id = ?").run(periodId);
  ok("a finalized round refuses new payments", throws(() => SP.recordPayment({ userId: wht, kind: "aid", paidOn: "2026-09-21", amount: 100, reason: "ทดสอบ", actorId: owner }), "period_finalized"));
  ok("a finalized line is never rewritten by folding", (() => { const b = line(wht)!; SP.foldSpecialPayments(db, periodId, wht); return near(b.net_pay, line(wht)!.net_pay); })());

  // ── a payment dated before any round exists settles when the round is built ──
  const w2 = mk("wht2", "wht");
  const id2 = SP.recordPayment({ userId: w2, kind: "aid", paidOn: "2026-10-05", amount: 500, reason: "ช่วยเหลือ", actorId: owner });
  const octId = Number(db.prepare("INSERT INTO payroll_periods (cycle,period_start,period_end,pay_date,status,branch_id,target,data_source) VALUES ('monthly','2026-10-01','2026-10-31','2026-10-31','draft',NULL,'ft','auto')").run().lastInsertRowid);
  computePayrollPeriod(db, octId);
  const o = db.prepare("SELECT gross_pay, tax_amount, net_pay FROM payroll_lines WHERE period_id = ? AND user_id = ?").get(octId, w2) as { gross_pay: number; tax_amount: number; net_pay: number };
  ok("a payment recorded before the round existed is included when it is built (12,500 gross, 375 tax, net 12,500 − 375 − 500)", near(o.gross_pay, 12500) && near(o.tax_amount, 375) && near(o.net_pay, 12500 - 375 - 500));
  ok("it is not counted in other months' rounds", id2 > 0 && near((line(w2)?.gross_pay ?? 0), 0));

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup();
  process.exit(failed ? 1 : 0);
})();
