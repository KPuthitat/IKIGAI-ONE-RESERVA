// CLINICA — AT HOME CLINIC HIS .xlsx parsers (server-only; imports SheetJS).
// Owner 2026-09-26: the clinic exports two HIS reports for a date range; ANALYTICA
// reads them for deep analysis (revenue, payer/AR, drugs/labs, diagnoses, doctors)
// beyond the single revenue number it already tracks.
//
// File kinds (all cover a date RANGE; invoice/receipt/opd import is range-based,
// replace-in-range; the outstanding snapshot is the exception, see below):
//
//  • "invoice" — the billing report (sheet "Invoice Report"): one row per billed
//    LINE ITEM. Bill-level totals (ยอดรวม / รวมสุทธิ / ยอดชำระรวม / ยอดค้างชำระ)
//    sit on the bill's FIRST line only. Real bills start "BL"; the export appends
//    a trailing "ยอดรวม" grand-total row that MUST be dropped (it doubled the
//    monthly figure in testing).
//
//  • "opd" — the visit/diagnosis report (sheet "OPD Report"): one row per
//    visit-diagnosis. Real visits start "OPD". Rows can repeat verbatim → deduped
//    by (visit, diagnosis code).
//
// Dates are Thai Buddhist (DD/MM/2569) → converted to ISO Gregorian.

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

/** DD/MM/BBBB (Thai Buddhist) → ISO YYYY-MM-DD (Gregorian). null if unparseable. */
export function beDateToIso(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  let y = Number(m[3]);
  if (y > 2400) y -= 543;   // Buddhist era → Gregorian
  return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

type Sheet = unknown[][];

function firstSheetRows(buf: Buffer | ArrayBuffer): Sheet {
  // Normalise an ArrayBuffer to a typed array so SheetJS decodes it correctly.
  const data = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  const wb = XLSX.read(data, { type: buf instanceof ArrayBuffer ? "array" : "buffer" });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, blankrows: false, defval: "" }) as Sheet;
}

/** Map header labels → column index (first data uses exact header text so a
 *  re-ordered export still parses). */
function headerIndex(header: unknown[]): Map<string, number> {
  const m = new Map<string, number>();
  header.forEach((h, i) => { const k = cell([h], 0); if (k && !m.has(k)) m.set(k, i); });
  return m;
}

export type ClinicaKind = "invoice" | "outstanding" | "receipt" | "opd";

// ── Invoice report ──────────────────────────────────────────────────────────

export type ClinicaBillItem = {
  code: string; name: string; qty: number; unit: string;
  lineGross: number; lineDiscount: number; lineNet: number;
};
export type ClinicaBill = {
  billNo: string; date: string; time: string; hn: string;
  payerGroup: string; staff: string;
  gross: number; billDiscount: number; net: number; paid: number; due: number;
  items: ClinicaBillItem[];
};
export type ClinicaInvoiceParse = {
  kind: "invoice";
  rangeStart: string; rangeEnd: string;
  bills: ClinicaBill[];
  billCount: number; patientCount: number;
  totalNet: number; totalPaid: number; totalDue: number;
};

export function isInvoiceReport(buf: Buffer | ArrayBuffer): boolean {
  const rows = firstSheetRows(buf);
  return rows.length > 0 && rows[0].some((h) => cell([h], 0) === "เลขที่ใบแจ้งหนี้");
}

export function parseInvoiceReport(buf: Buffer | ArrayBuffer): ClinicaInvoiceParse {
  return parseInvoiceRows(firstSheetRows(buf));
}

