// XLSX renderer for the payroll monthly summary document (owner 2026-09-06,
// Phase 1). One worksheet per branch heading (คำนวณระดับบริษัท · แยกหัวข้อสาขา):
// each carries the per-round breakdown (ยอดก่อนหัก → หัก → สุทธิ) then the final
// per-person rollup. Money is written as real numbers (deductions negative) so
// the accountant can SUM/pivot in Excel. xlsx is already a dependency.

import * as XLSX from "xlsx";
import { ROLLUP_COLUMNS, type PayrollSummaryDoc, type EmpDocRow, type DocColumn, type DocTotals } from "./payroll-summary-doc";

type Cell = string | number;

function rollupVal(r: EmpDocRow, col: DocColumn): Cell {
  const v = r[col.key];
  if (col.kind === "text") return String(v ?? "");
  if (col.kind === "count") return Number(v) || 0;
  const n = Number(v) || 0;
  if (col.kind === "deduction") return n > 0 ? -n : 0;
  return n;
}
function totalsRow(label: string, t: DocTotals): Cell[] {
  return [label, "", t.comp, t.svcGross, t.income,
    t.sso > 0 ? -t.sso : 0, t.tax > 0 ? -t.tax : 0, t.gi > 0 ? -t.gi : 0,
    t.other > 0 ? -t.other : 0, t.deduction > 0 ? -t.deduction : 0, t.take, ""];
}

function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "ส่วน";
  let name = base, i = 2;
  while (used.has(name)) { const s = ` (${i++})`; name = base.slice(0, 31 - s.length) + s; }
  used.add(name);
  return name;
}

export function renderPayrollSummaryXlsx(
  doc: PayrollSummaryDoc, generatedLabel: string, note?: string | null
): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const rollupHeader = ROLLUP_COLUMNS.map((c) => c.header);

  for (const c of doc.companies) {
    for (const bl of c.branches) {
      const aoa: Cell[][] = [];
      aoa.push(["สรุปค่าตอบแทนรายเดือน (คำนวณระดับบริษัท · แยกหัวข้อสาขา)"]);
      aoa.push(["บริษัท", c.name]);
      if (c.taxId) aoa.push(["เลขประจำตัวผู้เสียภาษี", c.taxId]);
      aoa.push(["สาขา", bl.branchName]);
      aoa.push(["เดือนที่จ่าย", doc.monthLabel]);
      aoa.push(["เซอร์วิสชาร์จของเดือน", doc.svcMonthLabel]);
      aoa.push(["ออกเอกสารเมื่อ", generatedLabel]);
      if (note && note.trim()) aoa.push(["หมายเหตุ", note.trim()]);
      aoa.push(["คอลัมน์ที่มี (หัก) เป็นรายการหัก แสดงเป็นค่าติดลบ · เซอร์วิสชาร์จคำนวณระดับบริษัท"]);
      aoa.push([]);

      // Per-round breakdown.
      for (const g of bl.roundGroups) {
        aoa.push([`รอบจ่าย: ${g.info.cycleLabel} · งวด ${g.info.periodStart} ถึง ${g.info.periodEnd} · จ่าย ${g.info.payDate} · ${g.info.statusLabel}`]);
        aoa.push(["ชื่อ-นามสกุล", "สังกัด", "ยอดก่อนหัก", "ยอดหัก", "ยอดสุทธิ"]);
        for (const m of g.members) aoa.push([m.name, m.homeBranch, m.before, m.deduction > 0 ? -m.deduction : 0, m.net]);
        aoa.push(["รวมรอบ", "", g.before, g.deduction > 0 ? -g.deduction : 0, g.net]);
        aoa.push([]);
      }
      if (bl.roundGroups.length === 0) { aoa.push(["(ไม่มีรอบจ่ายในเดือนนี้ — มีเฉพาะเซอร์วิสชาร์จ)"]); aoa.push([]); }

      // Final per-person rollup.
      aoa.push(["สรุปรวมต่อคน (ทั้งเดือน · รวมเซอร์วิสชาร์จระดับบริษัท)"]);
      aoa.push(rollupHeader);
      for (const r of bl.rollup) aoa.push(ROLLUP_COLUMNS.map((col) => rollupVal(r, col)));
      aoa.push(totalsRow("รวมสาขา", bl.totals));

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [{ wch: 24 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 13 }, { wch: 15 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 6 }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName(bl.branchName, used));
    }
  }

  // Company / grand totals sheet.
  const sum: Cell[][] = [["สรุปยอดรวม"], ["ขอบเขต", doc.scopeLabel], ["เดือนที่จ่าย", doc.monthLabel], []];
  sum.push(["ระดับ", ...rollupHeader.slice(2)]);
  for (const c of doc.companies) sum.push([`บริษัท ${c.name}`, ...totalsRow("", c.totals).slice(2)]);
  if (doc.companies.length > 1) sum.push([`รวมทั้งหมด`, ...totalsRow("", doc.grand).slice(2)]);
  const ws = XLSX.utils.aoa_to_sheet(sum);
  ws["!cols"] = [{ wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 13 }, { wch: 15 }, { wch: 13 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 6 }];
  XLSX.utils.book_append_sheet(wb, ws, sheetName("สรุปยอดรวม", used));

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
