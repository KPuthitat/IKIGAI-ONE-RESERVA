// Beer / Soft drink / จ้อจี้ share of sales by POS category. Run: node --import tsx scripts/test-category-mix.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-category-mix.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const M = await import("../src/lib/category-mix");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  ok("BEER and เบียร์ are beer", M.groupOfCategory("BEER") === "beer" && M.groupOfCategory("เบียร์สด") === "beer" && M.groupOfCategory("Craft Beer") === "beer");
  ok("SOFT DRINK is soft drink", M.groupOfCategory("SOFT DRINK") === "soft" && M.groupOfCategory("Soft  Drink") === "soft");
  ok("the partner's categories are จ้อจี้ — even when the name also says soft drink or dessert", M.groupOfCategory("จ้อจี้ - DESSERTS") === "jojee" && M.groupOfCategory("จ้อจี้ - SOFT DRINK") === "jojee");
  ok("everything else is other", M.groupOfCategory("PASTA") === "other" && M.groupOfCategory("WINE") === "other");

  const b = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPO')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('nama','NAMA')").run().lastInsertRowid);
  const cat = (br: number, d: string, name: string, nett: number) => db.prepare("INSERT INTO salesa_menu (branch_id, sale_date, kind, name, nett, rank) VALUES (?,?,?,?,?,0)").run(br, d, "category", name, nett);
  cat(b, "2026-11-20", "BEER", 1000); cat(b, "2026-11-20", "SOFT DRINK", 500); cat(b, "2026-11-20", "จ้อจี้ - DESSERTS", 250); cat(b, "2026-11-20", "PASTA", 8000); cat(b, "2026-11-20", "WINE", 250);
  cat(b, "2026-11-21", "BEER", 500); cat(b, "2026-11-21", "PASTA", 9500);
  cat(other, "2026-11-20", "BEER", 99999);
  db.prepare("INSERT INTO salesa_menu (branch_id, sale_date, kind, name, nett, rank) VALUES (?,?,?,?,?,0)").run(b, "2026-11-20", "item", "Cola", 12345);

  const day = M.categoryMix(b, "2026-11-20", "2026-11-20")!;
  const g = (m: NonNullable<typeof day>, k: string) => m.groups.find((x) => x.key === k)!;
  ok("day share: Beer 10%, Soft drink 5%, จ้อจี้ 2.5%, other 82.5% of 10,000", day.total === 10000 && g(day, "beer").pct === 10 && g(day, "soft").pct === 5 && g(day, "jojee").pct === 2.5 && g(day, "other").pct === 82.5);
  ok("the shares add up to 100%", Math.round(day.groups.reduce((s, x) => s + x.pct, 0) * 100) / 100 === 100);
  const mtd = M.categoryMix(b, "2026-11-01", "2026-11-21")!;
  ok("month to date sums the days (20,000 in total, Beer 1,500 = 7.5%)", mtd.total === 20000 && g(mtd, "beer").nett === 1500 && g(mtd, "beer").pct === 7.5);
  ok("another branch and item rows are not mixed in", day.total === 10000);
  ok("the biggest 'other' categories are listed so a wrongly grouped one is visible", day.others[0].name === "PASTA" && day.others.some((o) => o.name === "WINE"));
  ok("no data gives null, not a 0% line", M.categoryMix(b, "2026-12-01", "2026-12-31") === null);
  ok("the one-line text", M.mixLine(day) === "Beer 10.0% · Soft drink 5.0% · จ้อจี้ 2.5% · อื่นๆ 82.5%");

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