function parseInvoiceRows(rows: Sheet): ClinicaInvoiceParse {
  if (!rows.length) throw new Error("ไฟล์ว่าง");
  const h = headerIndex(rows[0]);
  const need = (label: string): number => {
    const i = h.get(label);
    if (i == null) throw new Error(`ไม่พบคอลัมน์ "${label}" — ไม่ใช่ไฟล์ Invoice Report`);
    return i;
  };
  // Some HIS exports label the date column "วันที่" instead of "วัน".
  const needAny = (...labels: string[]): number => {
    for (const l of labels) { const i = h.get(l); if (i != null) return i; }
    throw new Error(`ไม่พบคอลัมน์ "${labels[0]}" — ไม่ใช่ไฟล์ Invoice Report`);
  };
  const cBill = need("เลขที่ใบแจ้งหนี้"), cDate = needAny("วัน", "วันที่"), cTime = need("เวลา"), cHn = need("รหัสลูกค้า"),
    cPayer = need("กลุ่มลูกค้า"), cStaff = need("ผู้ทำรายการ"), cCode = need("รหัส"), cName = need("รายการ"),
    cQty = need("จำนวน"), cUnit = need("หน่วย"), cLGross = need("ราคารวม"), cLDisc = need("ส่วนลด"), cLNet = need("ราคาสุทธิ"),
    cGross = need("ยอดรวม"), cBDisc = need("ส่วนลดท้ายบิล"), cNet = need("รวมสุทธิ"), cPaid = need("ยอดชำระรวม"), cDue = need("ยอดค้างชำระ");

  // Group real bills (id starts "BL") in first-seen order — this drops the
  // trailing "ยอดรวม" grand-total row the export appends.
  const order: string[] = [];
  const byBill = new Map<string, Sheet>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const billNo = cell(r, cBill);
    if (!/^BL/i.test(billNo)) continue;
    if (!byBill.has(billNo)) { byBill.set(billNo, []); order.push(billNo); }
    byBill.get(billNo)!.push(r);
  }

  const firstNonEmpty = (ls: Sheet, c: number): number => {
    for (const r of ls) { if (cell(r, c) !== "") return num(r[c]); }
    return 0;
  };
  const bills: ClinicaBill[] = order.map((billNo) => {
    const ls = byBill.get(billNo)!;
    const head = ls[0];
    return {
      billNo,
      date: beDateToIso(cell(head, cDate)) ?? "",
      time: cell(head, cTime),
      hn: cell(head, cHn),
      payerGroup: cell(head, cPayer),
      staff: cell(head, cStaff),
      gross: round2(firstNonEmpty(ls, cGross)),
      billDiscount: round2(firstNonEmpty(ls, cBDisc)),
      net: round2(firstNonEmpty(ls, cNet)),
      paid: round2(firstNonEmpty(ls, cPaid)),
      due: round2(firstNonEmpty(ls, cDue)),
      items: ls.map((r) => ({
        code: cell(r, cCode), name: cell(r, cName),
        qty: num(r[cQty]), unit: cell(r, cUnit),
        lineGross: round2(num(r[cLGross])), lineDiscount: round2(num(r[cLDisc])), lineNet: round2(num(r[cLNet]))
      }))
    };
  });
  // Keep every real bill in the totals (a bill with an unparseable date must not
  // silently vanish from revenue/AR); the range is taken from datable bills only.
  const dates = bills.map((b) => b.date).filter(Boolean).sort();
  const hns = new Set(bills.map((b) => b.hn).filter(Boolean));
  return {
    kind: "invoice",
    rangeStart: dates[0] ?? "", rangeEnd: dates[dates.length - 1] ?? "",
    bills,
    billCount: bills.length,
    patientCount: hns.size,
    totalNet: round2(bills.reduce((s, b) => s + b.net, 0)),
    totalPaid: round2(bills.reduce((s, b) => s + b.paid, 0)),
    totalDue: round2(bills.reduce((s, b) => s + b.due, 0))
  };
}

// ── OPD report ──────────────────────────────────────────────────────────────

export type ClinicaVisit = {
  visitNo: string; date: string; time: string; hn: string;
  gender: string; birthDate: string | null; doctor: string;
  dxCode: string; dxTh: string; dxEn: string;
};
export type ClinicaOpdParse = {
  kind: "opd";
  rangeStart: string; rangeEnd: string;
  visits: ClinicaVisit[];
  visitCount: number; patientCount: number;
};

export function isOpdReport(buf: Buffer | ArrayBuffer): boolean {
  const rows = firstSheetRows(buf);
  return rows.length > 0 && rows[0].some((h) => cell([h], 0) === "เลขที่บริการ");
}

