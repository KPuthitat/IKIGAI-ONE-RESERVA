// INVENTA waste log (owner 2026-09-22) — create/list/summary + cost snapshot.
// Run:  node --import tsx scripts/test-inventa-waste.ts

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-inventa-waste.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { createWaste, listWaste, wasteSummary } = await import("../src/lib/inventa-waste-server");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const uid = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('t','x','พนักงาน A','staff','active')").run().lastInsertRowid);
  const A = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','NAMA')").run().lastInsertRowid);
  const mkItem = (name: string, unit: string, cost: number) => Number(db.prepare(
    "INSERT INTO inventa_items (branch_id,name,unit,unit_cost) VALUES (?,?,?,?)"
  ).run(A, name, unit, cost).lastInsertRowid);
  const it1 = mkItem("นมสด", "กล่อง", 100);
  const it2 = mkItem("ผักกาด", "กก.", 50);

  const w1 = createWaste(A, { itemId: it1, qty: 3, reason: "expired", wastedOn: "2026-09-10" }, uid);      // 300
  const w2 = createWaste(A, { itemId: it1, qty: 2, reason: "damaged", note: "แตกตอนขน", wastedOn: "2026-09-15" }, uid); // 200
  const w3 = createWaste(A, { itemId: it2, qty: 4, reason: "expired", wastedOn: "2026-09-20" }, uid);      // 200
  ok("createWaste returns ids for real items", w1 != null && w2 != null && w3 != null);
  ok("createWaste on a missing item → null", createWaste(A, { itemId: 99999, qty: 1, reason: "other", wastedOn: "2026-09-20" }, uid) === null);

  const rows = listWaste(A, 100);
  ok("listWaste returns 3 rows, newest wasted_on first", rows.length === 3 && rows[0].wasted_on === "2026-09-20" && rows[2].wasted_on === "2026-09-10");
  ok("row value = qty × unit_cost snapshot; unit + logger captured", (() => {
    const r = rows.find((x) => x.id === w1);
    return !!r && r.value === 300 && r.unit === "กล่อง" && r.item_name === "นมสด" && r.logged_by_name === "พนักงาน A";
  })());
  ok("note carried through", rows.find((x) => x.id === w2)?.note === "แตกตอนขน");

  const sum = wasteSummary(A, "2026-09");
  ok("summary: total value 700, 3 events", sum.totalValue === 700 && sum.totalEvents === 3);
  ok("summary: by reason expired 500 (2), damaged 200 (1), sorted by value", (() => {
    const exp = sum.byReason.find((b) => b.reason === "expired");
    const dmg = sum.byReason.find((b) => b.reason === "damaged");
    return !!exp && exp.value === 500 && exp.qtyEvents === 2 && !!dmg && dmg.value === 200 && sum.byReason[0].reason === "expired";
  })());
  ok("summary: top item = นมสด (2 events, qty 5, value 500)", (() => {
    const top = sum.topItems[0];
    return top.item_name === "นมสด" && top.qtyEvents === 2 && top.totalQty === 5 && top.value === 500;
  })());

  // Cost snapshot: changing the item's cost later does NOT change past entries.
  db.prepare("UPDATE inventa_items SET unit_cost = 999 WHERE id = ?").run(it1);
  ok("snapshot: past value unchanged after item cost edit", wasteSummary(A, "2026-09").totalValue === 700);

  // Other month is empty.
  ok("summary: other month is empty", wasteSummary(A, "2026-08").totalEvents === 0 && wasteSummary(A, "2026-08").totalValue === 0);

  // Log-only: current_qty untouched.
  ok("log-only: item current_qty not decremented", (db.prepare("SELECT current_qty FROM inventa_items WHERE id = ?").get(it1) as { current_qty: number }).current_qty === 0);

  console.log(`\ninventa-waste test: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
