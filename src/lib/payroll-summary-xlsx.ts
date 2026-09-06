// XLSX renderer for the payroll monthly summary document (owner 2026-09-06).
// One worksheet per section (company/branch). Money is written as real numbers
// (deductions negative) so the accountant can SUM/pivot in Excel; the header
// block + pay-round block sit above each table for reconciliation. xlsx is
// already a dependency (used by the DF invoice parser).

import * as XLSX from "xlsx";
import { DOC_COLUMNS, type PayrollSummaryDoc, type EmpDocRow, type DocColumn } from "./payroll-summary-doc";

type Cell = string | number;

function cellValue(r: EmpDocRow, col: DocColumn): Cell {
  const v = r[col.key];
  if (col.kind === "text") return String(v ?? "");
  if (col.kind === "count") return Number(v) || 0;
  const n = Number(v) || 0;
  if (col.kind === "deduction") return n > 0 ? -n : 0;
  return n;
}

// Excel sheet names: ≤31 chars, none of []:*?/\ , and unique.
function sheetName(title: string, used: Set<string>): string {
  let base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "ส่วน";
  let name = base, i = 2;
  while (used.has(name)) {
    const suffix = ` (${i++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name);
  return name;
}

export function renderPayrollSummaryXlsx(
  doc: PayrollSummaryDoc, generatedLabel: string, note?: string | null
): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  for (const s of doc.sections) {
    const aoa: Cell[][] = [];
    aoa.push(["เอกสารสรุปค่าตอบแทนรายเดือน"]);
    aoa.push(["ขอบเขต", s.title]);
    aoa.push(["เดือนที่จ่าย", doc.monthLabel]);
    aoa.push(["เซอร์วิสชาร์จของเดือน", doc.svcMonthLabel]);
    aoa.push(["ออกเอกสารเมื่อ", generatedLabel]);
    if (s.taxId) aoa.push(["เลขประจำตัวผู้เสียภาษี", s.taxId]);
    if (s.address) aoa.push(["ที่อยู่", s.address]);
    if (note && note.trim()) aoa.push(["หมายเหตุ", note.trim()]);
    aoa.push(["คอลัมน์ที่มี (หัก) เป็นรายการหัก แสดงเป็นค่าติดลบ"]);
    aoa.push([]);

    // Pay-round block (รอบจ่าย) for reconciliation.
    aoa.push(["รอบจ่ายที่กระทบยอดในเดือนนี้"]);
    aoa.push(["ประเภทรอบ", "ช่วงงวด", "วันจ่าย", "สถานะ", "สาขา", "ยอดจ่ายรวม", "ยอดสุทธิ"]);
    if (s.payRounds.length === 0) {
      aoa.push(["— ไม่มีรอบจ่ายในเดือนนี้ (มีเฉพาะเซอร์วิสชาร์จ) —"]);
    }
    for (const p of s.payRounds) {
      aoa.push([p.cycleLabel, `${p.periodStart} ถึง ${p.periodEnd}`, p.payDate, p.statusLabel,
        p.branchName ?? "", p.gross, p.net]);
    }
    aoa.push([]);

    // Employee table.
    aoa.push(DOC_COLUMNS.map((c) => c.header));
    for (const r of s.rows) aoa.push(DOC_COLUMNS.map((c) => cellValue(r, c)));
    const t = s.totals;
    aoa.push(["รวม", "", "", "", t.comp, t.svcGross, t.income,
      t.sso > 0 ? -t.sso : 0, t.tax > 0 ? -t.tax : 0, t.gi > 0 ? -t.gi : 0, t.take, ""]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
      { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, sheetName(s.title, used));
  }

  // Grand-total sheet when more than one section.
  if (doc.sections.length > 1) {
    const g = doc.grand;
    const aoa: Cell[][] = [
      ["รวมทั้งหมด (ทุกส่วน)"],
      ["ขอบเขต", doc.scopeLabel],
      ["เดือนที่จ่าย", doc.monthLabel],
      [],
      ["รายการ", "จำนวนเงิน (บาท)"],
      ["ค่าตอบแทน", g.comp],
      ["เซอร์วิสชาร์จ", g.svcGross],
      ["รวมรายรับ", g.income],
      ["ประกันสังคม (หัก)", g.sso > 0 ? -g.sso : 0],
      ["ภาษี ณ ที่จ่าย (หัก)", g.tax > 0 ? -g.tax : 0],
      ["ประกันกลุ่ม (หัก)", g.gi > 0 ? -g.gi : 0],
      ["รวมรับจริง", g.take]
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 24 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName("รวมทั้งหมด", used));
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
