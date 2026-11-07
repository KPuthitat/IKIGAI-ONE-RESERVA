// CLINICA HIS parser tests (owner 2026-09-26): invoice + OPD reports, with the
// trailing "ยอดรวม" grand-total row dropped, Buddhist→Gregorian dates, and
// verbatim-duplicate OPD lines deduped. Synthetic .xlsx buffers (no fixtures).
//
// Run:  node --import tsx scripts/test-clinica-parse.ts

import * as XLSX from "xlsx";
import * as C from "../src/lib/clinica-parse";

function buf(header: string[], rows: (string | number)[][], sheetName: string): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`); }
};
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

// ── Buddhist date conversion ──
ok("beDateToIso: 01/08/2569 → 2026-08-01", C.beDateToIso("01/08/2569") === "2026-08-01");
ok("beDateToIso: single-digit padded", C.beDateToIso("5/1/2569") === "2026-01-05");
ok("beDateToIso: junk → null", C.beDateToIso("-") === null);

// ── Invoice report ──
const invHeader = ["เลขที่ใบแจ้งหนี้", "วัน", "เวลา", "รหัสลูกค้า", "กลุ่มลูกค้า", "ผู้ทำรายการ", "รหัส", "รายการ", "จำนวน", "หน่วย", "ราคารวม", "ส่วนลด", "ราคาสุทธิ", "ยอดรวม", "ส่วนลดท้ายบิล", "รวมสุทธิ", "ยอดชำระรวม", "ยอดค้างชำระ"];
const invRows: (string | number)[][] = [
  // BL001 — 2 lines, cash, fully paid. Bill totals on first line only.
  ["BL001", "01/08/2569", "17:00:00", "HN1", "ผู้ป่วยทั่วไป", "แอดมิน A", "GEN001", "[HSC] ค่าบริการผู้ป่วยนอก", 1, "ครั้ง", 300, 0, 300, 380, 0, 380, 380, 0],
  ["BL001", "01/08/2569", "17:00:00", "HN1", "ผู้ป่วยทั่วไป", "แอดมิน A", "IKGPH/A1", "[#C1Y][ARI] Cetirizine", 10, "เม็ด", 80, 0, 80, "", "", "", "", ""],
  // BL002 — 1 line, insurance, unpaid → AR.
  ["BL002", "02/08/2569", "18:00:00", "HN2", "ประกันกลุ่ม บมจ.เอ", "แอดมิน A", "LAB1", "[LAB] CBC", 1, "ครั้ง", 500, 50, 450, 500, 50, 450, 0, 450],
  // Trailing grand-total row the export appends — MUST be dropped.
  ["ยอดรวม", "", "", "", "", "", "", "", "", "", "", "", "", "", "", 830, 380, 450],
];
const inv = C.parseInvoiceReport(buf(invHeader, invRows, "Invoice Report"));
ok("invoice: drops 'ยอดรวม' summary row → 2 bills", inv.billCount === 2);
ok("invoice: totalNet = 830 (380+450)", near(inv.totalNet, 830));
ok("invoice: totalPaid = 380, totalDue = 450", near(inv.totalPaid, 380) && near(inv.totalDue, 450));
ok("invoice: patientCount = 2", inv.patientCount === 2);
ok("invoice: range 2026-08-01 .. 2026-08-02", inv.rangeStart === "2026-08-01" && inv.rangeEnd === "2026-08-02");
ok("invoice: BL001 has 2 items, first is [HSC]", (() => { const b = inv.bills.find((x) => x.billNo === "BL001")!; return b.items.length === 2 && b.items[0].name.startsWith("[HSC]") && b.date === "2026-08-01"; })());
ok("invoice: BL002 insurance, net 450 unpaid (AR)", (() => { const b = inv.bills.find((x) => x.billNo === "BL002")!; return near(b.net, 450) && near(b.due, 450) && b.payerGroup.includes("ประกัน"); })());

// ── OPD report ──
const opdHeader = ["เลขที่บริการ", "วินิจฉัยเลขที่", "วันที่", "เวลา", "ประเภท", "รหัสลูกค้า", "คำนำหน้า", "ชื่อ", "นามสกุล", "เพศ", "วันเกิด", "อายุ (ปี/เดือน)", "แพทย์ (ผู้วินิจฉัย)", "รหัสการวินิจฉัย", "รายการวินิจฉัย (TH)", "รายการวินิจฉัย (EN)"];
const opdRows: (string | number)[][] = [
  ["OPD1", "OPD1-1", "01/08/2569", "17:11:06", "OPD", "HN1", "นาย", "ก", "ข", "ชาย", "05/12/2526", "42 ปี", "นพ.เอ", "J00", "หวัด", "Common cold"],
  ["OPD1", "OPD1-1", "01/08/2569", "17:11:06", "OPD", "HN1", "นาย", "ก", "ข", "ชาย", "05/12/2526", "42 ปี", "นพ.เอ", "J00", "หวัด", "Common cold"], // verbatim dup
  ["OPD2", "OPD2-1", "02/08/2569", "18:00:00", "OPD", "HN2", "นางสาว", "ค", "ง", "หญิง", "01/01/2540", "26 ปี", "นพ.เอ", "J20", "หลอดลมอักเสบ", "Acute bronchitis"],
];
const opd = C.parseOpdReport(buf(opdHeader, opdRows, "OPD Report"));
ok("opd: dedups verbatim line → 2 visits", opd.visits.length === 2 && opd.visitCount === 2);
ok("opd: patientCount = 2", opd.patientCount === 2);
ok("opd: range 2026-08-01 .. 2026-08-02", opd.rangeStart === "2026-08-01" && opd.rangeEnd === "2026-08-02");
ok("opd: doctor + dx + birthdate parsed", (() => { const v = opd.visits[0]; return v.doctor === "นพ.เอ" && v.dxTh === "หวัด" && v.dxCode === "J00" && v.birthDate === "1983-12-05"; })());

// ── Dispatch + guards ──
ok("dispatch: invoice detected", C.parseClinicaFile(buf(invHeader, invRows, "Invoice Report")).kind === "invoice");
ok("dispatch: opd detected", C.parseClinicaFile(buf(opdHeader, opdRows, "OPD Report")).kind === "opd");
let threw = false;
try { C.parseClinicaFile(buf(["a", "b"], [["1", "2"]], "Other")); } catch { threw = true; }
ok("dispatch: unknown file → throws", threw);

// ── Accounts-receivable ledger (title row above the header, no line items) ──
const arHeader = ["เลขที่ใบแจ้งหนี้", "วันที่บิล", "รหัสลูกค้า", "ชื่อลูกค้า", "โทร", "กลุ่มลูกค้า", "ผู้ทำรายการ", "แผนก", "อายุหนี้ (วัน)", "เลขที่ใบเสร็จ", "วันที่ชำระ", "งวด", "ช่องทางชำระ", "ยอดชำระ", "คงเหลือหลังงวดนี้ *", "ยอดบิล", "ชำระแล้ว ณ วันที่", "ค้างชำระ ณ วันที่ 07/11/2569", "หมายเหตุ", "แท็ก"];
const arRows: (string | number)[][] = [
  ["BL1", "01/07/2567", "HN1", "ก", "", "บริษัท เอ", "แอดมิน", "-", 859, "RE1", "01/07/2567", "งวด 1", "วางบิล", 0, 750, 750, 0, 750, "", ""],
  // two instalments: bill totals only on the last row
  ["BL2", "05/11/2569", "HN2", "ข", "", "ประกัน บี", "แอดมิน", "-", 2, "RE2", "05/11/2569", "งวด 1", "วางบิล", 0, 800, "", "", "", "", ""],
  ["BL2", "05/11/2569", "HN2", "ข", "", "ประกัน บี", "แอดมิน", "-", 2, "RE2", "05/11/2569", "งวด 2", "วางบิล", 0, 800, 800, 0, 800, "", ""],
  ["ยอดรวม 2 บิล", "", "", "", "", "", "", "", "", "3 ใบเสร็จ", "", "", "", 0, "", 1550, 0, 1550, "", ""],
];
const arWs = XLSX.utils.aoa_to_sheet([["รายงานบัญชีลูกหนี้ · ยอด ณ วันที่ 07/11/2569"], arHeader, ...arRows]);
const arWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(arWb, arWs, "ลูกหนี้");
XLSX.utils.book_append_sheet(arWb, XLSX.utils.aoa_to_sheet([["อายุหนี้", "บิล"]]), "อายุหนี้");
const arBuf = XLSX.write(arWb, { type: "buffer", bookType: "xlsx" }) as Buffer;
const ar = C.parseClinicaFile(arBuf);
ok("ar: detected as outstanding snapshot", ar.kind === "outstanding");
ok("ar: 2 bills, total row dropped", ar.kind === "outstanding" && ar.bills.length === 2);
ok("ar: totals 1550 due", ar.kind === "outstanding" && near(ar.totalDue, 1550) && near(ar.totalNet, 1550));
ok("ar: bill totals taken from the instalment row that carries them", ar.kind === "outstanding" && near(ar.bills[1].due, 800) && near(ar.bills[1].net, 800));
ok("ar: Buddhist dates + range", ar.kind === "outstanding" && ar.rangeStart === "2024-07-01" && ar.rangeEnd === "2026-11-05");

console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
