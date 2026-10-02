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

/** Merge menu entries that share a name (some POS "Top products" exports list
 *  the same item on more than one row — e.g. sold under two categories). Summing
 *  the revenue avoids a PRIMARY KEY (branch, date, kind, name) clash on upsert,
 *  which otherwise 500s the whole import (owner 2026-09-20). Sorted by nett desc. */
function mergeByName(entries: MenuEntry[]): MenuEntry[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.name, round2((m.get(e.name) ?? 0) + e.nett));
  return [...m.entries()].map(([name, nett]) => ({ name, nett })).sort((a, b) => b.nett - a.nett);
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

  return { date: pre.date, dateEnd: pre.dateEnd ?? pre.date, merchant: pre.merchant, categories: mergeByName(categories), items: mergeByName(items) };
}

// ── receipt (per-bill with time + items — owner 2026-09-18) ─────────────────

export type ReceiptItem = { name: string; qty: number };
export type ReceiptBill = {
  hour: number;            // 0–23 (from the Time column)
  billNo: string;              // the short per-day "No." (1428) — the analytics key
  receiptId: string | null;    // FeedMe's long global receipt id (e.g. "823Z_4w8g") — for a customer-scannable QR; null when the file has no ID column
  table: string;
  gross: number;
  discount: number;
  nett: number;
  payment: string;
  isStaff: boolean;        // STAFF table / 100%-discount → exclude from analytics
  isTakeaway: boolean;     // table starts with "TA"
  items: ReceiptItem[];    // aggregated per name (qty summed)
};
export type SalesReceipt = { date: string; dateEnd: string; merchant: string | null; bills: ReceiptBill[] };

/** Recognise a receipt workbook (A1 == "Receipt", or a Time/Items header). */
export function isReceipt(buf: Buffer | ArrayBuffer): boolean {
  const s = sheetsByName(buf);
  const first = s.get(() => true);
  if (!first) return false;
  if (cell(first[0] ?? [], 0).toLowerCase() === "receipt") return true;
  return first.some((r) => r.some((c) => String(c).trim() === "Time") && r.some((c) => String(c).trim() === "Items"));
}

