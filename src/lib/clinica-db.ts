// CLINICA store (owner 2026-09-26). Imports the parsed HIS reports at line-item
// grain, so ANALYTICA can aggregate by day/month/any range. Import is
// range-based: the file's own rows span [minDate..maxDate], and importing
// REPLACES exactly that span for the branch, then inserts the file's rows. So a
// bill/visit voided WITHIN the covered span disappears on re-import, and the
// owner can export daily, monthly or any window and overwrite. (Caveat: a bill
// voided on the very LAST covered day, with no other bill that day, shrinks the
// span — re-export a window that still reaches that day to clear it.)

import { getDb } from "./db";
import type { ClinicaInvoiceParse, ClinicaOpdParse } from "./clinica-parse";

export type ClinicaImportResult = {
  kind: "invoice" | "opd";
  rangeStart: string;
  rangeEnd: string;
  bills?: number;
  items?: number;
  visits?: number;
  totalNet?: number;
  totalDue?: number;
};

/** Replace every bill in the file's date range, then insert the file's bills +
 *  items. A per-bill_no delete also covers a re-import whose bill lies outside
 *  the deleted range (e.g. an unparseable date). */
export function importInvoice(branchId: number, p: ClinicaInvoiceParse): ClinicaImportResult {
  const db = getDb();
  const delRange = db.prepare("DELETE FROM clinica_bills WHERE branch_id = ? AND bill_date BETWEEN ? AND ?");
  const delOne = db.prepare("DELETE FROM clinica_bills WHERE branch_id = ? AND bill_no = ?");
  const insBill = db.prepare(
    `INSERT INTO clinica_bills (branch_id, bill_no, bill_date, bill_time, hn, payer_group, staff, gross, bill_discount, net, paid, due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(
    `INSERT INTO clinica_bill_items (bill_id, code, name, qty, unit, line_gross, line_discount, line_net)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let items = 0;
  db.transaction(() => {
    if (p.rangeStart && p.rangeEnd) delRange.run(branchId, p.rangeStart, p.rangeEnd);
    for (const b of p.bills) {
      delOne.run(branchId, b.billNo);   // clears a prior copy (cascades its items)
      const billId = Number(insBill.run(
        branchId, b.billNo, b.date, b.time, b.hn, b.payerGroup, b.staff,
        b.gross, b.billDiscount, b.net, b.paid, b.due
      ).lastInsertRowid);
      for (const it of b.items) {
        insItem.run(billId, it.code, it.name, it.qty, it.unit, it.lineGross, it.lineDiscount, it.lineNet);
        items++;
      }
    }
  })();
  return { kind: "invoice", rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, bills: p.bills.length, items, totalNet: p.totalNet, totalDue: p.totalDue };
}

/** Replace every visit in the file's date range, then insert the file's visits. */
export function importOpd(branchId: number, p: ClinicaOpdParse): ClinicaImportResult {
  const db = getDb();
  const delRange = db.prepare("DELETE FROM clinica_visits WHERE branch_id = ? AND visit_date BETWEEN ? AND ?");
  const delOne = db.prepare("DELETE FROM clinica_visits WHERE branch_id = ? AND visit_no = ? AND dx_code = ?");
  const ins = db.prepare(
    `INSERT INTO clinica_visits (branch_id, visit_no, visit_date, visit_time, hn, gender, birth_date, doctor, dx_code, dx_th, dx_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    if (p.rangeStart && p.rangeEnd) delRange.run(branchId, p.rangeStart, p.rangeEnd);
    for (const v of p.visits) {
      delOne.run(branchId, v.visitNo, v.dxCode);
      ins.run(branchId, v.visitNo, v.date, v.time, v.hn, v.gender, v.birthDate, v.doctor, v.dxCode, v.dxTh, v.dxEn);
    }
  })();
  return { kind: "opd", rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, visits: p.visits.length };
}

/** True when a branch has any imported clinic data (drives the ANALYTICA clinic
 *  section visibility). */
export function isClinicaBranch(branchId: number): boolean {
  const db = getDb();
  const b = db.prepare("SELECT 1 FROM clinica_bills WHERE branch_id = ? LIMIT 1").get(branchId);
  const v = db.prepare("SELECT 1 FROM clinica_visits WHERE branch_id = ? LIMIT 1").get(branchId);
  return !!b || !!v;
}

/** Earliest/latest imported dates for a branch (for an "imported through" note). */
export function clinicaImportedRange(branchId: number): { billsFrom: string | null; billsTo: string | null; visitsFrom: string | null; visitsTo: string | null } {
  const db = getDb();
  const b = db.prepare("SELECT MIN(NULLIF(bill_date,'')) AS f, MAX(bill_date) AS t FROM clinica_bills WHERE branch_id = ?").get(branchId) as { f: string | null; t: string | null };
  const v = db.prepare("SELECT MIN(NULLIF(visit_date,'')) AS f, MAX(visit_date) AS t FROM clinica_visits WHERE branch_id = ?").get(branchId) as { f: string | null; t: string | null };
  return { billsFrom: b.f, billsTo: b.t || null, visitsFrom: v.f, visitsTo: v.t || null };
}
