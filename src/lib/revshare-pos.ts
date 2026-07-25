// POS .xlsx parser for Revenue-Share (server-only — imports SheetJS). Reads the
// first sheet of a POS "Product sales" export, finds the category subtotals and
// the reporting date range. Owner 2026-06-22.
//
// Layout (after a few preamble rows): a header row whose first cell is
// "Category", then one row per line item and one SUBTOTAL row per category
// (Category set, Name blank). Columns (0-indexed):
//   0 Category · 1 Name · 2 Code · 3 Variant · 4 Qty · 5 Gross ·
//   6 Bill discount · 7 Item discount · 8 Service charge · 9 VAT · 10 Nett
// Discounts are negative in the file, so after_discount = gross + bill + item.

import * as XLSX from "xlsx";
import { roundLabel, round2 } from "./revshare";

export type PosCategory = {
  category: string;
  qty: number;            // col 4 — items sold in this category
  gross: number;          // col 5 — pre-VAT list amount
  afterDiscount: number;  // gross + bill discount + item discount
  nett: number;           // col 10 — incl. VAT + service charge
};

export type PosParseResult = {
  periodStart: string | null;  // YYYY-MM-DD
  periodEnd: string | null;
  periodMonth: number | null;
  periodYear: number | null;
  label: string | null;        // "15–21 มิ.ย."
  categories: PosCategory[];
};

export type SalesBase = "gross" | "after_discount" | "nett";

function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function cell(row: unknown[], i: number): string {
  const v = row[i];
  return v == null ? "" : String(v).trim();
}

export function parsePosBuffer(buf: Buffer | ArrayBuffer): PosParseResult {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = (sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false }) : []) as unknown[][];

  // Header row = first row whose first cell is exactly "Category".
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (cell(rows[i], 0).toLowerCase() === "category") { headerIdx = i; break; }
  }

  // Date range from the preamble (rows above the header).
  const preamble = rows
    .slice(0, headerIdx >= 0 ? headerIdx : rows.length)
    .map((r) => r.map((c) => (c == null ? "" : String(c))).join(" "))
    .join(" ");
  let periodStart: string | null = null, periodEnd: string | null = null;
  let periodMonth: number | null = null, periodYear: number | null = null, label: string | null = null;
  const m = preamble.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const pad = (s: string) => s.padStart(2, "0");
    periodStart = `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    periodEnd = `${m[6]}-${pad(m[5])}-${pad(m[4])}`;
    periodMonth = Number(m[2]);
    periodYear = Number(m[3]);
    label = roundLabel(periodStart, periodEnd);
  }

  const categories: PosCategory[] = [];
  if (headerIdx >= 0) {
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      const cat = cell(row, 0);
      const name = cell(row, 1);
      if (!cat) continue;            // grand-total / blank row
      if (name) continue;            // a line item, not the category subtotal
      const gross = num(row[5]);
      if (gross <= 0) continue;      // skip non-sales categories (e.g. CUSTOMER TYPE)
      categories.push({
        category: cat,
        qty: Math.round(num(row[4])),
        gross: round2(gross),
        afterDiscount: round2(gross + num(row[6]) + num(row[7])),
        nett: round2(num(row[10]))
      });
    }
  }

  return { periodStart, periodEnd, periodMonth, periodYear, label, categories };
}

/** Sum the chosen base over the selected category names (case-insensitive). */
export function posSelectedTotal(categories: PosCategory[], selected: string[], base: SalesBase): number {
  const set = new Set(selected.map((s) => s.trim().toLowerCase()));
  let t = 0;
  for (const c of categories) {
    if (!set.has(c.category.trim().toLowerCase())) continue;
    t += base === "gross" ? c.gross : base === "after_discount" ? c.afterDiscount : c.nett;
  }
  return round2(t);
}

/** Sum Qty over the selected categories — the partner's "จำนวนบิล" (owner
 *  2026-07-25: the จ้อจี้ categories' item count). Same selection as the total. */
export function posSelectedQty(categories: PosCategory[], selected: string[]): number {
  const set = new Set(selected.map((s) => s.trim().toLowerCase()));
  let n = 0;
  for (const c of categories) {
    if (set.has(c.category.trim().toLowerCase())) n += c.qty;
  }
  return n;
}