/** Clean a menu name: strip tabs / collapse whitespace / trim. */
function cleanName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function parseReceipt(buf: Buffer | ArrayBuffer): SalesReceipt {
  const s = sheetsByName(buf);
  const rows = s.get(() => true);
  if (!rows) throw new Error("receipt: ไฟล์ว่าง");
  const pre = readPreamble(rows);
  if (!pre.date) throw new Error("receipt: ไม่พบวันที่ในไฟล์ (Date:)");

  // Header row: the one whose first cell is "Time".
  const hdrIdx = rows.findIndex((r) => cell(r, 0).toLowerCase() === "time");
  if (hdrIdx < 0) throw new Error("receipt: ไม่พบหัวตาราง (Time)");
  const header = rows[hdrIdx].map((c) => String(c).trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const ci = {
    time: col("time"), no: col("no."), id: col("id"), table: col("table"), gross: col("gross"),
    discount: col("discount"), nett: col("nett"), payment: col("payment"), items: col("items")
  };

  const bills: ReceiptBill[] = [];
  for (const r of rows.slice(hdrIdx + 1)) {
    const timeStr = cell(r, ci.time);
    if (!timeStr) continue;
    // "17/09/2026 12:07:20" → hour.
    const hm = timeStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    const hour = hm ? Number(hm[1]) : -1;
    if (hour < 0 || hour > 23) continue;
    const table = cell(r, ci.table);
    const gross = num(r[ci.gross]);
    const discount = num(r[ci.discount]);
    const nett = num(r[ci.nett]);
    const isStaff = table.toUpperCase() === "STAFF" || (nett === 0 && gross > 0 && discount < 0);
    // Items: "1x name,2x name, …" → aggregate qty per cleaned name.
    const itemMap = new Map<string, number>();
    for (const part of cell(r, ci.items).split(",")) {
      const m = part.match(/^\s*(\d+)\s*x\s*(.+)$/i);
      if (!m) continue;
      const name = cleanName(m[2]);
      if (!name) continue;
      itemMap.set(name, (itemMap.get(name) ?? 0) + Number(m[1]));
    }
    bills.push({
      hour, billNo: cell(r, ci.no), receiptId: ci.id >= 0 ? (cell(r, ci.id) || null) : null, table,
      gross: round2(gross), discount: round2(discount), nett: round2(nett),
      payment: cell(r, ci.payment),
      isStaff, isTakeaway: /^ta/i.test(table),
      items: [...itemMap.entries()].map(([name, qty]) => ({ name, qty }))
    });
  }
  return { date: pre.date, dateEnd: pre.dateEnd ?? pre.date, merchant: pre.merchant, bills };
}

// ── tax_invoice (รายงานใบกำกับภาษีขาย, RD format — owner 2026-10-02) ────────
//
// The POS "sale_taxInvoice_rdformat" export: every full tax invoice the shop
// issued in a date range — i.e. the customers who asked for one, which are
// almost all COMPANIES. One sheet; a 9-line preamble (operator, tax id, RD
// branch code "สาขา : 00002", date range), a two-row header, one row per
// invoice, and a trailing "รวม" row. Dates are dd/mm/yyyy (CE in this export;
// a Buddhist year is normalised just in case). Amounts carry thousands commas.
//
// This file is a CUSTOMER view, not a sales total: the invoices are a subset of
// the receipts already counted by close_up, so nothing here is ever added to
// the branch's nett (owner: "มองในมุมยอดขาย ไม่ต้องบวกเพิ่มจากไฟล์อื่นๆ").

export type TaxInvoiceCustomerKind = "company" | "person";

export type TaxInvoiceRow = {
  invoiceNo: string;          // "RT-20260900002" — the dedup key (unique per RD branch)
  date: string;               // YYYY-MM-DD
  customerName: string;
  taxId: string | null;       // 13 digits; null when blank
  customerKind: TaxInvoiceCustomerKind;
  hqLabel: string | null;     // "HQ (00000)" or blank
  customerBranchCode: string | null;   // the CUSTOMER's RD branch ("00016" = DKSH branch 16)
  amount: number;             // มูลค่าสินค้าหรือบริการ (pre-VAT)
  vat: number;
  total: number;              // จำนวนเงินรวม (what the customer paid)
  note: string | null;
  status: string | null;      // "ออกแล้ว" | "ยกเลิก" | …
};

export type SalesTaxInvoice = {
  rangeStart: string;         // YYYY-MM-DD — "ช่วงวันที่ : 01/09/2026-30/09/2026"
  rangeEnd: string;
  rdBranchCode: string | null;   // OUR RD branch code in the preamble ("00001" / "00002")
  operator: string | null;    // ชื่อผู้ประกอบการ
  operatorTaxId: string | null;
  rows: TaxInvoiceRow[];
};

const TAX_INVOICE_TITLE = /รายงานใบกำกับภาษีขาย/;
const TAX_INVOICE_NO_HEADER = /เลขที่ใบกำกับภาษี/;

/** Recognise the RD-format sales tax-invoice report. */
export function isTaxInvoice(buf: Buffer | ArrayBuffer): boolean {
  const s = sheetsByName(buf);
  const first = s.get(() => true);
  if (!first) return false;
  const titled = first.slice(0, 3).some((r) => TAX_INVOICE_TITLE.test(cell(r, 0)));
  const headed = first.slice(0, 20).some((r) => r.some((c) => TAX_INVOICE_NO_HEADER.test(String(c ?? ""))));
  return titled || headed;
}

/** "dd/mm/yyyy" → "YYYY-MM-DD" (a พ.ศ. year is converted). Null when malformed. */
function dmyToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  let y = Number(m[3]);
  if (y > 2400) y -= 543;
  const mo = Number(m[2]), d = Number(m[1]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Thai juristic-person tax ids start with 0; a 13-digit citizen id starts
 *  with 1–8. A name led by a personal title is a person regardless. */
export function taxInvoiceCustomerKind(name: string, taxId: string | null): TaxInvoiceCustomerKind {
  if (/^(นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|เด็กชาย|เด็กหญิง|Mr\.?|Mrs\.?|Ms\.?|Miss)\s/i.test(name.trim())) return "person";
  if (taxId && /^\d{13}$/.test(taxId) && taxId[0] !== "0") return "person";
  return "company";
}

export function parseTaxInvoice(buf: Buffer | ArrayBuffer): SalesTaxInvoice {
  const s = sheetsByName(buf);
  const rows = s.get(() => true);
  if (!rows) throw new Error("tax_invoice: ไฟล์ว่าง");

  // Preamble: "label : value" lines in column A.
  const pre = new Map<string, string>();
  for (const r of rows.slice(0, 12)) {
    const m = cell(r, 0).match(/^([^:]+?)\s*:\s*(.+)$/);
    if (m) pre.set(m[1].trim(), m[2].trim());
  }
  const rangeRaw = pre.get("ช่วงวันที่") ?? "";
  const rm = rangeRaw.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})/);
  const rangeStart = rm ? dmyToIso(rm[1]) : null;
  const rangeEnd = rm ? dmyToIso(rm[2]) : null;
  if (!rangeStart || !rangeEnd) throw new Error("tax_invoice: ไม่พบช่วงวันที่ในไฟล์ (ช่วงวันที่ :)");
  const rdBranchCode = (pre.get("สาขา") ?? "").match(/\d{5}/)?.[0] ?? null;
  const operator = pre.get("ชื่อผู้ประกอบการ") ?? null;
  const operatorTaxId = (pre.get("เลขประจำตัวผู้เสียภาษี") ?? "").match(/\d{13}/)?.[0] ?? null;

  // Column header row: the one holding "เลขที่ใบกำกับภาษี…". Columns are located
  // by header text so a re-ordered export still parses.
  const hdrIdx = rows.findIndex((r) => r.some((c) => TAX_INVOICE_NO_HEADER.test(String(c ?? ""))));
  if (hdrIdx < 0) throw new Error("tax_invoice: ไม่พบหัวตาราง (เลขที่ใบกำกับภาษีขาย)");
  const header = rows[hdrIdx].map((c) => String(c ?? "").trim());
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const ci = {
    date: col(/วัน\/เดือน\/ปี|วันที่/), no: col(TAX_INVOICE_NO_HEADER), name: col(/^ชื่อ$/),
    taxId: col(/เลขประจำตัวผู้เสียภาษี/), hq: col(/สำนักงานใหญ่/), branch: col(/^สาขา$/),
    amount: col(/มูลค่าสินค้า/), vat: col(/ภาษีมูลค่าเพิ่ม/), total: col(/จำนวนเงินรวม/),
    note: col(/หมายเหตุ/), status: col(/สถานะ/)
  };
  if (ci.no < 0 || ci.date < 0 || ci.name < 0 || ci.total < 0) throw new Error("tax_invoice: หัวตารางไม่ครบ (วันที่ / เลขที่ / ชื่อ / จำนวนเงินรวม)");

  const out: TaxInvoiceRow[] = [];
  for (const r of rows.slice(hdrIdx + 1)) {
    const invoiceNo = cell(r, ci.no);
    if (!invoiceNo) continue;                       // blank spacer / the "รวม" footer
    const date = dmyToIso(cell(r, ci.date));
    if (!date) continue;
    const customerName = cell(r, ci.name).replace(/\s+/g, " ");
    if (!customerName) continue;
    const taxIdRaw = ci.taxId >= 0 ? cell(r, ci.taxId).replace(/\D/g, "") : "";
    const taxId = taxIdRaw || null;
    const custBranch = ci.branch >= 0 ? cell(r, ci.branch) : "";
    out.push({
      invoiceNo, date, customerName, taxId,
      customerKind: taxInvoiceCustomerKind(customerName, taxId),
      hqLabel: ci.hq >= 0 ? (cell(r, ci.hq) || null) : null,
      customerBranchCode: custBranch || null,
      amount: round2(ci.amount >= 0 ? num(r[ci.amount]) : 0),
      vat: round2(ci.vat >= 0 ? num(r[ci.vat]) : 0),
      total: round2(num(r[ci.total])),
      note: ci.note >= 0 ? (cell(r, ci.note) || null) : null,
      status: ci.status >= 0 ? (cell(r, ci.status) || null) : null
    });
  }
  return { rangeStart, rangeEnd, rdBranchCode, operator, operatorTaxId, rows: out };
}

/** Dispatcher: sniff a buffer and parse whichever kind it is. */
export type SalesFileParse =
  | { kind: "close_up"; closeUp: SalesCloseUp }
  | { kind: "overview"; overview: SalesOverview }
  | { kind: "receipt"; receipt: SalesReceipt }
  | { kind: "tax_invoice"; taxInvoice: SalesTaxInvoice };

export function parseSalesFile(buf: Buffer | ArrayBuffer): SalesFileParse {
  if (isCloseUp(buf)) return { kind: "close_up", closeUp: parseCloseUp(buf) };
  if (isOverview(buf)) return { kind: "overview", overview: parseOverview(buf) };
  if (isTaxInvoice(buf)) return { kind: "tax_invoice", taxInvoice: parseTaxInvoice(buf) };
  if (isReceipt(buf)) return { kind: "receipt", receipt: parseReceipt(buf) };
  throw new Error("ไม่รู้จักรูปแบบไฟล์ — ต้องเป็นรายงาน Close up (ยอดขาย) / Overview (เมนู) / Receipt (ใบเสร็จ) / ใบกำกับภาษีขาย (รูปแบบสรรพากร) จาก POS");
}
