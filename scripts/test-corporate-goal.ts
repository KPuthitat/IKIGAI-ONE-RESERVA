// Corporate goal monitor, phase 1 — targets, sales definition, weekly digest, cron gating.
// Run: node --import tsx scripts/test-corporate-goal.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-corporate-goal.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/corporate-goal");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const nama = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA PASTA SRIRACHA')").run().lastInsertRowid);
  const hypo = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPOPLARAEMIA')").run().lastInsertRowid);
  db.prepare("INSERT INTO branches (slug,name) VALUES ('clinic','AT HOME CLINIC')").run();
  const sale = (b: number, d: string, gross: number, disc: number, sc = 0, vat = 0) =>
    db.prepare("INSERT INTO salesa_daily (branch_id, sale_date, nett, gross, discount, service_charge, vat, has_sales) VALUES (?,?,?,?,?,?,?,1)").run(b, d, gross + disc + sc + vat, gross, disc, sc, vat);

  ok("the two goal branches are found by name, the clinic is not", G.goalBranches().map((b) => b.plan.key).join() === "nama,hypo");
  const split = G.monthlySplit(7_400_000, 2027, G.GOAL_PLAN[0].closed);
  ok("the monthly split adds up exactly to the annual figure", split.length === 12 && split.reduce((s, x) => s + x, 0) === 7_400_000);
  ok("months with closure days get a little less per month than their calendar share", split[0] / 31 < split[2] / 31 && split[11] / 31 < split[2] / 31 && split[1] / 28 > 0);

  const r1 = G.seedGoalTargets(false);
  ok("seeding writes 12 months for each goal branch", r1.length === 2 && r1.every((r) => r.months === 12) && (db.prepare("SELECT COUNT(*) n FROM salesa_monthly_targets").get() as { n: number }).n === 24);
  db.prepare("UPDATE salesa_monthly_targets SET target = 999000 WHERE branch_id = ? AND ym = '2027-03'").run(nama);
  const r2 = G.seedGoalTargets(false);
  ok("seeding again does not touch months that already have a target", r2.every((r) => r.months === 0) && (db.prepare("SELECT target FROM salesa_monthly_targets WHERE branch_id = ? AND ym = '2027-03'").get(nama) as { target: number }).target === 999000);
  ok("overwrite replaces them", G.seedGoalTargets(true).every((r) => r.months === 12) && (db.prepare("SELECT target FROM salesa_monthly_targets WHERE branch_id = ? AND ym = '2027-03'").get(nama) as { target: number }).target !== 999000);

  // sales definition: gross + discount (discount is negative), before VAT and service charge
  sale(nama, "2027-03-01", 10000, -1000, 900, 630);
  sale(nama, "2027-03-02", 5000, 0, 500, 385);
  ok("sales = gross − discount, before VAT and service charge", G.goalSales(nama, "2027-03-01", "2027-03-31") === 14000);
  const m = G.salesMeasures(nama, "2027-03-01", "2027-03-31");
  ok("the back-test shows the candidate definitions side by side", m.grossLessDiscount === 14000 && m.days === 2 && m.nett > m.grossLessDiscount && Math.round(m.nettLessVatSc) === 14000);

  // weekly digest: Monday 2027-03-15 → week Mon 8 .. Sun 14 March
  for (let d = 8; d <= 14; d++) sale(nama, `2027-03-${String(d).padStart(2, "0")}`, 20000, 0);
  for (let d = 1; d <= 7; d++) if (d > 2) sale(nama, `2027-03-0${d}`, 10000, 0);
  for (let d = 1; d <= 14; d++) sale(hypo, `2027-03-${String(d).padStart(2, "0")}`, 30000, -3000);
  const dg = G.buildWeeklyDigest("2027-03-15");
  const bn = dg.branches.find((b) => b.label === "Nama")!;
  ok("the digest covers the previous Monday–Sunday", dg.weekFrom === "2027-03-08" && dg.weekTo === "2027-03-14" && dg.month === "2027-03");
  ok("week sales, previous week and month to date are right", bn.weekSales === 140000 && bn.prevWeekSales === 14000 + 50000 && bn.mtd === 14000 + 50000 + 140000);
  const nTarget = bn.target!;
  ok("forecast = month to date ÷ days elapsed × days in month", bn.forecast === Math.round((bn.mtd / 14) * 31) && bn.pctOfTarget === Math.round((bn.mtd / nTarget) * 100) && bn.forecastPct === Math.round((bn.forecast! / nTarget) * 100));
  ok("the company total adds the branches", dg.total.weekSales === bn.weekSales + dg.branches.find((b) => b.label === "Hypo")!.weekSales && dg.total.target === dg.branches.reduce((s, b) => s + (b.target ?? 0), 0));
  const flex = JSON.stringify(G.digestFlex(dg));
  ok("the LINE card names both branches, the forecast and the definition", flex.includes("Nama") && flex.includes("Hypo") && flex.includes("คาดสิ้นเดือน") && flex.includes("ก่อน VAT"));

  // a month without targets still reports sales
  const noT = G.buildWeeklyDigest("2026-11-23");
  ok("without a target the digest still shows sales and says no target", noT.branches.every((b) => b.target == null) && noT.total.target === null && JSON.stringify(G.digestFlex(noT)).includes("ยังไม่ได้ตั้งเป้า"));

  // sending and cron gating
  const pushed: string[] = [];
  const push = async (g: string) => { pushed.push(g); return true; };
  ok("no group → nothing to send", (await G.sendWeeklyDigest("2027-03-15", push)).groups === 0 && pushed.length === 0);
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('o','x','O','super_admin','active')").run().lastInsertRowid);
  db.prepare("INSERT INTO owl_secretary_groups (group_id, set_by) VALUES ('GX', ?)").run(owner);
  const hhmm = "08:05";
  ok("cron does nothing while the digest is switched off", (await G.runGoalDigestWeekly({ today: "2027-03-15", hhmm, push })) === null && pushed.length === 0);
  G.setState("weekly_enabled", "1");
  ok("…nothing on a day that is not Monday", (await G.runGoalDigestWeekly({ today: "2027-03-16", hhmm, push })) === null);
  ok("…nothing on Monday before 08:00", (await G.runGoalDigestWeekly({ today: "2027-03-15", hhmm: "07:55", push })) === null);
  const sent = await G.runGoalDigestWeekly({ today: "2027-03-15", hhmm, push });
  ok("Monday from 08:00 it goes to the executive group", sent?.sent === 1 && pushed.join() === "GX");
  ok("a re-run the same Monday sends nothing", (await G.runGoalDigestWeekly({ today: "2027-03-15", hhmm: "09:00", push })) === null && pushed.length === 1);
  const failPush = async () => false;
  ok("a failed push is retried on the next cron run", (await G.runGoalDigestWeekly({ today: "2027-03-22", hhmm, push: failPush }))?.sent === 0 && (await G.runGoalDigestWeekly({ today: "2027-03-22", hhmm, push }))?.sent === 1);

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
