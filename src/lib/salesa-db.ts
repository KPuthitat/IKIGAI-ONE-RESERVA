// SALESA — data-access layer for daily POS sales analytics (owner 2026-09-16).
// Schema lives in db.ts (salesa_daily / salesa_menu / salesa_weekly_sent /
// salesa_settings). This module upserts imported files, reads the dashboard
// views, and stores the HOD LINE-group binding.

import { getDb } from "./db";
import type { SalesCloseUp, SalesOverview, SalesReceipt, PayEntry, TypeEntry, MenuEntry } from "./salesa-parse";
import { groupLabel, pairKey, findMergeCandidates, type MergeCandidate } from "./salesa-names";

export type DailyRow = {
  branch_id: number;
  sale_date: string;
  merchant: string | null;
  nett: number;
  gross: number;
  gross_before_charges: number;
  discount: number;
  service_charge: number;
  vat: number;
  rounding: number;
  delivery_fee: number;
  other_charge: number;
  bill_count: number;
  pax: number;
  void_amount: number;
  void_bill_count: number;
  refund: number;
  avg_sales: number;
  avg_pax: number;
  avg_sales_pax: number;
  payments: PayEntry[];
  types: TypeEntry[];
  sources: TypeEntry[];
  has_sales: number;
  has_menu: number;
  has_receipt: number;
  daily_sent_at: string | null;
  imported_at: string;
};

type RawDaily = Omit<DailyRow, "payments" | "types" | "sources"> & {
  payments_json: string; types_json: string; sources_json: string;
};

function hydrate(r: RawDaily): DailyRow {
  const safe = <T>(s: string, fallback: T): T => { try { return JSON.parse(s) as T; } catch { return fallback; } };
  const { payments_json, types_json, sources_json, ...rest } = r;
  return {
    ...rest,
    payments: safe<PayEntry[]>(payments_json, []),
    types: safe<TypeEntry[]>(types_json, []),
    sources: safe<TypeEntry[]>(sources_json, [])
  };
}

/** SALESA is available on any real branch (the operator's active branch). */
export function isSalesaBranch(branchId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM branches WHERE id = ?").get(branchId);
}

// ── Imports ──────────────────────────────────────────────────────────────

/** Upsert the close_up KPIs for a (branch, date). Preserves has_menu + sent
 *  markers; flips has_sales on. */
export function upsertDaily(branchId: number, userId: number, c: SalesCloseUp): void {
  getDb().prepare(`
    INSERT INTO salesa_daily (
      branch_id, sale_date, merchant, nett, gross, gross_before_charges, discount,
      service_charge, vat, rounding, delivery_fee, other_charge, bill_count, pax,
      void_amount, void_bill_count, refund, avg_sales, avg_pax, avg_sales_pax,
      payments_json, types_json, sources_json, has_sales, imported_by, imported_at
    ) VALUES (
      @branch_id, @sale_date, @merchant, @nett, @gross, @gross_before_charges, @discount,
      @service_charge, @vat, @rounding, @delivery_fee, @other_charge, @bill_count, @pax,
      @void_amount, @void_bill_count, @refund, @avg_sales, @avg_pax, @avg_sales_pax,
      @payments_json, @types_json, @sources_json, 1, @user, datetime('now')
    )
    ON CONFLICT(branch_id, sale_date) DO UPDATE SET
      merchant = excluded.merchant, nett = excluded.nett, gross = excluded.gross,
      gross_before_charges = excluded.gross_before_charges, discount = excluded.discount,
      service_charge = excluded.service_charge, vat = excluded.vat, rounding = excluded.rounding,
      delivery_fee = excluded.delivery_fee, other_charge = excluded.other_charge,
      bill_count = excluded.bill_count, pax = excluded.pax, void_amount = excluded.void_amount,
      void_bill_count = excluded.void_bill_count, refund = excluded.refund,
      avg_sales = excluded.avg_sales, avg_pax = excluded.avg_pax, avg_sales_pax = excluded.avg_sales_pax,
      payments_json = excluded.payments_json, types_json = excluded.types_json,
      sources_json = excluded.sources_json, has_sales = 1,
      imported_by = excluded.imported_by, imported_at = datetime('now')
  `).run({
    branch_id: branchId, sale_date: c.date, merchant: c.merchant, nett: c.nett, gross: c.gross,
    gross_before_charges: c.grossBeforeCharges, discount: c.discount, service_charge: c.serviceCharge,
    vat: c.vat, rounding: c.rounding, delivery_fee: c.deliveryFee, other_charge: c.otherCharge,
    bill_count: c.billCount, pax: c.pax, void_amount: c.voidAmount, void_bill_count: c.voidBillCount,
    refund: c.refund, avg_sales: c.avgSales, avg_pax: c.avgPax, avg_sales_pax: c.avgSalesPax,
    payments_json: JSON.stringify(c.payments), types_json: JSON.stringify(c.types),
    sources_json: JSON.stringify(c.sources), user: userId
  });
}

