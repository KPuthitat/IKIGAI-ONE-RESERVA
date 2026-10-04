// CLINICA → ACCOUNTA income posting (owner 2026-10-04). A clinic branch whose
// income is posted from the imported HIS files rather than hand-keyed at shift
// close ("ภาระงานน้องๆ น้อยลง"):
//
//  • Sales = the Invoice Report, on the invoice date (accrual).
//  • How a bill was paid = the Receipt Report: cash / bank lines become income
//    rows by channel, one row per (day, channel).
//  • The part of a bill the payer owes (insurer / billed company) becomes a
//    receivable row per BILL under the payer group, open until its settlement is
//    CONFIRMED in ANALYTICA (clinica_settlements) — the confirmed date is the
//    cash-in date. Detected-but-unconfirmed payments stay open, so nothing
//    counts as cash before a person has checked the date.
//
// Posting is a REBUILD of source='clinic' rows for a date range (idempotent:
// re-run after every import / confirmation). Per day it supersedes the
// shift-close mirror (a day cannot carry both — that would double the sales),
// and replaceShiftCloseIncome leaves such days alone from then on.

import { getDb } from "./db";
import { createIncomeChannel, setIncomeChannelCredit } from "./accounta-db";
import { receiptChannelLabel } from "./clinica-shared";

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const UNKNOWN_PAYER = "ลูกหนี้ไม่ระบุกลุ่ม";

export function isClinicaAutopost(branchId: number): boolean {
  const r = getDb().prepare("SELECT clinica_autopost a FROM branches WHERE id = ?").get(branchId) as { a: number } | undefined;
  return r?.a === 1;
}

export function setClinicaAutopost(branchId: number, on: boolean): void {
  getDb().prepare("UPDATE branches SET clinica_autopost = ? WHERE id = ?").run(on ? 1 : 0, branchId);
}

export type ClinicaPostResult = {
  days: number; cashRows: number; receivableOpenRows: number; receivableSettledRows: number;
  /** Paid amount with no receipt to tell the channel — posted without a channel. */
  unknownChannelAmount: number;
  /** Shift-close income rows replaced because the clinic files now cover that day. */
  supersededShiftCloseDays: number;
  skippedNonPositive: number;
};

type BillRow = { bill_no: string; bill_date: string; payer_group: string | null; net: number; due: number };
type ReceiptRow = { bill_no: string; channel: string; paid: number };
type SettleRow = { id: number; bill_no: string; amount: number; status: "pending" | "confirmed" | "dismissed"; settled_date: string; channel: string | null };

/** Rebuild the branch's source='clinic' income rows for bills dated in [from, to]
 *  (inclusive; default everything). */
