// SALESA — POS daily-sales .xlsx parsers (server-only; imports SheetJS).
// Owner 2026-09-16: staff import the FeedMe POS exports every day so the system
// tracks daily sales + which menus earn the most, and pushes a summary card to
// the HOD LINE group (daily) + a weekly summary every Monday.
//
// Two file kinds (both per-day, per-merchant/branch):
//
//  • "close_up"  — the daily KPI report. 18 sheets, all AGGREGATES (no menu
//    rows): Bill count / Total Sales / Total Pax / Discount / Void / Refund /
//    Averages / Payment·Charge·Type·Source summaries / Sales summary (P&L).
//
//  • "overview"  — the menu-revenue ranking. "Top products" by Nett revenue,
//    both by category (sheet 1, a Dataset/Nett pivot) and by individual menu
//    (sheet 4, a Name/Value list). Ranked by บาท, not item count (owner ask).
//
// Sheets are located by their leading number/name; values by header text, so a
// re-ordered export still parses. Amounts carry thousands commas → stripped.

import * as XLSX from "xlsx";

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
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

type Sheet = unknown[][];

function sheetsByName(buf: Buffer | ArrayBuffer): { names: string[]; get: (pred: (name: string) => boolean) => Sheet | null; wb: XLSX.WorkBook } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const rowsOf = (name: string): Sheet =>
    (XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false, defval: "" }) as unknown[][]);
  return {
    names: wb.SheetNames,
    wb,
    get: (pred) => {
      const name = wb.SheetNames.find(pred);
      return name ? rowsOf(name) : null;
    }
  };
}

/** Pull "Date: dd/mm/yyyy - dd/mm/yyyy" + "Merchant: X" from a sheet preamble.
 *  Dates are Gregorian (CE) in this POS export. */