/** Upsert the menu-revenue ranking for a (branch, date). Ensures a daily row
 *  exists (so a menu-only import still shows up), flips has_menu on, and
 *  replaces that day's menu rows. */
export function upsertMenu(branchId: number, userId: number, o: SalesOverview): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO salesa_daily (branch_id, sale_date, merchant, has_menu, imported_by, imported_at)
      VALUES (?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(branch_id, sale_date) DO UPDATE SET
        has_menu = 1,
        merchant = COALESCE(salesa_daily.merchant, excluded.merchant),
        imported_by = excluded.imported_by
    `).run(branchId, o.date, o.merchant, userId);
    db.prepare("DELETE FROM salesa_menu WHERE branch_id = ? AND sale_date = ?").run(branchId, o.date);
    // ON CONFLICT: a POS export may still list the same name twice — sum it in
    // rather than crash the import on the PRIMARY KEY (owner 2026-09-20).
    const ins = db.prepare(
      `INSERT INTO salesa_menu (branch_id, sale_date, kind, name, nett, rank) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, sale_date, kind, name) DO UPDATE SET nett = nett + excluded.nett`
    );
    const write = (kind: "item" | "category", list: MenuEntry[]) =>
      list.forEach((m, i) => ins.run(branchId, o.date, kind, m.name, m.nett, i + 1));
    write("item", o.items);
    write("category", o.categories);
  });
  tx();
}

/** Upsert per-bill receipts + items for a (branch, date). Ensures a daily row
 *  exists, flips has_receipt on, and replaces that day's receipts. */
export function upsertReceipts(branchId: number, userId: number, r: SalesReceipt): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO salesa_daily (branch_id, sale_date, merchant, has_receipt, imported_by, imported_at)
      VALUES (?, ?, ?, 1, ?, datetime('now'))
      ON CONFLICT(branch_id, sale_date) DO UPDATE SET
        has_receipt = 1,
        merchant = COALESCE(salesa_daily.merchant, excluded.merchant),
        imported_by = excluded.imported_by
    `).run(branchId, r.date, r.merchant, userId);
    db.prepare("DELETE FROM salesa_receipts WHERE branch_id = ? AND sale_date = ?").run(branchId, r.date);
    db.prepare("DELETE FROM salesa_receipt_items WHERE branch_id = ? AND sale_date = ?").run(branchId, r.date);
    const insB = db.prepare(
      `INSERT INTO salesa_receipts (branch_id, sale_date, bill_no, hour, table_name, gross, discount, nett, payment, is_staff, is_takeaway, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insI = db.prepare(
      `INSERT INTO salesa_receipt_items (branch_id, sale_date, bill_no, name, qty) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(branch_id, sale_date, bill_no, name) DO UPDATE SET qty = qty + excluded.qty`
    );
    for (const b of r.bills) {
      insB.run(branchId, r.date, b.billNo, b.hour, b.table, b.gross, b.discount, b.nett, b.payment, b.isStaff ? 1 : 0, b.isTakeaway ? 1 : 0, b.receiptId || null);
      for (const it of b.items) insI.run(branchId, r.date, b.billNo, it.name, it.qty);
    }
  });
  tx();
}

/** Which file kinds a (branch, date) already has data for. Used to warn the
 *  importer that re-importing overwrites existing data (owner 2026-09-19). */
export function existingKinds(branchId: number, date: string): { sales: boolean; menu: boolean; receipt: boolean } {
  const r = getDb().prepare(
    "SELECT has_sales, has_menu, has_receipt FROM salesa_daily WHERE branch_id = ? AND sale_date = ?"
  ).get(branchId, date) as { has_sales: number; has_menu: number; has_receipt: number } | undefined;
  return { sales: !!r?.has_sales, menu: !!r?.has_menu, receipt: !!r?.has_receipt };
}

// ── Menu-name aliasing (owner 2026-09-20) ──────────────────────────────────
// A branch may rename a dish over time; once the owner confirms two spellings
// are the same item they share a `root`, and reads below fold members together
// under a joined display label. Non-destructive: the raw rows keep their names,
// so a merge is fully reversible (delete the group).

/** name → display label for a branch, from confirmed alias groups. Names not in
 *  any group are absent (they resolve to themselves). Range-independent — built
 *  from the whole alias table — so a group's label is identical in every view
 *  and period (keeping cross-period matching, e.g. momentum, correct). */
export function aliasLabelMap(branchId: number): Map<string, string> {
  const rows = getDb().prepare(
    "SELECT name, root FROM salesa_menu_alias WHERE branch_id = ?"
  ).all(branchId) as Array<{ name: string; root: string }>;
  if (!rows.length) return new Map();
  const byRoot = new Map<string, string[]>();
  for (const r of rows) { const a = byRoot.get(r.root) ?? []; a.push(r.name); byRoot.set(r.root, a); }
  const out = new Map<string, string>();
  for (const members of byRoot.values()) {
    const label = groupLabel(members);
    for (const m of members) out.set(m, label);
  }
  return out;
}

export type MenuGroup = { root: string; members: string[]; label: string };

/** Confirmed "same dish" groups for a branch. */
export function listMenuGroups(branchId: number): MenuGroup[] {
  const rows = getDb().prepare(
    "SELECT name, root FROM salesa_menu_alias WHERE branch_id = ? ORDER BY root, name"
  ).all(branchId) as Array<{ name: string; root: string }>;
  const byRoot = new Map<string, string[]>();
  for (const r of rows) { const a = byRoot.get(r.root) ?? []; a.push(r.name); byRoot.set(r.root, a); }
  return [...byRoot.entries()]
    .map(([root, members]) => ({ root, members, label: groupLabel(members) }))
    .sort((a, b) => a.label.localeCompare(b.label, "th"));
}

/** Distinct item names for a branch, across both the menu-revenue ranking and
 *  the per-bill receipt items (the two namespaces the reports aggregate). */
export function distinctItemNames(branchId: number): string[] {
  return (getDb().prepare(
    `SELECT name FROM salesa_menu WHERE branch_id = ? AND kind = 'item'
     UNION
     SELECT name FROM salesa_receipt_items WHERE branch_id = ?`
  ).all(branchId, branchId) as Array<{ name: string }>).map((r) => r.name);
}

/** Per raw-name totals (revenue + units) — context for the merge review UI. */
export function rawNameStats(branchId: number): Map<string, { nett: number; units: number }> {
  const m = new Map<string, { nett: number; units: number }>();
  const bump = (name: string, nett: number, units: number) => {
    const e = m.get(name) ?? { nett: 0, units: 0 };
    e.nett += nett; e.units += units; m.set(name, e);
  };
  for (const r of getDb().prepare(
    "SELECT name, SUM(nett) AS nett FROM salesa_menu WHERE branch_id = ? AND kind = 'item' GROUP BY name"
  ).all(branchId) as Array<{ name: string; nett: number }>) bump(r.name, r.nett, 0);
  for (const r of getDb().prepare(
    "SELECT name, SUM(qty) AS units FROM salesa_receipt_items WHERE branch_id = ? GROUP BY name"
  ).all(branchId) as Array<{ name: string; units: number }>) bump(r.name, 0, r.units);
  return m;
}

function ignoredPairKeys(branchId: number): Set<string> {
  return new Set((getDb().prepare(
    "SELECT pair_key FROM salesa_menu_pair_ignored WHERE branch_id = ?"
  ).all(branchId) as Array<{ pair_key: string }>).map((r) => r.pair_key));
}

export type MergeSuggestion = MergeCandidate & {
  aStats: { nett: number; units: number };
  bStats: { nett: number; units: number };
};

/** Suggest pairs of item names that might be the same dish, most-confident
 *  first, excluding pairs already merged or marked "not the same". */
export function suggestMenuMerges(branchId: number, limit = 40): MergeSuggestion[] {
  const names = distinctItemNames(branchId);
  const decided = ignoredPairKeys(branchId);
  // Never re-suggest two names already in the same confirmed group.
  for (const g of listMenuGroups(branchId)) {
    for (let i = 0; i < g.members.length; i++)
      for (let j = i + 1; j < g.members.length; j++)
        decided.add(pairKey(g.members[i], g.members[j]));
  }
  const stats = rawNameStats(branchId);
  return findMergeCandidates(names, decided, limit).map((c) => ({
    ...c,
    aStats: stats.get(c.a) ?? { nett: 0, units: 0 },
    bStats: stats.get(c.b) ?? { nett: 0, units: 0 }
  }));
}

/** Confirm a set of names are one dish (union-find on `root`). Reuses an
 *  existing group's root when any selected name already belongs to one, so
 *  merging into or across groups collapses them into a single group. */
export function mergeMenuNames(branchId: number, names: string[], userId: number): { root: string } | null {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (clean.length < 2) return null;
  const db = getDb();
  const tx = db.transaction(() => {
    const q = db.prepare("SELECT root FROM salesa_menu_alias WHERE branch_id = ? AND name = ?");
    const roots = new Set<string>();
    for (const n of clean) {
      const r = q.get(branchId, n) as { root: string } | undefined;
      if (r) roots.add(r.root);
    }
    const pickStable = (xs: string[]) =>
      [...xs].sort((a, b) => (a.length - b.length) || a.localeCompare(b, "th"))[0];
    const root = roots.size ? pickStable([...roots]) : pickStable(clean);
    if (roots.size) {
      const upd = db.prepare("UPDATE salesa_menu_alias SET root = ? WHERE branch_id = ? AND root = ?");
      for (const r of roots) if (r !== root) upd.run(root, branchId, r);
    }
    const ins = db.prepare(
      `INSERT INTO salesa_menu_alias (branch_id, name, root, decided_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(branch_id, name) DO UPDATE SET root = excluded.root, decided_by = excluded.decided_by, decided_at = datetime('now')`
    );
    for (const n of clean) ins.run(branchId, n, root, userId);
    ins.run(branchId, root, root, userId); // the root is a member of its own group
    // A merge overrides any earlier "not the same" decision among these names.
    const delIgnore = db.prepare("DELETE FROM salesa_menu_pair_ignored WHERE branch_id = ? AND pair_key = ?");
    for (let i = 0; i < clean.length; i++)
      for (let j = i + 1; j < clean.length; j++)
        delIgnore.run(branchId, pairKey(clean[i], clean[j]));
    return root;
  });
  return { root: tx() as string };
}

/** Record that two names are NOT the same dish (so the detector stops suggesting
 *  them). Harmless no-op if they're already grouped. */
export function ignoreMenuPair(branchId: number, a: string, b: string, userId: number): void {
  getDb().prepare(
    `INSERT INTO salesa_menu_pair_ignored (branch_id, pair_key, decided_by) VALUES (?, ?, ?)
     ON CONFLICT(branch_id, pair_key) DO NOTHING`
  ).run(branchId, pairKey(a, b), userId);
}

/** Dissolve a confirmed group (un-merge) — reads revert to per-name counts. */
export function unmergeMenuGroup(branchId: number, root: string): number {
  return getDb().prepare(
    "DELETE FROM salesa_menu_alias WHERE branch_id = ? AND root = ?"
  ).run(branchId, root).changes as number;
}

// ── Reads ────────────────────────────────────────────────────────────────

export function getDaily(branchId: number, date: string): DailyRow | null {
  const r = getDb().prepare("SELECT * FROM salesa_daily WHERE branch_id = ? AND sale_date = ?")
    .get(branchId, date) as RawDaily | undefined;
  return r ? hydrate(r) : null;
}

/** Daily rows within [start, end] inclusive, ascending. */
export function listRange(branchId: number, start: string, end: string): DailyRow[] {
  return (getDb().prepare(
    "SELECT * FROM salesa_daily WHERE branch_id = ? AND sale_date BETWEEN ? AND ? ORDER BY sale_date ASC"
  ).all(branchId, start, end) as RawDaily[]).map(hydrate);
}

export function listMonth(branchId: number, year: number, month: number): DailyRow[] {
  const mm = String(month).padStart(2, "0");
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return listRange(branchId, `${year}-${mm}-01`, `${year}-${mm}-${String(last).padStart(2, "0")}`);
}

/** The branch's authoritative opening date (branches.opens_on, YYYY-MM-DD) or
 *  null if unset. Used to tell whether a branch OPENED this year — so its annual
 *  target is prorated to its available span rather than a full 12 months
 *  (owner 2026-09-21: ไฮโปเปิด 25/07 เป้าทั้งปีต้องคิดจากวันที่ available จริง). We key
 *  off opens_on, NOT the first imported sale: SALESA data only starts in 2026, so
 *  a first-sale heuristic would wrongly prorate every long-standing branch. */
export function branchOpensOn(branchId: number): string | null {
  const r = getDb().prepare(
    "SELECT opens_on FROM branches WHERE id = ?"
  ).get(branchId) as { opens_on: string | null } | undefined;
  return r?.opens_on ?? null;
}

/** Set a branch's authoritative opening date (branches.opens_on, YYYY-MM-DD).
 *  Same column RESERVA settings writes — surfaced in ANALYTICA settings too so
 *  the annual target/projection for a mid-year branch can be prorated from it
 *  (owner 2026-09-24). Blank/invalid clears it. */
export function setBranchOpensOn(branchId: number, iso: string | null): void {
  const t = iso?.trim() ?? "";
  // Require a REAL calendar date, not just the shape — "2026-02-31" matches the
  // regex but is not a date, and would produce NaN in the annual projection.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(t) ? new Date(`${t}T00:00:00Z`) : null;
  const clean = d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
  getDb().prepare("UPDATE branches SET opens_on = ? WHERE id = ?").run(clean, branchId);
}

export function getMenu(branchId: number, date: string): { items: MenuEntry[]; categories: MenuEntry[] } {
  const rows = getDb().prepare(
    "SELECT kind, name, nett, rank FROM salesa_menu WHERE branch_id = ? AND sale_date = ? ORDER BY rank ASC"
  ).all(branchId, date) as Array<{ kind: string; name: string; nett: number; rank: number }>;
  const map = aliasLabelMap(branchId);
  // Fold merged spellings within the day, keeping the best (lowest) rank so the
  // display order is preserved. Aliasing is an ITEM concern only — categories
  // keep their raw names (the alias map is built from item/receipt names).
  const fold = (kind: "item" | "category"): MenuEntry[] => {
    const agg = new Map<string, { nett: number; rank: number }>();
    for (const r of rows) {
      if (r.kind !== kind) continue;
      const label = kind === "item" ? (map.get(r.name) ?? r.name) : r.name;
      const cur = agg.get(label);
      if (cur) { cur.nett += r.nett; cur.rank = Math.min(cur.rank, r.rank); }
      else agg.set(label, { nett: r.nett, rank: r.rank });
    }
    return [...agg.entries()]
      .sort((a, b) => a[1].rank - b[1].rank)
      .map(([name, v]) => ({ name, nett: v.nett }));
  };
  return { items: fold("item"), categories: fold("category") };
}

/** Menu revenue aggregated over [start, end] (for the weekly card), with merged
 *  spellings folded under their shared display label. */
export function menuRange(branchId: number, start: string, end: string, kind: "item" | "category"): MenuEntry[] {
  const rows = getDb().prepare(
    `SELECT name, SUM(nett) AS nett FROM salesa_menu
     WHERE branch_id = ? AND kind = ? AND sale_date BETWEEN ? AND ?
     GROUP BY name`
  ).all(branchId, kind, start, end) as Array<{ name: string; nett: number }>;
  // Aliasing is an item concern only; categories keep their raw names.
  const map = kind === "item" ? aliasLabelMap(branchId) : new Map<string, string>();
  const agg = new Map<string, number>();
  for (const r of rows) {
    const label = map.get(r.name) ?? r.name;
    agg.set(label, (agg.get(label) ?? 0) + r.nett);
  }
  return [...agg.entries()]
    .map(([name, nett]) => ({ name, nett: Math.round((nett + Number.EPSILON) * 100) / 100 }))
    .sort((a, b) => b.nett - a.nett);
}

// ── Receipt reads (owner 2026-09-18: hourly + basket, excl STAFF) ────────────

/** Bills + nett per hour over [start, end], excluding staff bills. */
export function hourlyReceipts(branchId: number, start: string, end: string): Array<{ hour: number; bills: number; nett: number }> {
  return (getDb().prepare(
    `SELECT hour, COUNT(*) AS bills, SUM(nett) AS nett FROM salesa_receipts
     WHERE branch_id = ? AND sale_date BETWEEN ? AND ? AND is_staff = 0
     GROUP BY hour ORDER BY hour`
  ).all(branchId, start, end) as Array<{ hour: number; bills: number; nett: number }>)
    .map((r) => ({ hour: r.hour, bills: r.bills, nett: Math.round((r.nett + Number.EPSILON) * 100) / 100 }));
}

/** Units sold per item over [start, end], excluding staff bills, with merged
 *  spellings folded under their shared display label. Folds at the bill level so
 *  a single bill listing two spellings of one dish counts as one bill, not two
 *  (units still sum). */
export function itemUnitsRange(branchId: number, start: string, end: string): Array<{ name: string; units: number; bills: number }> {
  const rows = getDb().prepare(
    `SELECT i.name AS name, i.bill_no AS bill, SUM(i.qty) AS qty
     FROM salesa_receipt_items i
     JOIN salesa_receipts r ON r.branch_id = i.branch_id AND r.sale_date = i.sale_date AND r.bill_no = i.bill_no
     WHERE i.branch_id = ? AND i.sale_date BETWEEN ? AND ? AND r.is_staff = 0
     GROUP BY i.name, i.sale_date, i.bill_no`
  ).all(branchId, start, end) as Array<{ name: string; bill: string; qty: number }>;
  const map = aliasLabelMap(branchId);
  const agg = new Map<string, { units: number; bills: Set<string> }>();
  for (const r of rows) {
    const label = map.get(r.name) ?? r.name;
    const e = agg.get(label) ?? { units: 0, bills: new Set<string>() };
    e.units += r.qty; e.bills.add(r.bill); agg.set(label, e);
  }
  return [...agg.entries()]
    .map(([name, e]) => ({ name, units: e.units, bills: e.bills.size }))
    .sort((a, b) => b.units - a.units);
}

/** Per-bill item name lists over [start, end], excluding staff bills (basket).
 *  Names fold to their merged label and are de-duplicated within a bill, so a
 *  bill listing two spellings of one dish counts it once. */
export function receiptItemSets(branchId: number, start: string, end: string): string[][] {
  const rows = getDb().prepare(
    `SELECT i.bill_no AS bill, i.name AS name
     FROM salesa_receipt_items i
     JOIN salesa_receipts r ON r.branch_id = i.branch_id AND r.sale_date = i.sale_date AND r.bill_no = i.bill_no
     WHERE i.branch_id = ? AND i.sale_date BETWEEN ? AND ? AND r.is_staff = 0`
  ).all(branchId, start, end) as Array<{ bill: string; name: string }>;
  const map = aliasLabelMap(branchId);
  const byBill = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = byBill.get(r.bill) ?? new Set<string>();
    s.add(map.get(r.name) ?? r.name);
    byBill.set(r.bill, s);
  }
  return [...byBill.values()].map((s) => [...s]);
}

export function hasReceiptData(branchId: number, start: string, end: string): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM salesa_receipts WHERE branch_id = ? AND sale_date BETWEEN ? AND ? LIMIT 1"
  ).get(branchId, start, end);
}

// ── Mutations ──────────────────────────────────────────────────────────────

export function clearDay(branchId: number, date: string): number {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM salesa_menu WHERE branch_id = ? AND sale_date = ?").run(branchId, date);
    db.prepare("DELETE FROM salesa_receipt_items WHERE branch_id = ? AND sale_date = ?").run(branchId, date);
    db.prepare("DELETE FROM salesa_receipts WHERE branch_id = ? AND sale_date = ?").run(branchId, date);
    return db.prepare("DELETE FROM salesa_daily WHERE branch_id = ? AND sale_date = ?").run(branchId, date).changes;
  });
  return tx() as number;
}

/** Every imported day's (date, merchant) — for the wrong-shop cleanup. */
export function listDayMerchants(branchId: number): Array<{ date: string; merchant: string | null }> {
  return (getDb().prepare(
    "SELECT sale_date AS date, merchant FROM salesa_daily WHERE branch_id = ? ORDER BY sale_date"
  ).all(branchId) as Array<{ date: string; merchant: string | null }>);
}

export function markDailySent(branchId: number, date: string, userId: number): void {
  getDb().prepare(
    "UPDATE salesa_daily SET daily_sent_at = datetime('now'), daily_sent_by = ? WHERE branch_id = ? AND sale_date = ?"
  ).run(userId, branchId, date);
}

export function markWeeklySent(branchId: number, weekStart: string, userId: number): void {
  getDb().prepare(
    `INSERT INTO salesa_weekly_sent (branch_id, week_start, sent_at, sent_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(branch_id, week_start) DO UPDATE SET sent_at = datetime('now'), sent_by = excluded.sent_by`
  ).run(branchId, weekStart, userId);
}

export function weeklySentAt(branchId: number, weekStart: string): string | null {
  const r = getDb().prepare(
    "SELECT sent_at FROM salesa_weekly_sent WHERE branch_id = ? AND week_start = ?"
  ).get(branchId, weekStart) as { sent_at: string } | undefined;
  return r?.sent_at ?? null;
}

// ── Settings (HOD LINE group) ───────────────────────────────────────────────

export function getLineGroupId(branchId: number): string | null {
  const r = getDb().prepare("SELECT line_group_id FROM salesa_settings WHERE branch_id = ?")
    .get(branchId) as { line_group_id: string | null } | undefined;
  return r?.line_group_id ?? null;
}

export function setLineGroupId(branchId: number, groupId: string | null): void {
  const clean = groupId && groupId.trim() ? groupId.trim() : null;
  getDb().prepare(
    `INSERT INTO salesa_settings (branch_id, line_group_id, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(branch_id) DO UPDATE SET line_group_id = excluded.line_group_id, updated_at = datetime('now')`
  ).run(branchId, clean);
}

// ── Expected POS merchant (owner 2026-09-17: reject wrong-branch files) ──────

export function getMerchantName(branchId: number): string | null {
  const r = getDb().prepare("SELECT merchant_name FROM salesa_settings WHERE branch_id = ?")
    .get(branchId) as { merchant_name: string | null } | undefined;
  return r?.merchant_name ?? null;
}

export function setMerchantName(branchId: number, name: string | null): void {
  const clean = name && name.trim() ? name.trim() : null;
  getDb().prepare(
    `INSERT INTO salesa_settings (branch_id, merchant_name, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(branch_id) DO UPDATE SET merchant_name = excluded.merchant_name, updated_at = datetime('now')`
  ).run(branchId, clean);
}

// ── Per-branch LINE card colour (owner 2026-09-17) ──────────────────────────

/** Default LINE card header colour (teal). */
export const SALESA_DEFAULT_CARD_COLOR = "#0e2724";
const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function getCardColor(branchId: number): string | null {
  const r = getDb().prepare("SELECT card_color FROM salesa_settings WHERE branch_id = ?")
    .get(branchId) as { card_color: string | null } | undefined;
  return r?.card_color ?? null;
}

export function setCardColor(branchId: number, color: string | null): void {
  const clean = color && HEX6.test(color.trim()) ? color.trim().toLowerCase() : null;
  getDb().prepare(
    `INSERT INTO salesa_settings (branch_id, card_color, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(branch_id) DO UPDATE SET card_color = excluded.card_color, updated_at = datetime('now')`
  ).run(branchId, clean);
}

// ── Monthly sales target (owner C) ──────────────────────────────────────────

export function getMonthlyTarget(branchId: number): number | null {
  const r = getDb().prepare("SELECT monthly_target FROM salesa_settings WHERE branch_id = ?")
    .get(branchId) as { monthly_target: number | null } | undefined;
  return r?.monthly_target ?? null;
}

/** Branch ids that have a positive monthly target — used for the company-wide
 *  annual projection (owner 2026-09-20). */
export function branchIdsWithTarget(): number[] {
  return (getDb().prepare(
    "SELECT branch_id FROM salesa_settings WHERE monthly_target IS NOT NULL AND monthly_target > 0"
  ).all() as Array<{ branch_id: number }>).map((r) => r.branch_id);
}

export function setMonthlyTarget(branchId: number, target: number | null): void {
  const clean = target != null && target > 0 ? target : null;
  getDb().prepare(
    `INSERT INTO salesa_settings (branch_id, monthly_target, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(branch_id) DO UPDATE SET monthly_target = excluded.monthly_target, updated_at = datetime('now')`
  ).run(branchId, clean);
}

// ── Monthly card sent-tracking (owner F) ────────────────────────────────────

export function markMonthlySent(branchId: number, ym: string, userId: number): void {
  getDb().prepare(
    `INSERT INTO salesa_monthly_sent (branch_id, ym, sent_at, sent_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(branch_id, ym) DO UPDATE SET sent_at = datetime('now'), sent_by = excluded.sent_by`
  ).run(branchId, ym, userId);
}

export function monthlySentAt(branchId: number, ym: string): string | null {
  const r = getDb().prepare("SELECT sent_at FROM salesa_monthly_sent WHERE branch_id = ? AND ym = ?")
    .get(branchId, ym) as { sent_at: string } | undefined;
  return r?.sent_at ?? null;
}