export function postClinicaToAccounta(branchId: number, userId: number, range: { from?: string; to?: string } = {}): ClinicaPostResult {
  const db = getDb();
  const from = range.from ?? "0000-01-01";
  const to = range.to ?? "9999-12-31";
  const companyId = (db.prepare("SELECT company_id c FROM branches WHERE id = ?").get(branchId) as { c: number | null } | undefined)?.c ?? null;

  const bills = db.prepare(
    `SELECT bill_no, bill_date, payer_group, net, due FROM clinica_bills
      WHERE branch_id = ? AND bill_date <> '' AND bill_date BETWEEN ? AND ? ORDER BY bill_date, bill_no`
  ).all(branchId, from, to) as BillRow[];

  // Receipts / settlements are read only for the bills in range (a one-day re-post
  // must not load the branch's whole history).
  const billsInRange = "SELECT bill_no FROM clinica_bills WHERE branch_id = ? AND bill_date <> '' AND bill_date BETWEEN ? AND ?";
  const receiptsByBill = new Map<string, ReceiptRow[]>();
  for (const r of db.prepare(
    `SELECT bill_no, channel, paid FROM clinica_receipts
      WHERE branch_id = ? AND paid > 0.005 AND bill_no IN (${billsInRange}) ORDER BY receipt_date, receipt_time, id`
  ).all(branchId, branchId, from, to) as ReceiptRow[]) {
    (receiptsByBill.get(r.bill_no) ?? receiptsByBill.set(r.bill_no, []).get(r.bill_no)!).push(r);
  }
  const settleByBill = new Map<string, SettleRow[]>();
  for (const s of db.prepare(
    `SELECT id, bill_no, amount, status, settled_date, channel FROM clinica_settlements
      WHERE branch_id = ? AND bill_no IN (${billsInRange}) ORDER BY id`
  ).all(branchId, branchId, from, to) as SettleRow[]) {
    (settleByBill.get(s.bill_no) ?? settleByBill.set(s.bill_no, []).get(s.bill_no)!).push(s);
  }

  type Row = { date: string; channel: string | null; amount: number; note: string; outstanding: boolean; settled: string | null; ref: string; credit: boolean };
  const rows: Row[] = [];
  const cash = new Map<string, { date: string; channel: string | null; amount: number; n: number }>();
  let unknownChannelAmount = 0, skipped = 0, settledRows = 0, openRows = 0;
  const addCash = (date: string, channel: string | null, amount: number) => {
    const k = `${date}|${channel ?? ""}`;
    const e = cash.get(k) ?? { date, channel, amount: 0, n: 0 };
    e.amount += amount; e.n++; cash.set(k, e);
  };

  for (const b of bills) {
    const N = r2(b.net);
    if (N <= 0.005) { skipped++; continue; }
    const sets = settleByBill.get(b.bill_no) ?? [];
    const confirmed = sets.filter((s) => s.status === "confirmed");
    const pending = r2(sets.filter((s) => s.status === "pending").reduce((t, s) => t + s.amount, 0));
    const dismissed = r2(sets.filter((s) => s.status === "dismissed").reduce((t, s) => t + s.amount, 0));
    const rcp = receiptsByBill.get(b.bill_no) ?? [];
    const rcpPaid = r2(rcp.reduce((t, x) => t + x.paid, 0));
    // Amount that was ever booked as owed by the payer: still open + paid later
    // (confirmed or awaiting confirmation). The rest was paid at the counter.
    let owed = Math.min(N, Math.max(0, r2(b.due + confirmed.reduce((t, s) => t + s.amount, 0) + pending)));
    let immediate = r2(N - owed);
    // A DISMISSED drop ("not a payment", e.g. the bill left the outstanding report
    // for another reason) must never become same-day cash — nobody confirmed any
    // money. If receipts cannot account for the paid part, it stays owed.
    if (dismissed > 0.005 && immediate > rcpPaid + 0.005) {
      const extra = Math.min(dismissed, r2(immediate - rcpPaid));
      owed = r2(owed + extra); immediate = r2(immediate - extra);
    }

    for (const rc of rcp) {
      if (immediate <= 0.005) break;
      const take = Math.min(immediate, rc.paid);
      addCash(b.bill_date, receiptChannelLabel(rc.channel) || null, take);
      immediate = r2(immediate - take);
    }
    if (immediate > 0.005) { addCash(b.bill_date, null, immediate); unknownChannelAmount += immediate; }

    const payer = (b.payer_group ?? "").trim() || UNKNOWN_PAYER;
    let settledSum = 0;
    for (const s of confirmed) {
      const amt = Math.min(s.amount, r2(owed - settledSum));
      if (amt <= 0.005) continue;
      settledSum = r2(settledSum + amt);
      rows.push({
        date: b.bill_date, channel: payer, amount: amt, outstanding: true, settled: s.settled_date, credit: true,
        ref: `${b.bill_no}#s${s.id}`,
        note: `บิล ${b.bill_no} · รับชำระ ${s.settled_date}${s.channel ? ` · เข้า ${receiptChannelLabel(s.channel)}` : ""}`
      });
      settledRows++;
    }
    const open = r2(owed - settledSum);
    if (open > 0.005) {
      rows.push({
        date: b.bill_date, channel: payer, amount: open, outstanding: true, settled: null, credit: true,
        ref: `${b.bill_no}#open`,
        note: `บิล ${b.bill_no} · ค้างรับ (ยืนยันการรับชำระที่ ANALYTICA › คลินิก)`
      });
      openRows++;
    }
  }
  for (const c of cash.values()) {
    const amt = r2(c.amount);
    if (amt <= 0.005) { skipped++; continue; }
    rows.push({
      date: c.date, channel: c.channel, amount: amt, outstanding: false, settled: null, credit: false,
      ref: `cash:${c.date}:${c.channel ?? ""}`,
      note: `จากไฟล์ HIS (ใบแจ้งหนี้+ใบเสร็จ)${c.channel ? ` · ${c.channel}` : " · ไม่ทราบช่องทาง"} · ${c.n} บิล`
    });
  }

  const dates = new Set(rows.map((r) => r.date));
  let superseded = 0;
  db.transaction(() => {
    db.prepare("DELETE FROM accounta_income WHERE branch_id = ? AND source = 'clinic' AND income_date BETWEEN ? AND ?").run(branchId, from, to);
    const delClose = db.prepare("DELETE FROM accounta_income WHERE branch_id = ? AND source = 'shift_close' AND income_date = ?");
    for (const d of dates) if (delClose.run(branchId, d).changes > 0) superseded++;
    // Register channels so they show in the daybook picklists; payer groups are credit entities.
    // An existing channel (even one the owner deactivated or un-flagged) is left exactly
    // as it is — only brand-new names are created, and payer groups flagged credit.
    const seen = new Set<string>();
    const hasChannel = db.prepare("SELECT 1 FROM accounta_income_channels WHERE branch_id = ? AND name = ? COLLATE NOCASE");
    for (const r of rows) {
      if (!r.channel || seen.has(r.channel)) continue;
      seen.add(r.channel);
      if (hasChannel.get(branchId, r.channel)) continue;
      const id = createIncomeChannel({ name: r.channel, branchId, showOnClose: false });
      if (r.credit) setIncomeChannelCredit(id, branchId, true);
    }
    const ins = db.prepare(
      `INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, created_by, source, is_outstanding, settled_date, ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'clinic', ?, ?, ?)`
    );
    for (const r of rows) ins.run(branchId, companyId, r.date, r.channel, r.amount, r.note, userId, r.outstanding ? 1 : 0, r.settled, r.ref);
  })();

  return {
    days: dates.size, cashRows: rows.filter((r) => !r.outstanding).length,
    receivableOpenRows: openRows, receivableSettledRows: settledRows,
    unknownChannelAmount: r2(unknownChannelAmount), supersededShiftCloseDays: superseded, skippedNonPositive: skipped
  };
}

