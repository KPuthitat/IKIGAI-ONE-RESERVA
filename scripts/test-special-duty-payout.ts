// ตำแหน่งงานค่าตอบแทนพิเศษ — pay, tax, accounta, budget, owner alerts.
// Run: node --import tsx scripts/test-special-duty-payout.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-special-duty-payout.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const D = await import("../src/lib/special-duty");
  const P = await import("../src/lib/special-duty-payout");
  const SC = await import("../src/lib/service-charge");
  const { postSvcToAccounta } = await import("../src/lib/accounta-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const YM = "2026-12", NOW = "2026-11-05";
  const date = (d: number) => `${YM}-${String(d).padStart(2, "0")}`;

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const mk = (u: string, mode: "sso" | "wht", branch = nama) => { const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,title_prefix,role,status,salary_tax_mode) VALUES (?,?,?,?,'staff','active',?)").run(u, "x", u, "นาย", mode).lastInsertRowid); db.prepare("INSERT INTO user_branches (user_id,branch_id,is_primary) VALUES (?,?,1)").run(id, branch); return id; };
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  const whtP = mk("wht-holder", "wht"), ssoP = mk("sso-sub", "sso"), pend = mk("pending", "wht");

  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 1, name: "ล้างห้องน้ำ", dailyRate: 150, actorId: owner, asOf: NOW });
  D.savePosition({ branchId: nama, yearMonth: YM, slotNo: 2, name: "เตรียมวัตถุดิบ", dailyRate: 200, actorId: owner, asOf: NOW });
  D.savePosition({ branchId: hypo, yearMonth: YM, slotNo: 1, name: "ล้างจาน", dailyRate: 100, actorId: owner, asOf: NOW });
  const [toilet, prep] = D.listPositions(nama, YM);
  const [dish] = D.listPositions(hypo, YM);
  const add = (pos: number, d: number, uid: number, status: string, performer: number | null = null, ym = YM) =>
    db.prepare("INSERT INTO special_duty_days (position_id,duty_date,user_id,source,status,performer_user_id) VALUES (?,?,?, 'booked', ?, ?)").run(pos, `${ym}-${String(d).padStart(2, "0")}`, uid, status, performer);

  // wht holder: 4 approved toilet days (4×150) + 2 approved prep days (2×200) = 1,000; 1 submitted (unpaid), 1 booked (unpaid), 1 absent (unpaid)
  for (let d = 1; d <= 4; d++) add(toilet.id, d, whtP, "approved");
  for (let d = 1; d <= 2; d++) add(prep.id, d, whtP, "approved");
  add(toilet.id, 5, whtP, "submitted"); add(toilet.id, 6, whtP, "booked"); add(toilet.id, 7, whtP, "absent");
  // substitute performed a day for the wht holder: paid to the SUBSTITUTE
  add(toilet.id, 8, whtP, "approved", ssoP);
  // pending person: only unapproved days
  add(toilet.id, 9, pend, "submitted"); add(toilet.id, 10, pend, "assigned");
  // another branch, and another month
  add(dish.id, 1, ssoP, "approved");
  db.prepare("INSERT INTO special_duty_positions (branch_id, year_month, slot_no, name, daily_rate) VALUES (?, '2027-01', 1, 'x', 150)").run(nama);
  const jan = Number((db.prepare("SELECT id FROM special_duty_positions WHERE year_month='2027-01'").get() as { id: number }).id);
  add(jan, 1, whtP, "approved", null, "2027-01");

  const g = P.dutyFeeGrossByBranchUser(YM);
  ok("only APPROVED days are paid: wht holder 4×150 + 2×200 = 1,000", near(g.get(nama)?.get(whtP) ?? 0, 1000));
  ok("a substitute is paid for the day they did (150), not the holder", near(g.get(nama)?.get(ssoP) ?? 0, 150));
  ok("submitted / booked / assigned / absent days earn nothing", !g.get(nama)?.has(pend));
  ok("the other branch's days book to THAT branch (100)", near(g.get(hypo)?.get(ssoP) ?? 0, 100) && !g.get(hypo)?.has(whtP));
  ok("other months are not included", near(P.dutyFeeGrossByBranchUser("2027-01").get(nama)?.get(whtP) ?? 0, 150) && near(g.get(nama)?.get(whtP) ?? 0, 1000));

  // ── tax: through the service-charge payout ──
  const rows = SC.computeBranchSvcPayout(nama, YM);
  const rWht = rows.find((r) => r.userId === whtP)!, rSso = rows.find((r) => r.userId === ssoP)!;
  ok("withholding-tax staff: 3% withheld (1,000 → WHT 30, net 970)", near(rWht.dutyFeeGross, 1000) && near(rWht.dutyFeeWht, 30) && near(rWht.dutyFeeNet, 970));
  ok("…and the row's cash net / WHT include it", near(rWht.net, 970) && near(rWht.wht, 30));
  ok("social-security staff: nothing withheld (150 → net 150)", near(rSso.dutyFeeGross, 150) && near(rSso.dutyFeeWht, 0) && near(rSso.dutyFeeNet, 150) && near(rSso.net, 150));
  ok("a person with no approved day gets no duty fee", (rows.find((r) => r.userId === pend)?.dutyFeeGross ?? 0) === 0);
  ok("the duty fee carries the prefixed name", rWht.displayName === "นาย wht-holder");
  ok("HYPO's payout holds only HYPO's day", (() => { const h = SC.computeBranchSvcPayout(hypo, YM); return h.length === 1 && near(h[0].dutyFeeGross, 100) && near(h[0].net, 100); })());

  const agg = SC.dutyFeeByUserCompany(YM);
  ok("the roll-up map has one row per person (the substitute: 150 + 100 from two branches = 250)", agg.size === 2 && near(agg.get(`${whtP}|null`)?.dutyGross ?? 0, 1000) && near(agg.get(`${ssoP}|null`)?.dutyNet ?? 0, 250));

  // ── company review card ──
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บ')").run().lastInsertRowid);
  db.prepare("UPDATE branches SET company_id = ? WHERE id IN (?, ?)").run(co, nama, hypo);
  const rv = P.dutyPayoutReview(YM, co);
  const rp = (id: number) => rv.people.find((x) => x.userId === id);
  ok("the company review lists approved days and amounts per payee", rp(whtP)?.days === 6 && near(rp(whtP)!.gross, 1000) && rp(ssoP)?.days === 2 && near(rp(ssoP)!.gross, 250));
  ok("days still waiting for approval are counted apart and earn nothing", rp(pend)?.days === 0 && rp(pend)?.pendingDays === 2 && rp(pend)?.gross === 0 && rv.pendingDays >= 4);
  ok("the company total matches what the payout pays", near(rv.totalGross, 1250));
  ok("another company sees nothing", P.dutyPayoutReview(YM, co + 1).people.length === 0);

  // ── accounta ──
  db.prepare("INSERT INTO svc_payout_batches (branch_id,year_month,status) VALUES (?,?,'finalized')").run(nama, YM);
  const batch = (db.prepare("SELECT id FROM svc_payout_batches WHERE branch_id=? AND year_month=?").get(nama, YM) as { id: number }).id;
  const res = postSvcToAccounta(batch, owner);
  const ex = (cat: string) => db.prepare("SELECT amount_total a, payment_status s, vendor_name v FROM accounta_expenses WHERE svc_payout_batch_id=? AND category=? ORDER BY id").all(batch, cat) as Array<{ a: number; s: string; v: string }>;
  const duty = ex("ค่าตอบแทนตำแหน่งงานพิเศษ");
  ok("accounta: its own category — 970 for the withholding person, 150 for the substitute (both paid)", duty.length === 2 && near(duty[0].a, 970) && near(duty[1].a, 150) && duty.every((r) => r.s === "paid"));
  ok("accounta: the 30 withheld is a tax payable in the person's name (unpaid)", (() => { const w = ex("ภาษีหัก ณ ที่จ่าย"); return w.length === 1 && near(w[0].a, 30) && w[0].s === "unpaid" && w[0].v.includes("wht-holder"); })());
  ok("accounta: nothing is booked as service charge (no SVC that month)", ex("เซอร์วิสชาร์จพนักงาน").length === 0);
  ok("accounta: batch totals = cash 1,120 (970 + 150), WHT 30; two staff counted once each", near(res.net, 1120) && near(res.wht, 30) && res.staff === 2);
  ok("re-posting replaces the rows (no duplicates)", (() => { postSvcToAccounta(batch, owner); return ex("ค่าตอบแทนตำแหน่งงานพิเศษ").length === 2; })());

  // ── summary + alerts ──
  D.enableMonth({ branchId: nama, yearMonth: YM, actorId: owner, asOf: NOW });
  const s = P.dutyMonthSummary(nama, YM);
  ok("budget = 31 days × (150 + 200) = 10,850", near(s.budget, 31 * 350));
  ok("approved amount counts every approved day at its rate (6 holder days 4×150+2×200 + 1 substitute day 150 = 1,150)", near(s.approvedAmount, 1150));
  ok("pending = submitted+booked+assigned (holder 2, pending person 2)", s.pendingDays === 4);
  ok("absent 1", s.absentDays === 1);
  ok("unfilled = 62 position-days − 12 held = 50", s.heldDays === 12 && s.unfilledDays === 62 - 12);
  const alerts = P.dutyOwnerAlerts(nama, YM);
  ok("owner alert when fewer than 6 people share the duty", alerts.some((a) => a.kind === "few_people"));
  ok("no 'too many days' alert at 10 days or fewer for one person", !alerts.some((a) => a.kind === "too_many_days"));
  for (let d = 11; d <= 31; d++) add(toilet.id, d, pend, "booked");
  ok("alert when one person carries more than the limit (20 days)", P.dutyOwnerAlerts(nama, YM).some((a) => a.kind === "too_many_days" && a.text.includes("pending")));
  D.setConfig("owner_alert_min_bookers", 2, owner);
  ok("the thresholds come from the settings table", !P.dutyOwnerAlerts(nama, YM).some((a) => a.kind === "few_people"));

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
