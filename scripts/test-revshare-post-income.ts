// Book a partner's daily sales to ACCOUNTA on demand — Run: node --import tsx scripts/test-revshare-post-income.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-revshare-post-income.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/revshare-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e) { return e instanceof R.IncomePostError ? e.code : `other:${(e as Error).message}`; } };

  const seller = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const own = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('sala','ศาลาชิลล์')").run().lastInsertRowid);
  const user = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','a','admin','active')").run().lastInsertRowid);
  const p = R.createPartner(seller, { name: "จ้อจี้", start_date: "2026-06-01", vat_enabled: true, sales_base: "gross", income_branch_id: own } as never)!;
  const noBranch = R.createPartner(seller, { name: "ไม่มีสาขา", start_date: "2026-06-01" })!;
  const day = (partner: number, iso: string, amount: number) => R.createRound(partner, seller, { period_start: iso, period_end: iso, sales_amount: amount }, user);
  day(p, "2026-11-01", 5413); day(p, "2026-11-02", 1000); day(noBranch, "2026-11-01", 100);

  ok("nothing is booked at first, and the target branch is named", (() => { const r = R.postedDailyIncome(p, seller, "2026-11-01", "2026-11-30"); return r.incomeBranchId === own && r.incomeBranchName === "ศาลาชิลล์" && Object.keys(r.posted).length === 0; })());
  const out = R.postDailyRoundsToAccounta(p, seller, ["2026-11-01"], user);
  ok("a day is booked VAT-inclusive (5,413 + 7% = 5,791.91), like the daily card does", out.length === 1 && out[0].amount === 5791.91);
  ok("it lands in the partner's own books as revshare income on that day with the partner as channel", (() => {
    const r = db.prepare("SELECT branch_id b, amount a, source s, channel c, is_vat v FROM accounta_income WHERE income_date = '2026-11-01'").all() as Array<{ b: number; a: number; s: string; c: string; v: number }>;
    return r.length === 1 && r[0].b === own && r[0].s === "revshare" && r[0].c === "จ้อจี้" && Math.abs(r[0].a - 5791.91) < 0.005 && r[0].v === 1;
  })());
  ok("the booked amount is reported back per day", R.postedDailyIncome(p, seller, "2026-11-01", "2026-11-30").posted["2026-11-01"] === 5791.91);
  R.postDailyRoundsToAccounta(p, seller, ["2026-11-01"], user);
  ok("booking the same day again never doubles it", (db.prepare("SELECT COUNT(*) n FROM accounta_income WHERE income_date = '2026-11-01' AND source = 'revshare'").get() as { n: number }).n === 1);
  const rid = (db.prepare("SELECT id FROM revshare_rounds WHERE partner_id = ? AND period_start = '2026-11-01'").get(p) as { id: number }).id;
  R.updateRound(rid, p, seller, { sales_amount: 6000 }, user);
  R.postDailyRoundsToAccounta(p, seller, ["2026-11-01"], user);
  ok("after the amount is edited, re-booking replaces the row with the new amount", (() => { const r = db.prepare("SELECT amount a FROM accounta_income WHERE income_date = '2026-11-01' AND source = 'revshare'").all() as Array<{ a: number }>; return r.length === 1 && Math.abs(r[0].a - 6420) < 0.005; })());
  ok("several days at once", R.postDailyRoundsToAccounta(p, seller, ["2026-11-01", "2026-11-02"], user).length === 2 && Object.keys(R.postedDailyIncome(p, seller, "2026-11-01", "2026-11-30").posted).length === 2);
  ok("a partner with no income branch cannot be booked", code(() => R.postDailyRoundsToAccounta(noBranch, seller, ["2026-11-01"], user)) === "no_income_branch" && R.postedDailyIncome(noBranch, seller, "2026-11-01", "2026-11-30").incomeBranchId === null);
  ok("a day with no entry is refused and nothing is half-booked", code(() => R.postDailyRoundsToAccounta(p, seller, ["2026-11-03", "2026-11-02"], user)) === "day_not_found");
  ok("another branch cannot book this partner", code(() => R.postDailyRoundsToAccounta(p, own, ["2026-11-01"], user)) === "not_found");

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
