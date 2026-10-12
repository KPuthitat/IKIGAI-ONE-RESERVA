// INVENTA forecast stage 1. Run: node --import tsx scripts/test-inventa-forecast.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-inventa-forecast.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const F = await import("../src/lib/inventa-forecast");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const TODAY = "2026-10-12";
  const day = (back: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);

  const b1 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('c','CLINIC')").run().lastInsertRowid);
  const b2 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('o','OTHER')").run().lastInsertRowid);
  const item = (name: string, code: string | null, qty: number, cost = 10, extra = "") =>
    Number(db.prepare(`INSERT INTO inventa_items (branch_id,item_code,name,current_qty,unit_cost,item_type ${extra ? "," + extra.split("=")[0] : ""}) VALUES (?,?,?,?,?,'drug' ${extra ? ",?" : ""})`)
      .run(...([b1, code, name, qty, cost] as unknown[]).concat(extra ? [extra.split("=")[1]] : [])).lastInsertRowid);
  let billSeq = 0;
  const sell = (branch: number, back: number, code: string | null, name: string, qty: number) => {
    const bid = Number(db.prepare("INSERT INTO clinica_bills (branch_id,bill_no,bill_date) VALUES (?,?,?)").run(branch, `B${++billSeq}`, day(back)).lastInsertRowid);
    db.prepare("INSERT INTO clinica_bill_items (bill_id,code,name,qty) VALUES (?,?,?,?)").run(bid, code, name, qty);
  };

  const rowOf = (r: { rows: Array<{ name: string }> }, n: string) => r.rows.find((x) => x.name === n) as any;

  // no sales data at all → nothing is classified, nothing invented
  item("พาราเซตามอล", "P1", 100);
  const empty = F.inventaForecast(b1, TODAY);
  ok("no imports: hasSalesData false and every row 'no_sales'", !empty.hasSalesData && empty.rows.every((r) => r.status === "no_sales"));

  const amox = item("อะม็อกซิลลิน", "A1", 20);       // sells 3/day → ~6.7 days cover → reorder
  const vit = item("วิตามินซี", "V1", 600, 5);        // sells 1/day → 600 days → overstock
  const dust = item("ยาหมดอายุเงียบ", "D1", 40, 25);   // never sold, stock on hand → dead
  const byName = item("ครีมทาแผล", null, 5);         // matched by name only
  const empt = item("ยาที่ขาด", "E1", 0);             // never sold, no stock → not dead
  const frac = item("น้ำเกลือขวด", "F1", 5, 10, "count_mode=fractional");
  for (let d = 0; d < 90; d++) { sell(b1, d, "A1", "อะม็อกซิลลิน", 3); sell(b1, d, "V1", "วิตามินซี", 1); }
  sell(b1, 5, "X9", "ครีมทาแผล", 9);
  sell(b2, 1, "A1", "อะม็อกซิลลิน", 999);              // other branch must not leak in

  const r = F.inventaForecast(b1, TODAY);
  ok("history is 90 days", r.windowDays === 90 && r.hasSalesData);
  const a = rowOf(r, "อะม็อกซิลลิน");
  ok("rate = sold / days, other branches excluded", Math.abs(a.perDay - 3) < 1e-9 && a.soldWindow === 270);
  ok("cover days and reorder status", Math.abs(a.coverDays - 20 / 3) < 1e-9 && a.status === "reorder");
  ok("suggested qty tops up to lead+buffer cover (21d × 3 − 20 = 43)", a.suggestedQty === 43);
  const v = rowOf(r, "วิตามินซี");
  ok("overstock flagged; tied-up value = stock beyond 90 days × cost", v.status === "overstock" && Math.abs(v.tiedUpValue - (600 - 90) * 5) < 1e-6 && v.suggestedQty === 0);
  const du = rowOf(r, "ยาหมดอายุเงียบ");
  ok("never-sold item with stock is dead, all its value tied up", du.status === "dead" && du.tiedUpValue === 40 * 25);
  ok("never-sold item with zero stock is not dead", rowOf(r, "ยาที่ขาด").status === "no_sales");
  const bn = rowOf(r, "ครีมทาแผล");
  ok("name fallback matches when the code does not", bn.soldWindow === 9 && bn.status !== "no_sales");
  ok("fractional (open bottle) items are skipped, not mis-forecast", rowOf(r, "น้ำเกลือขวด").status === "skipped");
  ok("totals", r.totals.reorder === 1 && r.totals.dead === 2 && r.totals.overstock === 1 && Math.abs(r.totals.tiedUpValue - (510 * 5 + 1000 + 1000)) < 1e-6);

  // short history is not divided by 90
  const b3 = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('n','NEW')").run().lastInsertRowid);
  db.prepare("INSERT INTO inventa_items (branch_id,item_code,name,current_qty,unit_cost,item_type) VALUES (?,?,?,?,?,'drug')").run(b3, "Z1", "ยาใหม่", 5, 1);
  for (let d = 0; d < 10; d++) sell(b3, d, "Z1", "ยาใหม่", 2);
  const s = F.inventaForecast(b3, TODAY);
  ok("short history: window = days since first bill (10), rate 2/day", s.windowDays === 10 && Math.abs(s.rows[0].perDay - 2) < 1e-9);
  void amox; void vit; void dust; void byName; void empt; void frac;
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