function readPreamble(rows: Sheet): { date: string | null; dateEnd: string | null; merchant: string | null } {
  const flat = rows.slice(0, 6).map((r) => r.map((c) => (c == null ? "" : String(c))).join(" ")).join(" \n ");
  const dm = flat.match(/Date:\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const pad = (s: string) => s.padStart(2, "0");
  const date = dm ? `${dm[3]}-${pad(dm[2])}-${pad(dm[1])}` : null;
  const dateEnd = dm ? `${dm[6]}-${pad(dm[5])}-${pad(dm[4])}` : null;
  const mm = flat.match(/Merchant:\s*([^\n]+)/);
  const merchant = mm ? mm[1].trim() : null;
  return { date, dateEnd, merchant };
}

/** A "Name / Value" scalar sheet → the value cell (col 1) of the first data
 *  row after the ["Name","Value"] header. */
function scalarValue(rows: Sheet | null): number | null {
  if (!rows) return null;
  for (let i = 0; i < rows.length; i++) {
    if (cell(rows[i], 0).toLowerCase() === "name" && cell(rows[i], 1).toLowerCase() === "value") {
      const dataRow = rows[i + 1];
      return dataRow ? num(dataRow[1]) : null;
    }
  }
  return null;
}

/** Data rows after a header row identified by its first cell (case-insensitive). */
function rowsAfterHeader(rows: Sheet | null, firstHeader: string): Sheet {
  if (!rows) return [];
  const idx = rows.findIndex((r) => cell(r, 0).toLowerCase() === firstHeader.toLowerCase());
  return idx < 0 ? [] : rows.slice(idx + 1).filter((r) => cell(r, 0) !== "");
}

// ── close_up (daily KPI) ────────────────────────────────────────────────────

export type PayEntry = { name: string; qty: number; total: number };
export type TypeEntry = { name: string; qty: number; sales: number };

export type SalesCloseUp = {
  date: string;
  dateEnd: string;
  merchant: string | null;
  nett: number;               // Total Sales (= Sales summary Nett)
  gross: number;
  grossBeforeCharges: number;
  discount: number;           // negative in file
  serviceCharge: number;
  vat: number;
  rounding: number;
  deliveryFee: number;
  otherCharge: number;
  billCount: number;
  pax: number;
  voidAmount: number;
  voidBillCount: number;
  refund: number;
  avgSales: number;           // per bill
  avgPax: number;             // heads per bill
  avgSalesPax: number;        // per head
  payments: PayEntry[];
  types: TypeEntry[];
  sources: TypeEntry[];
};

/** Recognise a close_up workbook (A1 == "Close up" or a "Total Sales" sheet). */
export function isCloseUp(buf: Buffer | ArrayBuffer): boolean {
  const s = sheetsByName(buf);
  return s.names.some((n) => /total sales/i.test(n)) && s.names.some((n) => /bill count/i.test(n));
}

export function parseCloseUp(buf: Buffer | ArrayBuffer): SalesCloseUp {
  const s = sheetsByName(buf);
  const first = s.get(() => true);
  const pre = first ? readPreamble(first) : { date: null, dateEnd: null, merchant: null };
  if (!pre.date) throw new Error("close_up: ไม่พบวันที่ในไฟล์ (Date:)");

  const scalar = (needle: RegExp) => scalarValue(s.get((n) => needle.test(n)));

  // Sales summary (sheet 18) — the authoritative P&L breakdown.
  const summary = s.get((n) => /sales summary/i.test(n));
  const summaryMap = new Map<string, number>();
  for (const r of rowsAfterHeader(summary, "Label")) {
    summaryMap.set(cell(r, 0).toLowerCase(), num(r[1]));
  }
  const sm = (label: string) => summaryMap.get(label.toLowerCase()) ?? 0;

  const payments: PayEntry[] = rowsAfterHeader(s.get((n) => /payment summary/i.test(n)), "Name")
    .map((r) => ({ name: cell(r, 0), qty: Math.round(num(r[2])), total: round2(num(r[3])) }))
    .filter((p) => p.name.toLowerCase() !== "total");
  const types: TypeEntry[] = rowsAfterHeader(s.get((n) => /type summary/i.test(n)), "Type")
    .map((r) => ({ name: cell(r, 0), qty: Math.round(num(r[1])), sales: round2(num(r[2])) }))
    .filter((t) => t.name.toLowerCase() !== "total");
  const sources: TypeEntry[] = rowsAfterHeader(s.get((n) => /source summary/i.test(n)), "Source")
    .map((r) => ({ name: cell(r, 0), qty: Math.round(num(r[1])), sales: round2(num(r[2])) }))
    .filter((t) => t.name.toLowerCase() !== "total");

  const nett = scalar(/total sales/i) ?? sm("Nett");

  return {
    date: pre.date,
    dateEnd: pre.dateEnd ?? pre.date,
    merchant: pre.merchant,
    nett: round2(nett),
    gross: round2(sm("Gross")),
    grossBeforeCharges: round2(sm("Gross before charges")),
    discount: round2(sm("Discount") || (scalar(/total discount/i) ?? 0)),
    serviceCharge: round2(sm("Service charge")),
    vat: round2(sm("VAT")),
    rounding: round2(sm("Rounding")),
    deliveryFee: round2(sm("Delivery fee")),
    otherCharge: round2(sm("Other charge")),
    billCount: Math.round(scalar(/bill count/i) ?? 0),
    pax: Math.round(scalar(/total pax/i) ?? 0),
    voidAmount: round2(scalar(/total void/i) ?? 0),
    voidBillCount: Math.round(scalar(/void bill count/i) ?? 0),
    refund: round2(scalar(/total refund/i) ?? 0),
    avgSales: round2(scalar(/average sales$/i) ?? 0),
    avgPax: round2(scalar(/average pax/i) ?? 0),
    avgSalesPax: round2(scalar(/average sales pax/i) ?? 0),
    payments,
    types,
    sources
  };
}

// ── overview (menu-revenue ranking) ─────────────────────────────────────────

export type MenuEntry = { name: string; nett: number };

export type SalesOverview = {
  date: string;
  dateEnd: string;
  merchant: string | null;
  categories: MenuEntry[];    // by category, revenue desc
  items: MenuEntry[];         // by individual menu, revenue desc
};

/** Recognise an overview workbook (has "Top products" sheets). */
export function isOverview(buf: Buffer | ArrayBuffer): boolean {
  return sheetsByName(buf).names.some((n) => /top products/i.test(n));
}

export function parseOverview(buf: Buffer | ArrayBuffer): SalesOverview {
  const s = sheetsByName(buf);
  const first = s.get(() => true);
  const pre = first ? readPreamble(first) : { date: null, dateEnd: null, merchant: null };
  if (!pre.date) throw new Error("overview: ไม่พบวันที่ในไฟล์ (Date:)");

  // Categories: the pivot sheet with a "Dataset" header row + a "Nett" values
  // row. Prefer the sheet that is a Dataset/Nett pivot (multi-column), not the
  // per-branch/date one.
  const categories: MenuEntry[] = [];
  for (const name of s.names) {
    if (!/top products/i.test(name)) continue;
    const rows = s.get((n) => n === name)!;
    const dsIdx = rows.findIndex((r) => cell(r, 0).toLowerCase() === "dataset");
    if (dsIdx < 0) continue;
    const header = rows[dsIdx];
    const nettRow = rows.slice(dsIdx + 1).find((r) => cell(r, 0).toLowerCase() === "nett");
    if (!nettRow) continue;
    for (let c = 1; c < header.length; c++) {
      const cat = cell(header, c);
      if (!cat) continue;
      const v = num(nettRow[c]);
      if (v <= 0) continue;
      categories.push({ name: cat, nett: round2(v) });
    }
    break;
  }
  categories.sort((a, b) => b.nett - a.nett);

  // Individual menus: the "Name / Value" list sheet.
  const items: MenuEntry[] = [];
  for (const name of s.names) {
    if (!/top products/i.test(name)) continue;
    const rows = s.get((n) => n === name)!;
    const hdr = rows.findIndex((r) => cell(r, 0).toLowerCase() === "name" && cell(r, 1).toLowerCase() === "value");
    if (hdr < 0) continue;
    for (const r of rows.slice(hdr + 1)) {
      const nm = cell(r, 0);
      if (!nm || nm.toLowerCase() === "total") continue;
      const v = num(r[1]);
      if (v <= 0) continue;
      items.push({ name: nm, nett: round2(v) });
    }
    break;
  }
  items.sort((a, b) => b.nett - a.nett);

  return { date: pre.date, dateEnd: pre.dateEnd ?? pre.date, merchant: pre.merchant, categories, items };
}

/** Dispatcher: sniff a buffer and parse whichever kind it is. */
export type SalesFileParse =
  | { kind: "close_up"; closeUp: SalesCloseUp }
  | { kind: "overview"; overview: SalesOverview };

export function parseSalesFile(buf: Buffer | ArrayBuffer): SalesFileParse {
  if (isCloseUp(buf)) return { kind: "close_up", closeUp: parseCloseUp(buf) };
  if (isOverview(buf)) return { kind: "overview", overview: parseOverview(buf) };
  throw new Error("ไม่รู้จักรูปแบบไฟล์ — ต้องเป็นรายงาน Close up (ยอดขาย) หรือ Overview (เมนู) จาก POS");
}