export function parseOpdReport(buf: Buffer | ArrayBuffer): ClinicaOpdParse {
  return parseOpdRows(firstSheetRows(buf));
}

function parseOpdRows(rows: Sheet): ClinicaOpdParse {
  if (!rows.length) throw new Error("ไฟล์ว่าง");
  const h = headerIndex(rows[0]);
  const need = (label: string): number => {
    const i = h.get(label);
    if (i == null) throw new Error(`ไม่พบคอลัมน์ "${label}" — ไม่ใช่ไฟล์ OPD Report`);
    return i;
  };
  const cVisit = need("เลขที่บริการ"), cDate = need("วันที่"), cTime = need("เวลา"), cHn = need("รหัสลูกค้า"),
    cSex = need("เพศ"), cBirth = need("วันเกิด"), cDoc = need("แพทย์ (ผู้วินิจฉัย)"),
    cDxCode = need("รหัสการวินิจฉัย"), cDxTh = need("รายการวินิจฉัย (TH)"), cDxEn = need("รายการวินิจฉัย (EN)");

  const seen = new Set<string>();
  const visits: ClinicaVisit[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const visitNo = cell(r, cVisit);
    if (!/^OPD/i.test(visitNo)) continue;   // drops any trailing summary row
    const dxCode = cell(r, cDxCode);
    const key = `${visitNo}|${dxCode}`;
    if (seen.has(key)) continue;            // verbatim-duplicate export lines
    seen.add(key);
    const date = beDateToIso(cell(r, cDate));
    if (!date) continue;
    visits.push({
      visitNo, date, time: cell(r, cTime), hn: cell(r, cHn),
      gender: cell(r, cSex), birthDate: beDateToIso(cell(r, cBirth)), doctor: cell(r, cDoc),
      dxCode, dxTh: cell(r, cDxTh), dxEn: cell(r, cDxEn)
    });
  }

  const dates = visits.map((v) => v.date).sort();
  return {
    kind: "opd",
    rangeStart: dates[0] ?? "", rangeEnd: dates[dates.length - 1] ?? "",
    visits,
    visitCount: new Set(visits.map((v) => v.visitNo)).size,
    patientCount: new Set(visits.map((v) => v.hn).filter(Boolean)).size
  };
}

// ── Outstanding report ──────────────────────────────────────────────────────
// The HIS "Invoice Report" filtered to unpaid bills only has the SAME layout as
// the full report, so it is told apart by content: every bill in it still owes
// money. It must never go through the range-replace import (that would delete
// the paid bills inside its span) — it is a snapshot of what is still open.

export type ClinicaOutstandingParse = Omit<ClinicaInvoiceParse, "kind"> & { kind: "outstanding" };

// ── Receipt report ──────────────────────────────────────────────────────────
// One row per receipt LINE ITEM; the payment sits on the receipt's first line(s):
// ช่องทางชำระ / งวดที่ / ยอดชำระ / ค่าธรรมเนียมบัตร / ยอดค้างชำระ. เอกสารอ้างอิง is
// the BL invoice the receipt settles. A receipt that books an insurer's share as
// receivable carries ยอดชำระ 0 and ยอดค้างชำระ > 0. The trailing summary rows
// (no RE number) are dropped. Receipt dates can be back-dated to the service
// day, so they say WHAT was paid and through which channel, not when late
// money really arrived.

export type ClinicaReceiptPayment = { installment: number; channel: string; paid: number; fee: number; outstanding: number };
export type ClinicaReceipt = {
  receiptNo: string; billNo: string; date: string; time: string; hn: string; payerGroup: string;
  payments: ClinicaReceiptPayment[];
};
export type ClinicaReceiptParse = {
  kind: "receipt";
  rangeStart: string; rangeEnd: string;
  receipts: ClinicaReceipt[];
  receiptCount: number;
  totalPaid: number; totalOutstanding: number;
};

export function isReceiptReport(buf: Buffer | ArrayBuffer): boolean {
  const rows = firstSheetRows(buf);
  return rows.length > 0 && rows[0].some((h) => cell([h], 0) === "เลขที่ใบเสร็จ");
}

