// CLINICA store (owner 2026-09-26). Imports the parsed HIS reports at line-item
// grain, so ANALYTICA can aggregate by day/month/any range. Import is
// range-based: the file's own rows span [minDate..maxDate], and importing
// REPLACES exactly that span for the branch, then inserts the file's rows. So a
// bill/visit voided WITHIN the covered span disappears on re-import, and the
// owner can export daily, monthly or any window and overwrite. (Caveat: a bill
// voided on the very LAST covered day, with no other bill that day, shrinks the
// span — re-export a window that still reaches that day to clear it.)

import { getDb } from "./db";
import { todayBkk } from "./time";
import type { ClinicaInvoiceParse, ClinicaOpdParse, ClinicaOutstandingParse, ClinicaReceiptParse } from "./clinica-parse";
import { receiptChannelKind, receiptChannelLabel } from "./clinica-shared";

export type ClinicaImportResult = {
  kind: "invoice" | "outstanding" | "receipt" | "opd";
  receipts?: number;
  /** Late payments of receivables this import noticed (awaiting confirmation). */
  settlements?: number;
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
export function importInvoice(branchId: number, p: ClinicaInvoiceParse, opts: { today?: string } = {}): ClinicaImportResult {
  const db = getDb();
  const today = opts.today ?? todayBkk();
  const before = openBills(branchId);
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
  let settlements = 0;
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
    settlements = detectSettlements(branchId, before, "invoice", today);
  })();
  return { kind: "invoice", rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, bills: p.bills.length, items, settlements, totalNet: p.totalNet, totalDue: p.totalDue };
}


// ── Receivable settlement detection (owner 2026-10-04) ───────────────────────
// Insurer / billed-company bills stay open for weeks and are paid later, but the
// HIS back-dates the receipt to the service day — so a receipt's date cannot say
// when the money really arrived. Instead every import compares the bills that
// were OPEN before it with what the file now says: an outstanding amount that
// dropped means someone paid. The import day is the default settlement date; a
// person confirms (or edits) it before it counts anywhere. A bill that merely
// disappears from a full Invoice import is a void, not a payment → ignored.

type OpenBill = { billNo: string; billDate: string; payerGroup: string; net: number; due: number };

function openBills(branchId: number): Map<string, OpenBill> {
  const m = new Map<string, OpenBill>();
  for (const r of getDb().prepare(
    "SELECT bill_no, bill_date, COALESCE(payer_group,'') payer_group, net, due FROM clinica_bills WHERE branch_id = ? AND due > 0.005"
  ).all(branchId) as Array<{ bill_no: string; bill_date: string; payer_group: string; net: number; due: number }>) {
    m.set(r.bill_no, { billNo: r.bill_no, billDate: r.bill_date, payerGroup: r.payer_group, net: r.net, due: r.due });
  }
  return m;
}

/** Compare the bills open BEFORE an import with the current table; record a
 *  pending settlement for each outstanding drop. A drop that comes with an equal
 *  drop in the bill's net is an adjustment (credit note), not a payment. A bill
 *  paid on the very day it was issued is same-day cash, never a receivable. */
