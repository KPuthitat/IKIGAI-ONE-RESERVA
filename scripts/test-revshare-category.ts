// partnerCategorySales (owner 2026-09-20): a revshare partner's sales-by-category
// breakdown, read from ANALYTICA's per-category figures (salesa_menu) for the
// partner's branch + date range, filtered to the partner's pos_categories.
//
// Run:  node --import tsx scripts/test-revshare-category.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-revshare-category.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { partnerCategorySales } = await import("../src/lib/revshare-db");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const B = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('hypo','HYPOPLARAEMIA')").run().lastInsertRowid);
  const ins = db.prepare("INSERT INTO salesa_menu (branch_id, sale_date, kind, name, nett, rank) VALUES (?, ?, 'category', ?, ?, ?)");
  // One day of category sales for the branch.
  ins.run(B, "2026-09-20", "ย่าง", 5000, 1);
  ins.run(B, "2026-09-20", "ส้มตำ", 3000, 2);
  ins.run(B, "2026-09-20", "เครื่องดื่ม", 1200, 3);
  ins.run(B, "2026-09-20", "ของหวาน", 0, 4);       // zero sales — must be dropped
  ins.run(B, "2026-09-21", "ย่าง", 2000, 1);         // next day, for the range test

  ok("all categories when partner has none configured (whole venue), sorted desc, drops 0",
    (() => {
      const r = partnerCategorySales(B, [], "2026-09-20", "2026-09-20");
      return r.length === 3 && r[0].name === "ย่าง" && r[0].sales === 5000 && r[2].name === "เครื่องดื่ม"
        && !r.some((c) => c.name === "ของหวาน");
    })());

  ok("filters to the partner's pos_categories only",
    (() => {
      const r = partnerCategorySales(B, ["ย่าง", "เครื่องดื่ม"], "2026-09-20", "2026-09-20");
      return r.length === 2 && r[0].name === "ย่าง" && r[1].name === "เครื่องดื่ม";
    })());

  ok("category name match is case/space-insensitive",
    partnerCategorySales(B, ["  ย่าง  "], "2026-09-20", "2026-09-20").length === 1);

  ok("range sums across days",
    (() => {
      const r = partnerCategorySales(B, ["ย่าง"], "2026-09-20", "2026-09-21");
      return r.length === 1 && r[0].name === "ย่าง" && r[0].sales === 7000;
    })());

  ok("no data for the range → empty", partnerCategorySales(B, [], "2026-10-01", "2026-10-31").length === 0);

  console.log(`\nrevshare-category test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