export function parseReceiptReport(buf: Buffer | ArrayBuffer): ClinicaReceiptParse {
  return parseReceiptRows(firstSheetRows(buf));
}

function parseReceiptRows(rows: Sheet): ClinicaReceiptParse {
  if (!rows.length) throw new Error("ไฟล์ว่าง");
  const h = headerIndex(rows[0]);
  const need = (...labels: string[]): number => {
    for (const l of labels) { const i = h.get(l); if (i != null) return i; }
    throw new Error(`ไม่พบคอลัมน์ "${labels[0]}" — ไม่ใช่ไฟล์ Receipt Report`);
  };
  const cRec = need("เลขที่ใบเสร็จ"), cRef = need("เอกสารอ้างอิง"), cDate = need("วัน", "วันที่"), cTime = need("เวลา"),
    cHn = need("รหัสลูกค้า"), cPayer = need("กลุ่มลูกค้า"), cChan = need("ช่องทางชำระ"), cInst = need("งวดที่"),
    cPaid = need("ยอดชำระ"), cFee = need("ค่าธรรมเนียมบัตร"), cOut = need("ยอดค้างชำระ");

  const order: string[] = [];
  const byRec = new Map<string, ClinicaReceipt>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const receiptNo = cell(r, cRec);
    if (!/^RE/i.test(receiptNo)) continue;          // drops the trailing summary rows
    let rec = byRec.get(receiptNo);
    if (!rec) {
      rec = {
        receiptNo, billNo: cell(r, cRef), date: beDateToIso(cell(r, cDate)) ?? "", time: cell(r, cTime),
        hn: cell(r, cHn), payerGroup: cell(r, cPayer), payments: []
      };
      byRec.set(receiptNo, rec); order.push(receiptNo);
    }
    const channel = cell(r, cChan);
    if (!channel) continue;                          // item line without a payment
    const inst = Math.max(1, Math.round(num(r[cInst])));
    // A payment is printed once per receipt; if an export repeats it on every item
    // line, the same installment + channel must not be summed again.
    if (rec.payments.some((p) => p.installment === inst && p.channel === channel)) continue;
    rec.payments.push({
      installment: inst, channel,
      paid: round2(num(r[cPaid])), fee: round2(num(r[cFee])), outstanding: round2(num(r[cOut]))
    });
  }
  const receipts = order.map((k) => byRec.get(k)!);
  const dates = receipts.map((x) => x.date).filter(Boolean).sort();
  const sum = (f: (p: ClinicaReceiptPayment) => number) => round2(receipts.reduce((s, x) => s + x.payments.reduce((t, p) => t + f(p), 0), 0));
  return {
    kind: "receipt",
    rangeStart: dates[0] ?? "", rangeEnd: dates[dates.length - 1] ?? "",
    receipts, receiptCount: receipts.length,
    totalPaid: sum((p) => p.paid), totalOutstanding: sum((p) => p.outstanding)
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export type ClinicaFileParse = ClinicaInvoiceParse | ClinicaOutstandingParse | ClinicaReceiptParse | ClinicaOpdParse;

/** Sniff the file kind by header and parse — reads the workbook ONCE. An Invoice
 *  Report whose every bill still owes money is the "outstanding" snapshot. Throws
 *  if it is none of the clinic reports. */
export function parseClinicaFile(buf: Buffer | ArrayBuffer): ClinicaFileParse {
  const rows = firstSheetRows(buf);
  const header = rows[0] ?? [];
  if (header.some((h) => cell([h], 0) === "เลขที่ใบแจ้งหนี้")) {
    const p = parseInvoiceRows(rows);
    if (p.bills.length > 0 && p.bills.every((b) => b.due > 0.005)) return { ...p, kind: "outstanding" };
    return p;
  }
  if (header.some((h) => cell([h], 0) === "เลขที่ใบเสร็จ")) return parseReceiptRows(rows);
  if (header.some((h) => cell([h], 0) === "เลขที่บริการ")) return parseOpdRows(rows);
  throw new Error("ไม่รู้จักรูปแบบไฟล์ — ต้องเป็น Invoice / Receipt / OPD Report ของคลินิก");
}
