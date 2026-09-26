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
  const r = getDb().prepare(
    `SELECT (EXISTS(SELECT 1 FROM clinica_bills WHERE branch_id = ?)
          OR EXISTS(SELECT 1 FROM clinica_visits WHERE branch_id = ?)) AS has`
  ).get(branchId, branchId) as { has: number };
  return r.has === 1;
}

// ── Company / annual roll-up support (owner 2026-09-27) ──────────────────────
// A clinic's realised revenue lives in clinica_bills, not salesa_daily, so the
// company overview and the annual view (which read POS) showed the clinic as
// ฿0. These helpers expose the clinic's billed net so ANALYTICA can fold a clinic
// branch in beside the restaurants ("ภาพรวม/รายปีก็ต้องขึ้น เลียนแบบให้หมด").
function r2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

/** Billed net + bill/patient counts for a branch over an inclusive ISO range. */
export function clinicaRangeAgg(branchId: number, startIso: string, endIso: string): { nett: number; bills: number; pax: number; days: number } {
  const r = getDb().prepare(
    `SELECT COALESCE(SUM(net),0) nett, COUNT(*) bills, COUNT(DISTINCT NULLIF(hn,'')) pax,
            COUNT(DISTINCT CASE WHEN bill_date<>'' THEN bill_date END) days
       FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ?`
  ).get(branchId, startIso, endIso) as { nett: number; bills: number; pax: number; days: number };
  return { nett: r2(r.nett), bills: r.bills, pax: r.pax, days: r.days };
}

/** Latest day-of-month (1..31) any clinic bill was dated in a month across the
 *  given branches — 0 if none. Lets the company throughDay window reach clinic
 *  data even when the company has no POS branch. */
export function clinicaMaxBillDayInMonth(branchIds: number[], year: number, month: number): number {
  if (!branchIds.length) return 0;
  const mm = String(month).padStart(2, "0");
  const r = getDb().prepare(
    `SELECT MAX(bill_date) d FROM clinica_bills WHERE substr(bill_date,1,7)=? AND branch_id IN (${branchIds.map(() => "?").join(",")})`
  ).get(`${year}-${mm}`, ...branchIds) as { d: string | null } | undefined;
  return r?.d ? Number(r.d.slice(8, 10)) : 0;
}

/** Clinic branches (id+name+order) with any positive-net bill in a year. */
export function clinicaBranchesWithBillsInYear(year: number, allowed?: number[] | null): Array<{ id: number; name: string; ord: number }> {
  let rows = getDb().prepare(
    `SELECT DISTINCT c.branch_id id, b.name name, b.display_order ord
       FROM clinica_bills c JOIN branches b ON b.id=c.branch_id
       WHERE substr(c.bill_date,1,4)=? AND c.net>0`
  ).all(String(year)) as Array<{ id: number; name: string; ord: number }>;
  if (allowed && allowed.length) { const s = new Set(allowed); rows = rows.filter((r) => s.has(r.id)); }
  return rows;
}

/** Per-month billed net for a clinic branch in a year (index 0=Jan … 11=Dec). */
export function clinicaMonthlyNet(branchId: number, year: number): number[] {
  const out = new Array(12).fill(0) as number[];
  // Sum ALL bills (incl. any refund/negative rows) so a month's figure matches
  // clinicaRangeAgg used by the company overview — no net>0 filter here.
  for (const r of getDb().prepare(
    `SELECT substr(bill_date,6,2) m, SUM(net) n FROM clinica_bills
       WHERE substr(bill_date,1,4)=? AND branch_id=? AND bill_date<>'' GROUP BY m`
  ).all(String(year), branchId) as Array<{ m: string; n: number }>) {
    const idx = Number(r.m) - 1;
    if (idx >= 0 && idx < 12) out[idx] = r2(r.n);
  }
  return out;
}

/** Clinic YTD billed net + a straight-line month-end projection (run-rate from
 *  the first bill of the year to today), matching the POS branchYtdProjection. */
export function clinicaYtdProjection(branchId: number, todayIso: string): { ytd: number; projected: number } {
  const y = Number(todayIso.slice(0, 4));
  const agg = clinicaRangeAgg(branchId, `${y}-01-01`, todayIso);
  if (agg.bills === 0) return { ytd: 0, projected: 0 };
  const first = (getDb().prepare(
    `SELECT MIN(bill_date) d FROM clinica_bills WHERE branch_id=? AND bill_date BETWEEN ? AND ? AND bill_date<>''`
  ).get(branchId, `${y}-01-01`, todayIso) as { d: string | null }).d ?? `${y}-01-01`;
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
  const spanDays = Math.max(1, day(todayIso) - day(first) + 1);
  const dailyRate = agg.nett / spanDays;
  const remaining = Math.max(0, day(`${y}-12-31`) - day(todayIso));
  return { ytd: r2(agg.nett), projected: r2(agg.nett + dailyRate * remaining) };
}

/** Earliest/latest imported dates for a branch (for an "imported through" note). */
export function clinicaImportedRange(branchId: number): { billsFrom: string | null; billsTo: string | null; visitsFrom: string | null; visitsTo: string | null } {
  const db = getDb();
  const b = db.prepare("SELECT MIN(NULLIF(bill_date,'')) AS f, MAX(bill_date) AS t FROM clinica_bills WHERE branch_id = ?").get(branchId) as { f: string | null; t: string | null };
  const v = db.prepare("SELECT MIN(NULLIF(visit_date,'')) AS f, MAX(visit_date) AS t FROM clinica_visits WHERE branch_id = ?").get(branchId) as { f: string | null; t: string | null };
  return { billsFrom: b.f, billsTo: b.t || null, visitsFrom: v.f, visitsTo: v.t || null };
}
