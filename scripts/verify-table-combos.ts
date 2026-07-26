// Fixture: buildCombos — table-merging brain (owner 2026-07-26). Adjacent =
// consecutive sort_order within a zone; a booked table breaks the run so tables
// across it can't merge. Single-that-fits wins; else same-zone least-waste;
// cross-zone is a last resort.
// Run:  node --import tsx scripts/verify-table-combos.ts
import { buildCombos, type TableCombo } from "../src/lib/table-allocator";
import type { TableRow } from "../src/lib/db";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}
let id = 0;
function t(label: string, zone: number | null, cap: number, free = true): TableRow & { free: boolean } {
  return { id: ++id, branch_id: 1, zone_id: zone, label, capacity: cap, shape: "rect",
    x: 0, y: 0, width: 80, height: 80, active: 1, sort_order: id * 10, free };
}
const labels = (c: TableCombo) => c.tables.map((x) => x.label).join("+");

// Zone C (CENTER): C1,C2,C3 all cap 4.  Zone G (GLASSHOUSE): G1(4),G2(2),G3(4).
function center() { return [t("C1", 1, 4), t("C2", 1, 4), t("C3", 1, 4)]; }

// 6 people, all free → C1+C2 (waste 2) is the top same-zone combo; C1+C3 never.
{
  const combos = buildCombos([...center()], 6);
  assert(labels(combos[0]) === "C1+C2", "6 ppl → merges the first adjacent pair C1+C2");
  assert(!combos.some((c) => labels(c) === "C1+C3"), "never suggests C1+C3 (skips C2 — not adjacent)");
  assert(combos[0].waste === 2 && combos[0].totalCapacity === 8, "combo waste + capacity correct");
}

// Exact fit beats a wasteful one: zone with G5(4)+G6(2) adjacent → 6 exact wins.
{
  const g = [t("G5", 2, 4), t("G6", 2, 2)];          // adjacent, sum 6
  const c = center();                                  // C1+C2 = 8 (waste 2)
  const combos = buildCombos([...c, ...g], 6);
  assert(labels(combos[0]) === "G5+G6", "picks the exact-fit pair (waste 0) over the wasteful one");
  assert(combos[0].waste === 0, "exact fit has zero waste");
}

// A booked middle table breaks adjacency: C2 taken → C1 and C3 can't merge,
// and with no other zone the party simply can't be auto-seated.
{
  const rows = [t("C1", 1, 4), t("C2", 1, 4, false), t("C3", 1, 4)];
  const combos = buildCombos(rows, 6);
  assert(combos.length === 0, "C2 booked + no other zone → cannot seat (never bridges to C1+C3)");
}

// Same, but a second zone exists → cross-zone last resort (C1 + the other zone).
{
  const rows = [t("C1", 1, 4), t("C2", 1, 4, false), t("C3", 1, 4), t("G1", 2, 4)];
  const combos = buildCombos(rows, 6);
  assert(combos.length === 1 && combos[0].crossZone === true, "with another zone → cross-zone merge");
  assert(!combos[0].tables.some((x) => x.label === "C1") || !combos[0].tables.some((x) => x.label === "C3"),
    "cross-zone combo never contains both C1 and C3 (non-adjacent same zone)");
}

// Single table that fits is preferred over merging (rule 1).
{
  const rows = [t("A1", 1, 4), t("A2", 1, 4), t("BIG", 2, 8)];
  const combos = buildCombos(rows, 6);
  assert(labels(combos[0]) === "BIG", "a single table that seats the party wins over a merge");
}

// No limit on table count: 10 people in a zone of 4-seaters → C1+C2+C3.
{
  const combos = buildCombos([...center()], 10);
  assert(labels(combos[0]) === "C1+C2+C3", "merges 3 adjacent tables when needed (no cap)");
  assert(combos[0].totalCapacity === 12, "three-table combo capacity");
}

// Cross-zone only as last resort: 6 ppl, each zone has a single free 4-seater.
{
  const rows = [t("C1", 1, 4), t("G1", 2, 4)];        // not same-zone adjacent
  const combos = buildCombos(rows, 6);
  assert(combos.length === 1 && combos[0].crossZone === true, "cross-zone merge used when no zone fits");
  assert(combos[0].totalCapacity === 8, "cross-zone combo capacity");
}

console.log("\nALL TABLE-COMBO FIXTURES PASSED");
