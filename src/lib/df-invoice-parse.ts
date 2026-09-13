// Doctor-Fee invoice parser (server-only — imports SheetJS). Reads a clinic
// "Invoice Report" .xlsx export and pulls the line items whose leading [TAG]
// matches a wanted set (e.g. HSC, HSC-GRP). Owner 2026-08.
//
// The export is one row PER LINE ITEM (a bill spans several rows). Columns are
// located by their Thai header text, not a fixed index, so a re-ordered export
// still parses. Key columns:
//   เลขที่ใบแจ้งหนี้ (invoice no) · วัน (DD/MM/BBBB, Buddhist) · รหัส (item code,
//   e.g. GEN001) · รายการ (description, prefixed with the [TAG]) · จำนวน (qty) ·
//   ราคารวม (gross) · ส่วนลด (line discount) · ราคาสุทธิ (net = base for the fee)
//
// The service-code TAG lives in the FIRST bracket of the description, e.g.
// "[HSC] ค่าบริการผู้ป่วยนอก" → "HSC". Drug lines lead with a bin/category tag
// like "[#D1Y][NSAIDs] …" → "#D1Y", which simply won't match a wanted service
// tag, so they're skipped.

import * as XLSX from "xlsx";

export type DfParsedLine = {
  invoiceNo: string;
  lineDate: string;       // YYYY-MM-DD (Gregorian)
  itemCode: string;       // รหัส column (GEN001 …)
  tag: string;            // leading [TAG] (HSC / HSC-GRP …)
  description: string;
  qty: number;
  gross: number;          // ราคารวม
  discount: number;       // ส่วนลด
  net: number;            // ราคาสุทธิ — the fee base
};

export type DfParseResult = {
  periodStart: string | null;   // min line date (YYYY-MM-DD)
  periodEnd: string | null;     // max line date
  lines: DfParsedLine[];
  skippedNoDate: number;        // rows that matched a tag but had an unparseable date
};

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// "01/08/2569" (DD/MM/BBBB Buddhist) → "2026-08-01". Also tolerates a 4-digit
// Gregorian year and an ISO string, so re-exports in another locale still work.
export function parseThaiDate(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    let year = Number(m[3]);
    if (year > 2400) year -= 543;          // Buddhist era → Gregorian
    const mo = Number(m[2]), day = Number(m[1]);
    if (mo < 1 || mo > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

// The leading [TAG] of a description, uppercased, or null.
export function leadingTag(desc: string): string | null {
  const m = desc.match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim().toUpperCase() : null;
}

// Map header text → column index (first match wins). Handles small wording
// drift by matching on a contained keyword.
function locateColumns(header: unknown[]): Record<string, number> {
  const idx: Record<string, number> = {};
  const want: Array<[string, (h: string) => boolean]> = [
    ["invoice", (h) => h.includes("ใบแจ้งหนี้") || h.includes("เลขที่ใบ")],
    ["date", (h) => h === "วัน" || h.includes("วันที่")],
    ["code", (h) => h === "รหัส"],
    ["desc", (h) => h === "รายการ"],
    ["qty", (h) => h === "จำนวน"],
    ["gross", (h) => h.includes("ราคารวม")],
    ["discount", (h) => h === "ส่วนลด"],
    ["net", (h) => h.includes("ราคาสุทธิ")],
    // Bill-level (end-of-bill) discount + the resulting bill net — present on the
    // FIRST line of each bill only (owner 2026-09-13). A visit can be discounted
    // to 0 here while each line's own ส่วนลด stays 0, so DF must fold this in.
    ["billDiscount", (h) => h === "ส่วนลดท้ายบิล"],
    ["billNet", (h) => h === "รวมสุทธิ"]
  ];
  for (let c = 0; c < header.length; c++) {
    const h = str(header[c]);
    if (!h) continue;
    for (const [key, test] of want) {
      if (idx[key] === undefined && test(h)) idx[key] = c;
    }
  }
  return idx;
}

// Read the first sheet's rows and locate the header + columns (shared by parse
// and scan). headerIdx < 0 when no recognizable header row is found.
function readRowsAndHeader(buf: Buffer | ArrayBuffer): { rows: unknown[][]; headerIdx: number; cols: Record<string, number> } {
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = (sheet
    ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false })
    : []) as unknown[][];
  // Header = first row that has a "รายการ" + "ราคาสุทธิ" + invoice column.
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const c = locateColumns(rows[i]);
    if (c.desc !== undefined && c.net !== undefined && c.invoice !== undefined) {
      return { rows, headerIdx: i, cols: c };
    }
  }
  return { rows, headerIdx: -1, cols: {} };
}

export type DfScannedTag = {
  tag: string;      // leading [TAG], uppercased
  lines: number;    // matched line-item rows
  bills: number;    // distinct invoice numbers
  net: number;      // Σ ราคาสุทธิ
  sample: string;   // an example full description
};

