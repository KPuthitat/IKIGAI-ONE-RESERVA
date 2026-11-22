// Revenue-share daily income that was mirrored into the SELLING branch's own ACCOUNTA รายรับ (owner 2026-11-22).
// The partner's sales are rung on the seller's POS, so they are already in the seller's sales; the copy counts
// them twice. These are the rows to remove: source='revshare', in the branch that is the partner's seller branch,
// under the partner's shop name. Rows in the partner's OWN branch (e.g. ศาลาชิลล์) are not touched.

import { getDb } from "./db";
import { partnerShopName } from "./revshare";

export type DoubleCounted = { id: number; branchId: number; branch: string | null; date: string; channel: string | null; amount: number };

export function findSellerBranchRevshareIncome(): DoubleCounted[] {
  const db = getDb();
  const partners = db.prepare("SELECT branch_id, name, venue FROM revshare_partners").all() as Array<{ branch_id: number; name: string; venue: string | null }>;
  const rows = db.prepare(`SELECT ai.id, ai.branch_id AS branchId, b.name AS branch, ai.income_date AS date, ai.channel, ai.amount
      FROM accounta_income ai LEFT JOIN branches b ON b.id = ai.branch_id WHERE ai.source = 'revshare' ORDER BY ai.income_date, ai.id`).all() as DoubleCounted[];
  const sellerShops = new Set(partners.map((p) => `${p.branch_id}|${partnerShopName(p)}`));
  return rows.filter((r) => r.channel != null && sellerShops.has(`${r.branchId}|${r.channel}`));
}

/** Deletes them (only when `apply`) and returns what was / would be removed. */
export function removeSellerBranchRevshareIncome(apply: boolean): { rows: DoubleCounted[]; total: number } {
  const rows = findSellerBranchRevshareIncome();
  if (apply && rows.length) {
    const del = getDb().prepare("DELETE FROM accounta_income WHERE id = ? AND source = 'revshare'");
    getDb().transaction(() => { for (const r of rows) del.run(r.id); })();
  }
  return { rows, total: Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100 };
}
