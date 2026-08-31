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
    ["net", (h) => h.includes("ราคาสุทธิ")]
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

export function parseInvoiceBuffer(
  buf: Buffer | ArrayBuffer,
  wantedTags: string[]
): DfParseResult {
  const want = new Set(wantedTags.map((t) => t.trim().toUpperCase()));
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = (sheet
    ? XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false })
    : []) as unknown[][];

  // Header = first row that has both a "รายการ" and a "ราคาสุทธิ" column.
  let headerIdx = -1;
  let cols: Record<string, number> = {};
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const c = locateColumns(rows[i]);
    if (c.desc !== undefined && c.net !== undefined && c.invoice !== undefined) {
      headerIdx = i; cols = c; break;
    }
  }
  if (headerIdx < 0) return { periodStart: null, periodEnd: null, lines: [], skippedNoDate: 0 };

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
    lines.push({
      invoiceNo: str(row[cols.invoice]),
      lineDate,
      itemCode: str(row[cols.code]),
      tag,
      description: desc,
      qty: num(row[cols.qty]),
      gross: num(row[cols.gross]),
      discount: num(row[cols.discount]),
      net: num(row[cols.net])
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