// Scan a report for EVERY leading [TAG] present (no wanted filter), with stats,
// so the admin can just tick the codes that count and set a rate — instead of
// typing tag strings by hand (owner 2026-09-13). Drug-bin tags (e.g. "#D1Y")
// show up too; the admin simply doesn't tick them.
export function scanInvoiceTags(buf: Buffer | ArrayBuffer): { tags: DfScannedTag[]; totalRows: number } {
  const { rows, headerIdx, cols } = readRowsAndHeader(buf);
  if (headerIdx < 0) return { tags: [], totalRows: 0 };
  const agg = new Map<string, { lines: number; bills: Set<string>; net: number; sample: string }>();
  let totalRows = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const desc = str(rows[i][cols.desc]);
    if (!desc) continue;
    const tag = leadingTag(desc);
    if (!tag) continue;
    totalRows++;
    let a = agg.get(tag);
    if (!a) { a = { lines: 0, bills: new Set(), net: 0, sample: desc }; agg.set(tag, a); }
    a.lines++;
    a.bills.add(str(rows[i][cols.invoice]));
    a.net += num(rows[i][cols.net]);
  }
  const tags = [...agg.entries()]
    .map(([tag, a]) => ({ tag, lines: a.lines, bills: a.bills.size, net: Math.round(a.net * 100) / 100, sample: a.sample }))
    .sort((x, y) => y.net - x.net);
  return { tags, totalRows };
}

export function parseInvoiceBuffer(
  buf: Buffer | ArrayBuffer,
  wantedTags: string[]
): DfParseResult {
  const want = new Set(wantedTags.map((t) => t.trim().toUpperCase()));
  const { rows, headerIdx, cols } = readRowsAndHeader(buf);
  if (headerIdx < 0) return { periodStart: null, periodEnd: null, lines: [], skippedNoDate: 0 };

  // Pass 1 — group EVERY line item by bill so the end-of-bill discount can be
  // spread across all its lines (owner 2026-09-13). netSum is over ALL lines
  // (not just wanted ones), since the bill discount applies to the whole bill.
  // The bill-level fields sit on the bill's first row; capture them there.
  type BillAgg = { netSum: number; billDiscount: number; billNet: number | null };
  const bills = new Map<string, BillAgg>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const desc = str(row[cols.desc]);
    if (!desc) continue;                 // totals row / blank → not a line item
    const inv = str(row[cols.invoice]);
    if (!inv) continue;
    let b = bills.get(inv);
    if (!b) {
      // First row of this bill — read the bill-level discount / net here.
      const billDiscount = cols.billDiscount !== undefined ? num(row[cols.billDiscount]) : 0;
      let billNet: number | null = null;
      if (cols.billNet !== undefined && str(row[cols.billNet]) !== "") billNet = num(row[cols.billNet]);
      b = { netSum: 0, billDiscount, billNet };
      bills.set(inv, b);
    }
    b.netSum += num(row[cols.net]);
  }

  // Per-bill scale factor = (bill net after end-of-bill discount) / Σ line nets.
  // Prefer the report's own รวมสุทธิ; else derive it from ส่วนลดท้ายบิล. Clamp to
  // [0,1] — a discount can zero a bill but never inflate it. 1 = no bill discount.
  const scaleOf = (inv: string): number => {
    const b = bills.get(inv);
    if (!b || b.netSum <= 0) return 1;
    let billNet: number;
    if (b.billNet != null) billNet = b.billNet;
    else if (b.billDiscount > 0) billNet = b.netSum - b.billDiscount;
    else return 1;
    const s = billNet / b.netSum;
    return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 1;
  };

  // Pass 2 — keep the wanted lines, folding each bill's discount into net.
  const lines: DfParsedLine[] = [];
  let skippedNoDate = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const desc = str(row[cols.desc]);
    if (!desc) continue;
    const tag = leadingTag(desc);
    if (!tag || !want.has(tag)) continue;
    const lineDate = parseThaiDate(str(row[cols.date]));
    if (!lineDate) { skippedNoDate++; continue; }
    const invoiceNo = str(row[cols.invoice]);
    const rawNet = num(row[cols.net]);
    const scale = scaleOf(invoiceNo);
    const net = round2(rawNet * scale);
    const lineDiscount = num(row[cols.discount]);
    // Fold the line's share of the bill discount into `discount` so the invariant
    // net = gross − discount still holds and the allocation is auditable.
    const discount = round2(lineDiscount + (rawNet - net));
    lines.push({
      invoiceNo,
      lineDate,
      itemCode: str(row[cols.code]),
      tag,
      description: desc,
      qty: num(row[cols.qty]),
      gross: num(row[cols.gross]),
      discount,
      net
    });
  }

  const dates = lines.map((l) => l.lineDate).sort();
  return {
    periodStart: dates[0] ?? null,
    periodEnd: dates[dates.length - 1] ?? null,
    lines,
    skippedNoDate
  };
}
