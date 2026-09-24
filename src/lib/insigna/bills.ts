// INSIGNA — Bill ↔ customer links + per-customer CRM roll-up (Phase 1,
// owner 2026-09-24).
//
// Staff tie a POS receipt (salesa_receipts, keyed branch+date+bill_no) to a
// customer's pseudonym. From the linked receipts we roll up what THIS customer
// orders, spends, when they come and how often — the per-person layer the raw
// import can't give on its own. No PII: everything hangs off customer_hash.

import { getDb } from "../db";
import { aliasLabelMap } from "../salesa-db";

export type LinkBillArgs = {
  customer_hash: string;
  branch_id: number;
  sale_date: string;   // YYYY-MM-DD
  bill_no: string;
  linked_by?: number | null;
};

export type LinkResult =
  | "linked"
  | "receipt_not_found"
  | "already_yours"
  | "linked_to_other";

/** Link a receipt to a customer. Validates the receipt exists; refuses to steal
 *  a bill already tied to a different customer (staff must unlink first). */
export function linkBill(args: LinkBillArgs): LinkResult {
  const db = getDb();
  const receipt = db.prepare(
    "SELECT 1 FROM salesa_receipts WHERE branch_id = ? AND sale_date = ? AND bill_no = ?"
  ).get(args.branch_id, args.sale_date, args.bill_no);
  if (!receipt) return "receipt_not_found";

  const existing = db.prepare(
    "SELECT customer_hash FROM insigna_customer_bills WHERE branch_id = ? AND sale_date = ? AND bill_no = ?"
  ).get(args.branch_id, args.sale_date, args.bill_no) as { customer_hash: string } | undefined;
  if (existing) {
    return existing.customer_hash === args.customer_hash ? "already_yours" : "linked_to_other";
  }

  db.prepare(`
    INSERT INTO insigna_customer_bills (customer_hash, branch_id, sale_date, bill_no, linked_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(args.customer_hash, args.branch_id, args.sale_date, args.bill_no, args.linked_by ?? null);
  return "linked";
}

/** Remove a bill link (staff correction). No-op if it wasn't linked. */
export function unlinkBill(branch_id: number, sale_date: string, bill_no: string): void {
  getDb().prepare(
    "DELETE FROM insigna_customer_bills WHERE branch_id = ? AND sale_date = ? AND bill_no = ?"
  ).run(branch_id, sale_date, bill_no);
}

export type LinkedBill = {
  branch_id: number;
  sale_date: string;
  bill_no: string;
  receipt_id: string | null;
  hour: number;
  table_name: string | null;
  nett: number;
};

/** A customer's linked bills, newest first, joined to receipt totals. */
export function listLinkedBills(customer_hash: string): LinkedBill[] {
  return getDb().prepare(`
    SELECT r.branch_id, r.sale_date, r.bill_no, r.receipt_id, r.hour, r.table_name, r.nett
    FROM insigna_customer_bills l
    JOIN salesa_receipts r
      ON r.branch_id = l.branch_id AND r.sale_date = l.sale_date AND r.bill_no = l.bill_no
    WHERE l.customer_hash = ?
    ORDER BY r.sale_date DESC, r.hour DESC
  `).all(customer_hash) as LinkedBill[];
}

export type ReceiptRef = { branch_id: number; sale_date: string; bill_no: string };

/** Resolve FeedMe's long global receipt id to its (branch, date, bill) key.
 *  Returns null when no imported receipt carries that id. The id is globally
 *  unique in practice; if it somehow repeats, the most recent bill wins. */
export function findReceiptByReceiptId(receipt_id: string): ReceiptRef | null {
  const id = receipt_id.trim();
  if (!id) return null;
  const row = getDb().prepare(
    `SELECT branch_id, sale_date, bill_no FROM salesa_receipts
     WHERE receipt_id = ? ORDER BY sale_date DESC, hour DESC LIMIT 1`
  ).get(id) as ReceiptRef | undefined;
  return row ?? null;
}

// NOTE: linking by receipt id is intentionally NOT a one-shot helper. The
// caller must resolve the id (findReceiptByReceiptId), enforce branch access
// against the RESOLVED ref.branch_id, and only then linkBill — otherwise a
// scanned id could attach a receipt of a branch the caller doesn't administer.
// See the link_by_id branch in the bills API route for the canonical flow.

export type CustomerBillStats = {
  billCount: number;
  totalNett: number;
  avgNett: number | null;
  firstVisit: string | null;
  lastVisit: string | null;
  distinctDays: number;      // how many separate days they came (frequency)
  peakHour: number | null;   // most common arrival hour across linked bills
  topItems: Array<{ name: string; qty: number }>;
};

/** Roll a customer's linked receipts into a CRM snapshot: spend, cadence,
 *  favourite items and their usual hour. All from POS data, no PII. */
export function customerBillStats(customer_hash: string, topN = 5): CustomerBillStats {
  const db = getDb();
  const bills = db.prepare(`
    SELECT r.sale_date, r.hour, r.nett
    FROM insigna_customer_bills l
    JOIN salesa_receipts r
      ON r.branch_id = l.branch_id AND r.sale_date = l.sale_date AND r.bill_no = l.bill_no
    WHERE l.customer_hash = ?
  `).all(customer_hash) as Array<{ sale_date: string; hour: number; nett: number }>;

  const empty: CustomerBillStats = {
    billCount: 0, totalNett: 0, avgNett: null, firstVisit: null, lastVisit: null,
    distinctDays: 0, peakHour: null, topItems: []
  };
  if (!bills.length) return empty;

  let total = 0;
  const days = new Set<string>();
  const hourCount = new Map<number, number>();
  let first = bills[0].sale_date, last = bills[0].sale_date;
  for (const b of bills) {
    total += b.nett;
    days.add(b.sale_date);
    hourCount.set(b.hour, (hourCount.get(b.hour) ?? 0) + 1);
    if (b.sale_date < first) first = b.sale_date;
    if (b.sale_date > last) last = b.sale_date;
  }
  // Deterministic peak: most-common hour, earliest hour wins a tie.
  let peakHour: number | null = null, peakN = -1;
  for (const [h, n] of hourCount) {
    if (n > peakN || (n === peakN && (peakHour === null || h < peakHour))) { peakN = n; peakHour = h; }
  }

  // Keep branch_id so renamed dishes fold via that branch's alias map (Phase 2):
  // "ตับหวาน" and "ตับหวานอัลตราสมูธ" count as one favourite.
  const rawItems = db.prepare(`
    SELECT i.branch_id AS branch_id, i.name AS name, SUM(i.qty) AS qty
    FROM insigna_customer_bills l
    JOIN salesa_receipt_items i
      ON i.branch_id = l.branch_id AND i.sale_date = l.sale_date AND i.bill_no = l.bill_no
    WHERE l.customer_hash = ?
    GROUP BY i.branch_id, i.name
  `).all(customer_hash) as Array<{ branch_id: number; name: string; qty: number }>;

  // Merge the alias maps of every branch this customer visited into ONE
  // name→label map, then fold regardless of which branch a bill was at. This
  // still groups a raw spelling used at branch B under a group label confirmed
  // at branch A (a customer who visits both shouldn't see the dish split).
  const merged = new Map<string, string>();
  for (const branchId of new Set(rawItems.map((r) => r.branch_id))) {
    for (const [name, label] of aliasLabelMap(branchId)) {
      if (!merged.has(name)) merged.set(name, label);
    }
  }
  const byLabel = new Map<string, number>();
  for (const r of rawItems) {
    const label = merged.get(r.name) ?? r.name;
    byLabel.set(label, (byLabel.get(label) ?? 0) + Number(r.qty));
  }
  const topItems = [...byLabel.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "th"))
    .slice(0, topN)
    .map(([name, qty]) => ({ name, qty }));

  return {
    billCount: bills.length,
    totalNett: Math.round(total * 100) / 100,
    avgNett: Math.round((total / bills.length) * 100) / 100,
    firstVisit: first,
    lastVisit: last,
    distinctDays: days.size,
    peakHour,
    topItems
  };
}
