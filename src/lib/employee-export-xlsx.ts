// XLSX renderer for the employee export (owner 2026-09-07). One worksheet per
// company; branch (สังกัด) sections stacked with a heading + column header row.
// xlsx is already a dependency.

import * as XLSX from "xlsx";
import type { EmployeeDoc, EmployeeCell } from "./employee-export";

function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "บริษัท";
  let name = base, i = 2;
  while (used.has(name)) { const s = ` (${i++})`; name = base.slice(0, 31 - s.length) + s; }
  used.add(name);
  return name;
}

export function renderEmployeeXlsx(doc: EmployeeDoc, generatedLabel: string, note?: string | null): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const headers = doc.columns.map((c) => c.header);

  for (const c of doc.companies) {
    const aoa: EmployeeCell[][] = [];
    aoa.push(["รายชื่อและข้อมูลพนักงาน"]);
    aoa.push(["บริษัท", c.name]);
    aoa.push(["จำนวน", `${c.count} คน`]);
    aoa.push(["ออกเอกสารเมื่อ", generatedLabel]);
    if (note && note.trim()) aoa.push(["หมายเหตุ", note.trim()]);
    aoa.push([]);
    for (const bl of c.branches) {
      aoa.push([`สาขา: ${bl.branchName} (${bl.rows.length} คน)`]);
      aoa.push(headers);
      for (const r of bl.rows) aoa.push(r.cells);
      aoa.push([]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = doc.columns.map((col) => ({ wch: col.kind === "text" || col.kind === "branches" ? 20 : 12 }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName(c.name, used));
  }

  // Nothing to export → a single note sheet so the file is still valid.
  if (doc.companies.length === 0) {
    const ws = XLSX.utils.aoa_to_sheet([["ไม่มีข้อมูลพนักงานในขอบเขตที่เลือก"]]);
    XLSX.utils.book_append_sheet(wb, ws, "ว่าง");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
