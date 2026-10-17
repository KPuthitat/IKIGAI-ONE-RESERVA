// ยอดตกสำรวจ (missed sales found later) — Run: node --import tsx scripts/test-revshare-catchup.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-revshare-catchup.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const R = await import("../src/lib/revshare-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const code = (fn: () => unknown): string | null => { try { fn(); return null; } catch (e) { return e instanceof R.CatchupError ? e.code : `other:${(e as Error).message}`; } };

  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const user = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('a','x','a','admin','active')").run().lastInsertRowid);
  const partner = R.createPartner(branch, { name: "จ้อจี้", start_date: "2026-06-01", vat_enabled: false })!;
  // September: a full week of daily rows (already sent), October: this week
  const day = (iso: string, amount: number, sent = false) => { const id = R.createRound(partner, branch, { period_start: iso, period_end: iso, sales_amount: amount }, user)!; if (sent) R.markRoundSent(id, partner, branch, user); return id; };
  for (const d of ["2026-09-28", "2026-09-29", "2026-09-30"]) day(d, 1000, true);
  day("2026-10-12", 2000); day("2026-10-13", 3000);

  const sepBefore = R.previewSettlement(partner, branch, 2026, 9)!.result.totalSales;
  const octBefore = R.previewSettlement(partner, branch, 2026, 10)!.result.totalSales;

  // a missed day found on 2026-10-14: recorded today, belongs to 2 Oct
  const id = R.createCatchup(partner, branch, { sales_from: "2026-10-02", sales_to: "2026-10-02", sales_amount: 500, counted_date: "2026-10-14", note: "POS ไม่ได้ส่งออก" }, user)!;
  ok("a catch-up is stored with the day it belongs to and the day it was recorded", (() => { const c = R.listCatchups(partner, branch, 2026, 10)[0]; return c.sales_from === "2026-10-02" && c.counted_date === "2026-10-14" && c.sales_amount === 500; })());
  ok("it counts in the month it was recorded, not in the month of its real day", R.listCatchups(partner, branch, 2026, 10).length === 1 && R.listCatchups(partner, branch, 2026, 9).length === 0);
  ok("the past (September) settlement is untouched", R.previewSettlement(partner, branch, 2026, 9)!.result.totalSales === sepBefore);
  ok("the current month's total includes it", R.previewSettlement(partner, branch, 2026, 10)!.result.totalSales === octBefore + 500);
  const wk = R.previewSettlement(partner, branch, 2026, 10)!.breakdown.find((b) => b.start === "2026-10-12")!;
  ok("it is inside the week it was recorded in, shown as its own amount", wk.sales === 5500 && wk.catchup === 500);
  ok("daily rows are unchanged (a catch-up is never mixed into a day)", R.listRounds(partner, branch, 2026, 10).reduce((s, r) => s + r.sales_amount, 0) === 5000);
  ok("the month picker's total includes it", R.monthPickerOptions(partner, branch, 2026, 10, 1).find((o) => o.ym === "2026-10")!.sales === 5500);

  // transfer round
  const pv = R.previewTransferRound(partner, branch, "2026-10-12", "2026-10-14")!;
  ok("a transfer round lists catch-ups on their own and adds them to the total", pv.catchups.length === 1 && pv.catchupTotal === 500 && pv.totalSales === 5500);
  ok("a catch-up recorded outside the span is not pulled in", R.previewTransferRound(partner, branch, "2026-10-12", "2026-10-13")!.catchupTotal === 0);
  ok("a transfer round marks the catch-up as transferred", (R.sendTransferRound(partner, branch, "2026-10-12", "2026-10-14", user), R.listCatchups(partner, branch, 2026, 10)[0].sent_at !== null));
  ok("a transferred catch-up cannot be removed", R.deleteCatchup(id, partner, branch) === "sent");

  // rules
  ok("an amount of zero is refused", code(() => R.createCatchup(partner, branch, { sales_amount: 0 }, user)) === "invalid_amount");
  ok("a start date alone means that single day", (() => { const n = R.createCatchup(partner, branch, { sales_from: "2026-10-03", sales_amount: 10, counted_date: "2026-10-15" }, user)!; const c = R.listCatchups(partner, branch, 2026, 10).find((x) => x.id === n)!; return c.sales_to === "2026-10-03"; })());
  ok("an inverted range is refused", code(() => R.createCatchup(partner, branch, { sales_from: "2026-10-05", sales_to: "2026-10-02", sales_amount: 10 }, user)) === "invalid_range");
  ok("a single day that already has its daily row is a duplicate, not a missed day", code(() => R.createCatchup(partner, branch, { sales_from: "2026-10-12", sales_to: "2026-10-12", sales_amount: 10 }, user)) === "day_has_daily");
  ok("a catch-up with no known day is allowed (owner is not always sure when)", (() => { const n = R.createCatchup(partner, branch, { sales_amount: 70, counted_date: "2026-10-15" }, user)!; const c = R.listCatchups(partner, branch, 2026, 10).find((x) => x.id === n)!; return c.sales_from === null && c.sales_to === null; })());
  ok("an unsent catch-up can be removed", (() => { const n = R.createCatchup(partner, branch, { sales_amount: 5, counted_date: "2026-10-15" }, user)!; return R.deleteCatchup(n, partner, branch) === "ok"; })());
  ok("another branch cannot touch it", R.deleteCatchup(id, partner, branch + 99) === "not_found" && R.listCatchups(partner, branch + 99, 2026, 10).length === 0);

  // whole-span file (start of the month → today) reconcile: file total − recorded daily − earlier catch-ups inside the span
  const rc = R.reconcileRange(partner, branch, "2026-10-01", "2026-10-14")!;
  ok("reconcile counts the daily rows and the catch-ups already inside the span", rc.dailyDays === 2 && rc.dailyTotal === 5000 && rc.catchupTotal === 510);  // 500 (2 Oct) + 10 (3 Oct); the one with no known day is not counted
  const full = R.createCatchupFromFile(partner, branch, { from: "2026-10-01", to: "2026-10-14", fileTotal: 12000, filename: "oct.xlsx", counted_date: "2026-10-15" }, user)!;
  ok("only the missing part is stored: 12,000 − 5,000 daily − 510 earlier catch-ups = 6,490", full.amount === 6490);
  ok("the stored note explains the arithmetic and the entry is a range", (() => { const c = R.listCatchups(partner, branch, 2026, 10).find((x) => x.id === full.id)!; return c.sales_from === "2026-10-01" && c.sales_to === "2026-10-14" && (c.note ?? "").includes("12000.00"); })());
  ok("importing the same file again finds nothing missing", code(() => R.createCatchupFromFile(partner, branch, { from: "2026-10-01", to: "2026-10-14", fileTotal: 12000, counted_date: "2026-10-15" }, user)) === "nothing_missing");
  ok("a file that shows less than what is recorded is refused (wrong categories/base)", code(() => R.createCatchupFromFile(partner, branch, { from: "2026-10-01", to: "2026-10-14", fileTotal: 3000, counted_date: "2026-10-15" }, user)) === "daily_exceeds_file");
  // category explanation stored with a whole-span catch-up (the shortfall equals the DESSERTS category)
  const p2 = R.createPartner(branch, { name: "จ้อจี้ 2", start_date: "2026-06-01", vat_enabled: false })!;
  R.createRound(p2, branch, { period_start: "2026-10-01", period_end: "2026-10-01", sales_amount: 1000 }, user);
  const withCats = R.createCatchupFromFile(p2, branch, { from: "2026-10-01", to: "2026-10-03", fileTotal: 1000 + 250, categoryValues: [{ name: "X - COFFEE", value: 1000 }, { name: "X - DESSERTS", value: 250 }], categories: ["X - COFFEE", "X - DESSERTS"], counted_date: "2026-10-15" }, user)!;
  ok("the catch-up records which category the shortfall equals", (() => { const c = R.listCatchups(p2, branch, 2026, 10).find((x) => x.id === withCats.id)!; return c.breakdown?.exact?.length === 1 && c.breakdown.exact[0].name === "X - DESSERTS" && c.breakdown.dates.join() === "2026-10-02,2026-10-03"; })());
  ok("the partner card text names it", R.catchupCategoryText(R.listCatchups(p2, branch, 2026, 10)) === "X - DESSERTS");
  ok("a transfer round preview carries the same text", R.previewTransferRound(p2, branch, "2026-10-14", "2026-10-16")!.catchupCategories === "X - DESSERTS");
  // report to the partner group: its own card, stamps reported_at but never "transferred"
  const L = await import("../src/lib/revshare-line");
  const cu = R.getCatchup(withCats.id, p2, branch)!;
  const card = JSON.stringify(L.revshareCatchupFlex({ shop: "X", sellerName: "HYPO", amount: cu.sales_amount, vatRate: 0.07, salesLabel: "1–3 ต.ค.", recordedLabel: "15 ต.ค.", categories: R.catchupCategoryText([cu]), note: cu.note }));
  ok("the catch-up report card carries the amount with VAT, the days and the category", card.includes("ยอดตกสำรวจ") && card.includes("267.50") && card.includes("1–3 ต.ค.") && card.includes("X - DESSERTS"));
  ok("another branch cannot read a catch-up to report it", R.getCatchup(withCats.id, p2, branch + 99) === null);
  ok("sending the report stamps reported_at but leaves it untransferred and removable", (() => {
    R.markCatchupReported(withCats.id, p2, branch);
    const c = R.getCatchup(withCats.id, p2, branch)!;
    return c.reported_at !== null && c.sent_at === null && R.deleteCatchup(withCats.id, p2, branch) === "ok";
  })());
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
