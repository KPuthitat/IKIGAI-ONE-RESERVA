// CLINICA receipts + receivable settlement tests (owner 2026-10-04):
//  • Receipt Report parser (payment lines, summary rows dropped, kind sniffing,
//    outstanding-only invoice told apart from a full invoice)
//  • range-replace receipt import + channel mix
//  • settlement detection from a full Invoice re-import AND from the outstanding
//    snapshot (never deletes paid bills, never re-opens, same-day skipped),
//    confirm / dismiss flow
// Run:  node --import tsx scripts/test-clinica-receivables.ts

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import type { ClinicaInvoiceParse, ClinicaOutstandingParse } from "../src/lib/clinica-parse";

const TMP = path.join(process.cwd(), "data", "test-clinica-receivables.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

function buf(header: string[], rows: (string | number)[][], sheetName: string): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

(async () => {
  const P = await import("../src/lib/clinica-parse");
  const S = await import("../src/lib/clinica-shared");
  const { getDb } = await import("../src/lib/db");
  const cdb = await import("../src/lib/clinica-db");
  const db = getDb();

  let passed = 0, failed = 0;
  const ok = (n: string, c: boolean) => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const q1 = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  // ── channel helpers ──
  ok("channel kind: cash / bank / receivable", S.receiptChannelKind("เงินสด (เงินสด)") === "cash" && S.receiptChannelKind("ธนาคาร (ธนาคารกสิกรไทย KSHOP)") === "bank" && S.receiptChannelKind("อื่นๆ (ประกันกลุ่ม เอ)") === "receivable");
  ok("an unseen channel (card/QR) is bank-like cash-in, never a receivable", S.receiptChannelKind("บัตรเครดิต (VISA)") === "bank" && S.receiptChannelKind("QR (พร้อมเพย์)") === "bank");
  ok("channel label strips the wrapper", S.receiptChannelLabel("ธนาคาร (ธนาคารกสิกรไทย KSHOP)") === "ธนาคารกสิกรไทย KSHOP" && S.receiptChannelLabel("เงินสด (เงินสด)") === "เงินสด");

  // ── Receipt parser ──
  const rh = ["เลขที่ใบเสร็จ", "เอกสารอ้างอิง", "วัน", "เวลา", "รหัสลูกค้า", "กลุ่มลูกค้า", "รหัส", "รายการ", "รวมสุทธิ", "ช่องทางชำระ", "งวดที่", "ยอดชำระ", "ค่าธรรมเนียมบัตร", "ยอดค้างชำระ"];
  const rrows: (string | number)[][] = [
    ["RE1", "BL1", "03/10/2569", "09:00:00", "HN1", "ผู้ป่วยทั่วไป", "G1", "ค่าบริการ", 1399, "เงินสด (เงินสด)", 1, 1399, 0, 0],
    ["RE1", "BL1", "03/10/2569", "09:00:00", "HN1", "ผู้ป่วยทั่วไป", "G2", "แล็บ", "", "", "", "", "", ""],
    ["RE2", "BL2", "03/10/2569", "10:00:00", "HN2", "ผู้ป่วยทั่วไป", "G1", "ค่าบริการ", 865, "ธนาคาร (ธนาคารกสิกรไทย KSHOP)", 1, 865, 0, 0],
    ["RE3", "BL3", "03/10/2569", "11:00:00", "HN3", "ประกันกลุ่ม เอ", "G1", "ค่าบริการ", 1200, "อื่นๆ (ประกันกลุ่ม เอ)", 1, 0, 0, 1200],
    ["", "", "", "", "", "", "", "", "", "เงินสด", "", 1399, "", ""],           // trailing summary row — dropped
  ];
  const rec = P.parseReceiptReport(buf(rh, rrows, "Receipt Report"));
  ok("receipt parse: 3 receipts, summary row dropped", rec.receiptCount === 3);
  ok("receipt parse: paid 2264, outstanding 1200", near(rec.totalPaid, 2264) && near(rec.totalOutstanding, 1200));
  ok("receipt parse: RE1 one payment line (item rows have none), bill ref BL1", rec.receipts[0].payments.length === 1 && rec.receipts[0].billNo === "BL1");
  ok("receipt parse: range 2026-10-03", rec.rangeStart === "2026-10-03" && rec.rangeEnd === "2026-10-03");
  // An export that repeats the payment columns on every item line must not triple the money.
  const repeated = P.parseReceiptReport(buf(rh, [
    ["RE9", "BL9", "05/10/2569", "09:00:00", "HN9", "ผู้ป่วยทั่วไป", "G1", "a", 1000, "บัตรเครดิต (VISA)", 1, 1000, 30, 0],
    ["RE9", "BL9", "05/10/2569", "09:00:00", "HN9", "ผู้ป่วยทั่วไป", "G2", "b", 1000, "บัตรเครดิต (VISA)", 1, 1000, 30, 0],
    ["RE9", "BL9", "05/10/2569", "09:00:00", "HN9", "ผู้ป่วยทั่วไป", "G3", "c", 1000, "บัตรเครดิต (VISA)", 1, 1000, 30, 0],
  ], "Receipt Report"));
  ok("receipt parse: repeated payment columns counted once", repeated.receipts[0].payments.length === 1 && near(repeated.totalPaid, 1000));
  ok("sniff: receipt file", P.parseClinicaFile(buf(rh, rrows, "Receipt Report")).kind === "receipt");

  // ── Invoice vs outstanding sniffing ──
  const ih = ["เลขที่ใบแจ้งหนี้", "วัน", "เวลา", "รหัสลูกค้า", "กลุ่มลูกค้า", "ผู้ทำรายการ", "รหัส", "รายการ", "จำนวน", "หน่วย", "ราคารวม", "ส่วนลด", "ราคาสุทธิ", "ยอดรวม", "ส่วนลดท้ายบิล", "รวมสุทธิ", "ยอดชำระรวม", "ยอดค้างชำระ"];
  const irow = (no: string, d: string, net: number, due: number): (string | number)[] =>
    [no, d, "10:00:00", `HN-${no}`, due > 0 ? "ประกันกลุ่ม เอ" : "ผู้ป่วยทั่วไป", "แอดมิน", "G1", "บริการ", 1, "ครั้ง", net, 0, net, net, 0, net, net - due, due];
  ok("sniff: full invoice stays invoice", P.parseClinicaFile(buf(ih, [irow("BL1", "01/08/2569", 100, 0), irow("BL2", "02/08/2569", 200, 200)], "Invoice Report")).kind === "invoice");
  ok("sniff: all-bills-owing invoice = outstanding snapshot", P.parseClinicaFile(buf(ih, [irow("BL2", "02/08/2569", 200, 200)], "Invoice Report")).kind === "outstanding");
  const ihAlt = ih.map((h) => (h === "วัน" ? "วันที่" : h));
  ok("invoice parse accepts 'วันที่' date header", P.parseInvoiceReport(buf(ihAlt, [irow("BL1", "01/08/2569", 100, 0)], "Invoice Report")).bills[0].date === "2026-08-01");

  // ── Receipt import (range-replace) + channel mix ──
  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('clinic','AT HOME')").run().lastInsertRowid);
  cdb.importReceipt(branch, rec);
  ok("receipt import: 3 payment rows", q1("SELECT COUNT(*) n FROM clinica_receipts WHERE branch_id=?", branch) === 3);
  cdb.importReceipt(branch, rec);
  ok("receipt re-import is idempotent (still 3)", q1("SELECT COUNT(*) n FROM clinica_receipts WHERE branch_id=?", branch) === 3);
  const mix = cdb.clinicaChannelMix(branch, "2026-10-01", "2026-10-31");
  ok("channel mix: cash 1399, bank 865, receivable 1200 in that order", mix.length === 3 && mix[0].kind === "cash" && near(mix[0].amount, 1399) && mix[1].kind === "bank" && near(mix[1].amount, 865) && mix[2].kind === "receivable" && near(mix[2].amount, 1200));
  ok("cash channels exclude receivable lines, cash first", (() => { const c = cdb.clinicaCashChannels(branch); return c.length === 2 && c[0].startsWith("เงินสด") && c[1].startsWith("ธนาคาร"); })());

  cdb.importReceipt(branch, repeated);
  ok("card receipts show as bank cash-in in the mix and as a landing channel", cdb.clinicaChannelMix(branch, "2026-10-01", "2026-10-31").some((m) => m.kind === "bank" && m.label === "VISA" && near(m.amount, 1000)) && cdb.clinicaCashChannels(branch).some((c) => c.startsWith("บัตรเครดิต")));
  ok("receivable rows stay separate from paid rows", cdb.clinicaChannelMix(branch, "2026-10-01", "2026-10-31").filter((m) => m.kind === "receivable").length === 1);

  // ── Settlement detection from a full invoice re-import ──
  const bill = (billNo: string, date: string, net: number, due: number, payer = "ประกันกลุ่ม เอ"): ClinicaInvoiceParse["bills"][number] => ({
    billNo, date, time: "10:00:00", hn: `HN-${billNo}`, payerGroup: payer, staff: "แอดมิน",
    gross: net, billDiscount: 0, net, paid: net - due, due,
    items: [{ code: "G1", name: "บริการ", qty: 1, unit: "ครั้ง", lineGross: net, lineDiscount: 0, lineNet: net }]
  });
  const invParse = (bills: ClinicaInvoiceParse["bills"]): ClinicaInvoiceParse => {
    const ds = bills.map((b) => b.date).filter(Boolean).sort();
    return { kind: "invoice", rangeStart: ds[0] ?? "", rangeEnd: ds[ds.length - 1] ?? "", bills, billCount: bills.length, patientCount: bills.length,
      totalNet: bills.reduce((s, b) => s + b.net, 0), totalPaid: bills.reduce((s, b) => s + b.paid, 0), totalDue: bills.reduce((s, b) => s + b.due, 0) };
  };
  const outParse = (bills: ClinicaInvoiceParse["bills"]): ClinicaOutstandingParse => ({ ...invParse(bills), kind: "outstanding" });
  const nSettle = () => q1("SELECT COUNT(*) n FROM clinica_settlements WHERE branch_id=?", branch);

  const T0 = "2026-10-04";
  // Day 1: A (insurer, 1000 open), B (insurer, 500 open), C (cash, paid), D (insurer, 300 open, will be voided).
  const r1 = cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 1000), bill("B", "2026-08-02", 500, 500), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป"), bill("D", "2026-08-04", 300, 300)]), { today: T0 });
  ok("first import records no settlement (nothing was open before)", r1.settlements === 0 && nSettle() === 0);

  // Day 2: full-year invoice again. A is now paid in full, B partly (500→200). D vanished (void).
  const r2 = cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 500, 200), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป")]), { today: "2026-10-05" });
  ok("invoice re-import: 2 settlements (A full, B partial)", r2.settlements === 2 && nSettle() === 2);
  const sA = db.prepare("SELECT amount, settled_date, detected_on, status FROM clinica_settlements WHERE bill_no='A'").get() as { amount: number; settled_date: string; detected_on: string; status: string };
  ok("A: amount 1000, dated import day, pending", near(sA.amount, 1000) && sA.settled_date === "2026-10-05" && sA.detected_on === "2026-10-05" && sA.status === "pending");
  ok("B: partial payment 300", near((db.prepare("SELECT amount FROM clinica_settlements WHERE bill_no='B'").get() as { amount: number }).amount, 300));
  ok("voided bill D is NOT a settlement", q1("SELECT COUNT(*) n FROM clinica_settlements WHERE bill_no='D'") === 0);

  // Same file again → nothing new (no double detection).
  cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 500, 200), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป")]), { today: "2026-10-06" });
  ok("re-importing the same file adds no duplicate settlements", nSettle() === 2);

  // Credit note: net drops with due → adjustment, not payment.
  cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 400, 100), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป")]), { today: "2026-10-07" });
  ok("net+due drop together (credit note) is not a settlement", nSettle() === 2);

  // An OLD export re-opens B (due back to 200), then a fresh import closes it again →
  // the same money must not be recorded twice.
  cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 400, 400), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป")]), { today: "2026-10-07" });
  cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 400, 100), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป")]), { today: "2026-10-07" });
  ok("old export re-opening a paid bill does not double-count the payment", nSettle() === 2 && near(q1("SELECT COALESCE(SUM(amount),0) n FROM clinica_settlements WHERE bill_no='B'"), 300));

  // ── Outstanding snapshot ──
  // Open now: B (100). Add E (insurer 800, 2026-09-10) and F (insurer 600, 2026-09-20) via a full import.
  cdb.importInvoice(branch, invParse([bill("A", "2026-08-01", 1000, 0), bill("B", "2026-08-02", 400, 100), bill("C", "2026-08-03", 400, 0, "ผู้ป่วยทั่วไป"), bill("E", "2026-09-10", 800, 800), bill("F", "2026-09-20", 600, 600)]), { today: "2026-10-08" });
  const before = q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch);
  // Snapshot lists only F (still owing 600) and B (100). E is absent and dated inside the span (B's date … F's date) → paid.
  const so = cdb.importOutstanding(branch, outParse([bill("B", "2026-08-02", 400, 100), bill("F", "2026-09-20", 600, 600)]), { today: "2026-10-09" });
  ok("snapshot never deletes bills (paid C still there)", q1("SELECT COUNT(*) n FROM clinica_bills WHERE branch_id=?", branch) === before && q1("SELECT COUNT(*) n FROM clinica_bills WHERE bill_no='C'") === 1);
  ok("snapshot: E absent inside span → settled in full (800), due 0", so.settlements === 1 && near((db.prepare("SELECT amount FROM clinica_settlements WHERE bill_no='E'").get() as { amount: number }).amount, 800) && near(q1("SELECT due n FROM clinica_bills WHERE bill_no='E'"), 0));
  ok("snapshot: E paid recomputed to net", near(q1("SELECT paid n FROM clinica_bills WHERE bill_no='E'"), 800));
  ok("snapshot: still-open F untouched", near(q1("SELECT due n FROM clinica_bills WHERE bill_no='F'"), 600));

  // Stale snapshot (old export) must not re-open E.
  cdb.importOutstanding(branch, outParse([bill("E", "2026-09-10", 800, 800), bill("F", "2026-09-20", 600, 600)]), { today: "2026-10-10" });
  ok("stale snapshot cannot raise a paid bill's due", near(q1("SELECT due n FROM clinica_bills WHERE bill_no='E'"), 0));

  // Snapshot inserts an unknown open bill and lowers a partly paid one.
  cdb.importOutstanding(branch, outParse([bill("G", "2026-09-25", 250, 250), bill("F", "2026-09-20", 600, 350)]), { today: "2026-10-11" });
  ok("snapshot inserts an unknown open bill with its items", q1("SELECT COUNT(*) n FROM clinica_bills WHERE bill_no='G'") === 1 && q1("SELECT COUNT(*) n FROM clinica_bill_items i JOIN clinica_bills b ON b.id=i.bill_id WHERE b.bill_no='G'") === 1);
  ok("snapshot lowers F 600→350 and records the 250 payment", near(q1("SELECT due n FROM clinica_bills WHERE bill_no='F'"), 350) && near((db.prepare("SELECT amount FROM clinica_settlements WHERE bill_no='F'").get() as { amount: number }).amount, 250));

  // Same-day payment is not a receivable settlement.
  cdb.importInvoice(branch, invParse([bill("H", "2026-10-12", 700, 700)]), { today: "2026-10-12" });
  const nBefore = nSettle();
  cdb.importInvoice(branch, invParse([bill("H", "2026-10-12", 700, 0)]), { today: "2026-10-12" });
  ok("bill paid on its own issue day → no settlement", nSettle() === nBefore);

  // ── Confirm / dismiss ──
  const pend = cdb.listSettlements(branch, "pending");
  const aRow = pend.find((x) => x.billNo === "A")!;
  ok("pending list carries a suggested bank channel for insurers", S.receiptChannelKind(aRow.suggestedChannel) === "bank");
  ok("confirm needs a channel", cdb.resolveSettlement(branch, aRow.id, null, { action: "confirm", settledDate: "2026-10-01", channel: "" }).error === "no_channel");
  ok("confirm rejects an impossible calendar date", cdb.resolveSettlement(branch, aRow.id, null, { action: "confirm", settledDate: "2026-13-45", channel: "x" }).error === "bad_date" && cdb.resolveSettlement(branch, aRow.id, null, { action: "confirm", settledDate: "2026-02-30", channel: "x" }).error === "bad_date");
  ok("confirm rejects a bad date", cdb.resolveSettlement(branch, aRow.id, null, { action: "confirm", settledDate: "1/10/2569", channel: "x" }).error === "bad_date");
  ok("confirm A with a corrected date + channel", cdb.resolveSettlement(branch, aRow.id, null, { action: "confirm", settledDate: "2026-10-01", channel: aRow.suggestedChannel }).ok === true);
  const aAfter = db.prepare("SELECT status, settled_date, channel FROM clinica_settlements WHERE id=?").get(aRow.id) as { status: string; settled_date: string; channel: string };
  ok("A confirmed with the edited date and channel", aAfter.status === "confirmed" && aAfter.settled_date === "2026-10-01" && aAfter.channel === aRow.suggestedChannel);
  ok("a confirmed row cannot be resolved again", cdb.resolveSettlement(branch, aRow.id, null, { action: "dismiss" }).error === "not_pending");
  const bRow = pend.find((x) => x.billNo === "B")!;
  ok("dismiss works", cdb.resolveSettlement(branch, bRow.id, null, { action: "dismiss" }).ok === true && q1("SELECT COUNT(*) n FROM clinica_settlements WHERE id=? AND status='dismissed'", bRow.id) === 1);
  ok("another branch cannot resolve it", cdb.resolveSettlement(999999, pend[pend.length - 1].id, null, { action: "dismiss" }).error === "not_found");
  ok("pending count drops accordingly", cdb.pendingSettlementCount(branch) === pend.length - 2);

  // The channel last confirmed for a payer group becomes its next default.
  const nextRow = cdb.listSettlements(branch, "pending").find((x) => x.payerGroup === "ประกันกลุ่ม เอ");
  ok("suggested channel follows the last confirmed one for that payer", nextRow?.suggestedChannel === aRow.suggestedChannel);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