/** Re-post when the branch has the switch on. Never throws — an ACCOUNTA problem
 *  must not fail the import that triggered it. */
export function autopostClinicaIfEnabled(branchId: number, userId: number, range: { from?: string; to?: string } = {}): { posted: ClinicaPostResult | null; error?: string } {
  try {
    if (!isClinicaAutopost(branchId)) return { posted: null };
    return { posted: postClinicaToAccounta(branchId, userId, range) };
  } catch (e) {
    return { posted: null, error: (e as Error).message };
  }
}

export type ClinicaPostStatus = {
  enabled: boolean;
  postedDays: number; firstDate: string | null; lastDate: string | null;
  openReceivable: number; openReceivableCount: number;
};

export function clinicaPostStatus(branchId: number): ClinicaPostStatus {
  const db = getDb();
  const agg = db.prepare(
    `SELECT COUNT(DISTINCT income_date) days, MIN(income_date) f, MAX(income_date) l FROM accounta_income WHERE branch_id = ? AND source = 'clinic'`
  ).get(branchId) as { days: number; f: string | null; l: string | null };
  const open = db.prepare(
    `SELECT COALESCE(SUM(amount),0) a, COUNT(*) n FROM accounta_income WHERE branch_id = ? AND source = 'clinic' AND is_outstanding = 1 AND settled_date IS NULL`
  ).get(branchId) as { a: number; n: number };
  return { enabled: isClinicaAutopost(branchId), postedDays: agg.days, firstDate: agg.f, lastDate: agg.l, openReceivable: r2(open.a), openReceivableCount: open.n };
}
