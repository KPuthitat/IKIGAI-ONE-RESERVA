// Sales mix by POS category — Beer / Soft drink / จ้อจี้ (owner 2026-11-22). Shown right after a file is imported,
// for the imported day and for the month so far. Share = category nett ÷ the sum of all categories' nett (the
// Overview export's category rows). A category is put in the first group that matches: จ้อจี้ first, so the partner's
// own categories (e.g. "จ้อจี้ - SOFT DRINK") never count as the shop's own soft drink.

import { getDb } from "./db";

export type MixKey = "beer" | "soft" | "jojee" | "other";
export const MIX_LABEL: Record<MixKey, string> = { beer: "Beer", soft: "Soft drink", jojee: "จ้อจี้", other: "อื่นๆ" };

export function groupOfCategory(name: string): MixKey {
  if (/จ้อจี้|jojee|jo\s*gee/i.test(name)) return "jojee";
  if (/beer|เบียร์/i.test(name)) return "beer";
  if (/soft\s*drink|ซอฟ(ท์)?\s*ดริ[๋่้]?งค?์?|น้ำอัดลม/i.test(name)) return "soft";
  return "other";
}

export type CategoryMix = {
  from: string; to: string; total: number;
  groups: Array<{ key: MixKey; label: string; nett: number; pct: number }>;
  /** the categories that fell into "อื่นๆ", biggest first — so a wrongly grouped category is visible */
  others: Array<{ name: string; nett: number; pct: number }>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function categoryMix(branchId: number, from: string, to: string): CategoryMix | null {
  const rows = getDb().prepare("SELECT name, SUM(nett) AS nett FROM salesa_menu WHERE branch_id = ? AND kind = 'category' AND sale_date BETWEEN ? AND ? GROUP BY name")
    .all(branchId, from, to) as Array<{ name: string; nett: number }>;
  const total = round2(rows.reduce((s, r) => s + r.nett, 0));
  if (rows.length === 0 || !(total > 0)) return null;
  const sum: Record<MixKey, number> = { beer: 0, soft: 0, jojee: 0, other: 0 };
  for (const r of rows) sum[groupOfCategory(r.name)] += r.nett;
  const pct = (x: number) => round2((x / total) * 100);
  return {
    from, to, total,
    groups: (["beer", "soft", "jojee", "other"] as MixKey[]).map((key) => ({ key, label: MIX_LABEL[key], nett: round2(sum[key]), pct: pct(sum[key]) })),
    others: rows.filter((r) => groupOfCategory(r.name) === "other").sort((a, b) => b.nett - a.nett).slice(0, 6).map((r) => ({ name: r.name, nett: round2(r.nett), pct: pct(r.nett) }))
  };
}

/** "Beer 12.5% · Soft drink 8.0% · จ้อจี้ 4.2% · อื่นๆ 75.3%" */
export const mixLine = (m: CategoryMix) => m.groups.map((g) => `${g.label} ${g.pct.toFixed(1)}%`).join(" · ");