function detectSettlements(branchId: number, before: Map<string, OpenBill>, source: "invoice" | "outstanding", today: string): number {
  if (before.size === 0) return 0;
  const db = getDb();
  const get = db.prepare("SELECT net, due FROM clinica_bills WHERE branch_id = ? AND bill_no = ?");
  const recorded = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM clinica_settlements WHERE branch_id = ? AND bill_no = ? AND status <> 'dismissed'");
  const ins = db.prepare(
    `INSERT INTO clinica_settlements (branch_id, bill_no, bill_date, payer_group, amount, detected_on, settled_date, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let n = 0;
  for (const b of before.values()) {
    const now = get.get(branchId, b.billNo) as { net: number; due: number } | undefined;
    if (!now) continue;
    let amount = r2(b.due - now.due - Math.max(0, b.net - now.net));
    if (amount <= 0.005 || b.billDate === today) continue;
    // Never record more than the bill has actually been paid in total: an older
    // export that re-opens a paid bill, followed by a fresh import that closes it
    // again, must not count the same money twice.
    const room = r2((now.net - now.due) - (recorded.get(branchId, b.billNo) as { s: number }).s);
    amount = Math.min(amount, room);
    if (amount <= 0.005) continue;
    ins.run(branchId, b.billNo, b.billDate, b.payerGroup, amount, today, today, source);
    n++;
  }
  return n;
}

/** Snapshot import of the outstanding-only Invoice Report. NEVER range-replaces:
 *  the span holds paid bills this file does not list. Bills it lists are inserted
 *  (if new) or have their outstanding amount lowered (never raised, so a stale
 *  export cannot re-open a paid bill). An open bill dated inside the file's span
 *  but absent from it has been paid in full. The span is only what the listed
 *  bills cover, so a paid bill older than the oldest still-open one is not caught
 *  here — the next full Invoice import (authoritative) records it. */
export function importOutstanding(branchId: number, p: ClinicaOutstandingParse, opts: { today?: string } = {}): ClinicaImportResult {
  const db = getDb();
  const today = opts.today ?? todayBkk();
  const before = openBills(branchId);
  const exists = db.prepare("SELECT id, due FROM clinica_bills WHERE branch_id = ? AND bill_no = ?");
  const lower = db.prepare("UPDATE clinica_bills SET due = ?, paid = ROUND(net - ?, 2) WHERE id = ?");
  const insBill = db.prepare(
    `INSERT INTO clinica_bills (branch_id, bill_no, bill_date, bill_time, hn, payer_group, staff, gross, bill_discount, net, paid, due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insItem = db.prepare(
    `INSERT INTO clinica_bill_items (bill_id, code, name, qty, unit, line_gross, line_discount, line_net)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const closeBill = db.prepare("UPDATE clinica_bills SET paid = ROUND(paid + due, 2), due = 0 WHERE branch_id = ? AND bill_no = ?");
  const inFile = new Set(p.bills.map((b) => b.billNo));
  let items = 0;
  let settlements = 0;
  db.transaction(() => {
    for (const b of p.bills) {
      const row = exists.get(branchId, b.billNo) as { id: number; due: number } | undefined;
      if (row) {
        if (b.due < row.due - 0.005) lower.run(b.due, b.due, row.id);
        continue;
      }
      const billId = Number(insBill.run(
        branchId, b.billNo, b.date, b.time, b.hn, b.payerGroup, b.staff, b.gross, b.billDiscount, b.net, b.paid, b.due
      ).lastInsertRowid);
      for (const it of b.items) {
        insItem.run(billId, it.code, it.name, it.qty, it.unit, it.lineGross, it.lineDiscount, it.lineNet);
        items++;
      }
    }
    // Open before, dated inside the file's span, not listed any more → paid.
    if (p.rangeStart && p.rangeEnd) {
      for (const b of before.values()) {
        if (inFile.has(b.billNo) || !b.billDate || b.billDate < p.rangeStart || b.billDate > p.rangeEnd) continue;
        closeBill.run(branchId, b.billNo);
      }
    }
    settlements = detectSettlements(branchId, before, "outstanding", today);
  })();
  return { kind: "outstanding", rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, bills: p.bills.length, items, settlements, totalNet: p.totalNet, totalDue: p.totalDue };
}

/** Replace every receipt payment line in the file's date range, then insert the
 *  file's. A re-import of the same window overwrites; other days are untouched. */
export function importReceipt(branchId: number, p: ClinicaReceiptParse): ClinicaImportResult {
  const db = getDb();
  const delRange = db.prepare("DELETE FROM clinica_receipts WHERE branch_id = ? AND receipt_date BETWEEN ? AND ?");
  const delOne = db.prepare("DELETE FROM clinica_receipts WHERE branch_id = ? AND receipt_no = ?");
  const ins = db.prepare(
    `INSERT INTO clinica_receipts (branch_id, receipt_no, installment, bill_no, receipt_date, receipt_time, hn, payer_group, channel, paid, fee, outstanding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    if (p.rangeStart && p.rangeEnd) delRange.run(branchId, p.rangeStart, p.rangeEnd);
    for (const r of p.receipts) {
      delOne.run(branchId, r.receiptNo);
      const used = new Set<number>();
      for (const pay of r.payments) {
        let inst = pay.installment;
        while (used.has(inst)) inst++;      // keep UNIQUE(receipt, installment) even if the export repeats a number
        used.add(inst);
        ins.run(branchId, r.receiptNo, inst, r.billNo, r.date, r.time, r.hn, r.payerGroup, pay.channel, pay.paid, pay.fee, pay.outstanding);
      }
    }
  })();
  return { kind: "receipt", rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, receipts: p.receipts.length };
}

export type ClinicaSettlement = {
  id: number; billNo: string; billDate: string; payerGroup: string; amount: number;
  detectedOn: string; settledDate: string; channel: string; status: "pending" | "confirmed" | "dismissed";
  /** Suggested landing channel when none is set yet (last one used for this payer group). */
  suggestedChannel: string;
};

type SettlementRow = { id: number; bill_no: string; bill_date: string; payer_group: string | null; amount: number; detected_on: string; settled_date: string; channel: string | null; status: "pending" | "confirmed" | "dismissed" };

/** Channels money can land in, from the receipts already imported: every channel
 *  that has taken money, cash first. 'อื่นๆ' receivable lines carry no money. */
export function clinicaCashChannels(branchId: number): string[] {
  const rows = getDb().prepare(
    `SELECT channel, COUNT(*) n FROM clinica_receipts WHERE branch_id = ? AND paid > 0 GROUP BY channel ORDER BY n DESC`
  ).all(branchId) as Array<{ channel: string; n: number }>;
  const out = rows.map((r) => r.channel);
  const ordered = out.filter((c) => receiptChannelKind(c) === "cash").concat(out.filter((c) => receiptChannelKind(c) !== "cash"));
  return ordered.length ? ordered : ["เงินสด (เงินสด)"];
}

export function listSettlements(branchId: number, status: "pending" | "confirmed" | "dismissed" = "pending", limit = 200): ClinicaSettlement[] {
  const db = getDb();
  const channels = clinicaCashChannels(branchId);
  const bankDefault = channels.find((c) => receiptChannelKind(c) === "bank") ?? channels[0];
  const lastFor = db.prepare(
    `SELECT channel FROM clinica_settlements WHERE branch_id = ? AND payer_group = ? AND status = 'confirmed' AND COALESCE(channel,'') <> '' ORDER BY confirmed_at DESC, id DESC LIMIT 1`
  );
  const rows = db.prepare(
    `SELECT id, bill_no, bill_date, payer_group, amount, detected_on, settled_date, channel, status
       FROM clinica_settlements WHERE branch_id = ? AND status = ? ORDER BY settled_date DESC, id DESC LIMIT ?`
  ).all(branchId, status, limit) as SettlementRow[];
  return rows.map((r) => {
    const grp = r.payer_group ?? "";
    const last = grp ? (lastFor.get(branchId, grp) as { channel: string } | undefined)?.channel : undefined;
    return {
      id: r.id, billNo: r.bill_no, billDate: r.bill_date, payerGroup: grp, amount: r.amount,
      detectedOn: r.detected_on, settledDate: r.settled_date, channel: r.channel ?? "", status: r.status,
      // Insurers/companies pay by transfer; cash is a poor default for a late payment.
      suggestedChannel: last ?? bankDefault
    };
  });
}

export type SettlementAction =
  | { action: "confirm"; settledDate: string; channel: string }
  | { action: "dismiss" };

/** Confirm (with the real date + landing channel) or dismiss a pending
 *  settlement. Only a pending row of THIS branch can change. */
export function resolveSettlement(branchId: number, id: number, userId: number | null, a: SettlementAction): { ok: boolean; error?: string } {
  const db = getDb();
  const row = db.prepare("SELECT status FROM clinica_settlements WHERE id = ? AND branch_id = ?").get(id, branchId) as { status: string } | undefined;
  if (!row) return { ok: false, error: "not_found" };
  if (row.status !== "pending") return { ok: false, error: "not_pending" };
  if (a.action === "dismiss") {
    db.prepare("UPDATE clinica_settlements SET status='dismissed', confirmed_by=?, confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(userId, id);
    return { ok: true };
  }
  const d = /^\d{4}-\d{2}-\d{2}$/.test(a.settledDate) ? new Date(`${a.settledDate}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== a.settledDate) return { ok: false, error: "bad_date" };
  const channel = (a.channel ?? "").trim().slice(0, 120);
  if (!channel) return { ok: false, error: "no_channel" };
  db.prepare(
    "UPDATE clinica_settlements SET status='confirmed', settled_date=?, channel=?, confirmed_by=?, confirmed_at=CURRENT_TIMESTAMP WHERE id=?"
  ).run(a.settledDate, channel, userId, id);
  return { ok: true };
}

export function pendingSettlementCount(branchId: number): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM clinica_settlements WHERE branch_id = ? AND status = 'pending'").get(branchId) as { n: number }).n;
}

/** Cash-in by channel for a period from the RECEIPT file: what was taken through
 *  each channel on receipts dated in the period. The part of a receipt booked as
 *  receivable (insurer share, ยอดค้างชำระ) is reported on its own row — it is not
 *  money in yet. */
export type ChannelMixRow = { channel: string; label: string; kind: "cash" | "bank" | "receivable"; amount: number; count: number };
export function clinicaChannelMix(branchId: number, startIso: string, endIso: string): ChannelMixRow[] {
  const rows = getDb().prepare(
    `SELECT channel, ROUND(SUM(paid),2) paid, ROUND(SUM(outstanding),2) outst,
            SUM(CASE WHEN ABS(paid) > 0.005 THEN 1 ELSE 0 END) np, SUM(CASE WHEN ABS(outstanding) > 0.005 THEN 1 ELSE 0 END) no
       FROM clinica_receipts WHERE branch_id = ? AND receipt_date BETWEEN ? AND ? GROUP BY channel`
  ).all(branchId, startIso, endIso) as Array<{ channel: string; paid: number; outst: number; np: number; no: number }>;
  const out: ChannelMixRow[] = [];
  for (const r of rows) {
    const label = receiptChannelLabel(r.channel);
    if (Math.abs(r.paid) >= 0.005) out.push({ channel: r.channel, label, kind: receiptChannelKind(r.channel) === "cash" ? "cash" : "bank", amount: r.paid, count: r.np });
    if (Math.abs(r.outst) >= 0.005) out.push({ channel: r.channel, label, kind: "receivable", amount: r.outst, count: r.no });
  }
  const order = { cash: 0, bank: 1, receivable: 2 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind] || b.amount - a.amount);
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

/** Per-DAY billed net for a clinic branch over an inclusive ISO range (for the
 *  forward-plan baseline). */
export function clinicaDailyNetRange(branchId: number, startIso: string, endIso: string): Array<{ date: string; net: number }> {
  return getDb().prepare(
    `SELECT bill_date date, ROUND(SUM(net),2) net FROM clinica_bills
       WHERE branch_id=? AND bill_date BETWEEN ? AND ? AND bill_date<>'' GROUP BY bill_date`
  ).all(branchId, startIso, endIso) as Array<{ date: string; net: number }>;
}

/** Per-DAY billed net for a clinic branch in a year (for the full-year daily bars). */
export function clinicaDailyNet(branchId: number, year: number): Array<{ date: string; net: number }> {
  return getDb().prepare(
    `SELECT bill_date date, ROUND(SUM(net),2) net FROM clinica_bills
       WHERE substr(bill_date,1,4)=? AND branch_id=? AND bill_date<>'' GROUP BY bill_date`
  ).all(String(year), branchId) as Array<{ date: string; net: number }>;
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
