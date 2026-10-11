// เงินช่วยเหลือพิเศษ และ เบิกเงินล่วงหน้า (owner 2026-10-11).
//
//  • aid     — a grant paid outside the payroll run (e.g. flood relief 2,000). It is added to
//              that month's income, taxed with the wages (3% for withholding-tax staff, none
//              for social-security staff), and because the cash already left, the amount is
//              netted off the transfer on payday.
//  • advance — an early draw of pay already earned this month. Capped at what the person has
//              actually earned so far (minus earlier draws). The month's tax is still worked
//              out on the FULL pay; the draw is only netted off the transfer.
//
// Both live in the staff_special_payments ledger (never deleted, only voided with a reason)
// and are folded into the payroll line AFTER every build/recompute, so the payroll engine
// itself is untouched. A line is only touched while its period is a draft and the line is
// not yet marked reviewed.

import type Database from "better-sqlite3";
import { getDb } from "./db";
import { loadPayrollSettings, pairShifts } from "./payroll-compute";
import { bkkDateIso } from "./time";

export type PaymentKind = "aid" | "advance";
export type PaymentErrorCode =
  | "user_invalid" | "user_not_active" | "amount_invalid" | "reason_required" | "date_invalid" | "date_in_future"
  | "period_finalized" | "line_reviewed" | "advance_not_available" | "advance_exceeds_limit" | "not_found" | "already_voided";

export class PaymentError extends Error {
  constructor(public code: PaymentErrorCode, public detail?: { available?: number }) { super(code); }
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const todayBkk = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const isIso = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export type SpecialPayment = {
  id: number; userId: number; userName: string; kind: PaymentKind; paidOn: string; amount: number; reason: string;
  createdBy: number; createdAt: string; voidedAt: string | null; voidReason: string | null;
};

type Row = { id: number; user_id: number; name: string; kind: PaymentKind; paid_on: string; amount: number; reason: string;
  created_by: number; created_at: string; voided_at: string | null; void_reason: string | null };

const toPayment = (r: Row): SpecialPayment => ({
  id: r.id, userId: r.user_id, userName: r.name, kind: r.kind, paidOn: r.paid_on, amount: r.amount, reason: r.reason,
  createdBy: r.created_by, createdAt: r.created_at, voidedAt: r.voided_at, voidReason: r.void_reason
});

export function listPayments(filter: { yearMonth?: string; userId?: number } = {}): SpecialPayment[] {
  const where: string[] = []; const args: Array<string | number> = [];
  if (filter.yearMonth) { where.push("substr(p.paid_on, 1, 7) = ?"); args.push(filter.yearMonth); }
  if (filter.userId) { where.push("p.user_id = ?"); args.push(filter.userId); }
  return (getDb().prepare(`
    SELECT p.id, p.user_id, COALESCE(u.display_name, '') AS name, p.kind, p.paid_on, p.amount, p.reason,
           p.created_by, p.created_at, p.voided_at, p.void_reason
      FROM staff_special_payments p JOIN users u ON u.id = p.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY p.paid_on DESC, p.id DESC
  `).all(...args) as Row[]).map(toPayment);
}

// ── advance limit ───────────────────────────────────────────────────────────

export type AdvanceLimit = { earned: number; taken: number; available: number; basis: "salary" | "hourly" | "none"; workedDays: number };

/** What a person may still draw on `paidOn`: pay earned from the 1st of that month up to (but not
 *  including) that day, less advances already taken that month. Salaried staff earn salary ÷ 30 per
 *  day worked; hourly staff earn their rate for the minutes worked. Anyone with no rate gets 0. */
export function advanceLimit(userId: number, paidOn: string, ignorePaymentId?: number): AdvanceLimit {
  const db = getDb();
  const u = db.prepare("SELECT employment_type AS t, monthly_salary AS sal, hourly_rate AS rate FROM users WHERE id = ?")
    .get(userId) as { t: string | null; sal: number | null; rate: number | null } | undefined;
  const month = paidOn.slice(0, 7);
  const from = new Date(`${month}-01T00:00:00+07:00`).toISOString();
  const to = new Date(`${paidOn}T00:00:00+07:00`).toISOString();
  const entries = db.prepare("SELECT user_id, ts, type FROM time_entries WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts")
    .all(userId, from, to) as Array<{ user_id: number; ts: string; type: "in" | "out" }>;
  const { shifts } = pairShifts(entries);
  const days = new Set(shifts.map((s) => bkkDateIso(s.startTs)));
  let earned = 0; let basis: AdvanceLimit["basis"] = "none";
  if (u?.t === "ft" && (u.sal ?? 0) > 0) { basis = "salary"; earned = Math.min(u.sal!, (u.sal! / 30) * days.size); }
  else if (u?.t === "pt") {
    const rate = (u.rate ?? 0) > 0 ? u.rate! : (loadPayrollSettings(db, null).pt_default_hourly_rate ?? 0);
    if (rate > 0) { basis = "hourly"; earned = (shifts.reduce((a, s) => a + s.durationMinutes, 0) / 60) * rate; }
  }
  const taken = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM staff_special_payments
      WHERE user_id = ? AND kind = 'advance' AND voided_at IS NULL AND substr(paid_on, 1, 7) = ? AND id != ?`)
    .get(userId, month, ignorePaymentId ?? 0) as { s: number }).s;
  earned = r2(earned);
  return { earned, taken: r2(taken), available: Math.max(0, r2(earned - taken)), basis, workedDays: days.size };
}

// ── recording ────────────────────────────────────────────────────────────────

/** Periods (not cancelled) that cover `paidOn` and contain a line for the person. */
function periodsFor(db: Database.Database, userId: number, paidOn: string) {
  return db.prepare(`
    SELECT p.id AS periodId, p.status, l.reviewed_at AS reviewedAt
      FROM payroll_periods p JOIN payroll_lines l ON l.period_id = p.id AND l.user_id = ?
     WHERE p.status != 'cancelled' AND p.period_start <= ? AND p.period_end >= ?
  `).all(userId, paidOn, paidOn) as Array<{ periodId: number; status: string; reviewedAt: string | null }>;
}

function assertSettleable(db: Database.Database, userId: number, paidOn: string) {
  for (const p of periodsFor(db, userId, paidOn)) {
    if (p.status === "finalized") throw new PaymentError("period_finalized");
    if (p.reviewedAt) throw new PaymentError("line_reviewed");
  }
}

export function recordPayment(args: { userId: number; kind: PaymentKind; paidOn: string; amount: number; reason: string; actorId: number }): number {
  const db = getDb();
  const reason = (args.reason ?? "").trim();
  if (reason.length < 3) throw new PaymentError("reason_required");
  if (!Number.isFinite(args.amount) || args.amount <= 0 || args.amount > 1_000_000) throw new PaymentError("amount_invalid");
  const amount = r2(args.amount);
  if (!isIso(args.paidOn)) throw new PaymentError("date_invalid");
  if (args.paidOn > todayBkk()) throw new PaymentError("date_in_future");
  const u = db.prepare("SELECT role, status FROM users WHERE id = ?").get(args.userId) as { role: string; status: string } | undefined;
  if (!u || !["staff", "admin"].includes(u.role)) throw new PaymentError("user_invalid");
  if (["disabled", "resigned", "terminated"].includes(u.status)) throw new PaymentError("user_not_active");

  let id = 0;
  db.transaction(() => {
    assertSettleable(db, args.userId, args.paidOn);
    if (args.kind === "advance") {
      const lim = advanceLimit(args.userId, args.paidOn);
      if (lim.basis === "none") throw new PaymentError("advance_not_available", { available: 0 });
      if (amount > lim.available) throw new PaymentError("advance_exceeds_limit", { available: lim.available });
    }
    id = Number(db.prepare("INSERT INTO staff_special_payments (user_id, kind, paid_on, amount, reason, created_by) VALUES (?,?,?,?,?,?)")
      .run(args.userId, args.kind, args.paidOn, amount, reason, args.actorId).lastInsertRowid);
    foldForUserDate(db, args.userId, args.paidOn);
  })();
  return id;
}

export function voidPayment(args: { id: number; reason: string; actorId: number }): void {
  const db = getDb();
  const reason = (args.reason ?? "").trim();
  if (reason.length < 3) throw new PaymentError("reason_required");
  db.transaction(() => {
    const row = db.prepare("SELECT user_id, paid_on, voided_at FROM staff_special_payments WHERE id = ?")
      .get(args.id) as { user_id: number; paid_on: string; voided_at: string | null } | undefined;
    if (!row) throw new PaymentError("not_found");
    if (row.voided_at) throw new PaymentError("already_voided");
    assertSettleable(db, row.user_id, row.paid_on);
    db.prepare("UPDATE staff_special_payments SET voided_at = CURRENT_TIMESTAMP, voided_by = ?, void_reason = ? WHERE id = ?")
      .run(args.actorId, reason, args.id);
    foldForUserDate(db, row.user_id, row.paid_on);
  })();
}

// ── folding into payroll lines ──────────────────────────────────────────────

/**
 * Bring ONE payroll line in line with the ledger. Idempotent: the line's previously folded amounts
 * (special_*) are taken out first, then the current ledger is put in. Callers that REWRITE gross/tax/net
 * from the engine must reset special_payment/special_tax/special_paid_out to 0 in that same UPDATE.
 */
export function foldSpecialPayments(db: Database.Database, periodId: number, userId: number): void {
  const period = db.prepare("SELECT period_start AS s, period_end AS e, branch_id AS b, status FROM payroll_periods WHERE id = ?")
    .get(periodId) as { s: string; e: string; b: number | null; status: string } | undefined;
  if (!period || period.status !== "draft") return;
  const line = db.prepare(`SELECT gross_pay, sso_amount, tax_amount, other_deductions, drink_deductions, mealpass_deductions,
      special_payment, special_tax, salary_tax_mode_snapshot AS mode, reviewed_at
      FROM payroll_lines WHERE period_id = ? AND user_id = ?`).get(periodId, userId) as {
    gross_pay: number; sso_amount: number; tax_amount: number; other_deductions: number; drink_deductions: number;
    mealpass_deductions: number; special_payment: number; special_tax: number; mode: string | null; reviewed_at: string | null;
  } | undefined;
  if (!line || line.reviewed_at) return;

  // Settled once: in a company-wide round, or in the round of the person's primary branch.
  let aid = 0; let advance = 0;
  const primary = (db.prepare(`SELECT COALESCE((SELECT branch_id FROM user_branches WHERE user_id = ? AND is_primary = 1 LIMIT 1),
      (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?)) AS b`).get(userId, userId) as { b: number | null }).b;
  if (period.b == null || period.b === primary) {
    const rows = db.prepare(`SELECT kind, COALESCE(SUM(amount), 0) AS s FROM staff_special_payments
        WHERE user_id = ? AND voided_at IS NULL AND paid_on >= ? AND paid_on <= ? GROUP BY kind`)
      .all(userId, period.s, period.e) as Array<{ kind: PaymentKind; s: number }>;
    aid = r2(rows.find((r) => r.kind === "aid")?.s ?? 0);
    advance = r2(rows.find((r) => r.kind === "advance")?.s ?? 0);
  }
  const rate = line.mode === "wht" ? loadPayrollSettings(db, period.b).wht_rate : 0;
  const specialTax = r2(aid * rate);
  const paidOut = r2(aid + advance);
  const gross = r2(line.gross_pay - line.special_payment + aid);
  const tax = r2(line.tax_amount - line.special_tax + specialTax);
  const net = Math.max(0, r2(gross - line.sso_amount - tax - line.other_deductions - line.drink_deductions - line.mealpass_deductions - paidOut));
  db.prepare(`UPDATE payroll_lines SET special_payment = ?, special_tax = ?, special_paid_out = ?, gross_pay = ?, tax_amount = ?, net_pay = ?,
      updated_at = CURRENT_TIMESTAMP WHERE period_id = ? AND user_id = ?`).run(aid, specialTax, paidOut, gross, tax, net, periodId, userId);
}

export function foldAllForPeriod(db: Database.Database, periodId: number): void {
  const users = db.prepare("SELECT user_id FROM payroll_lines WHERE period_id = ?").all(periodId) as Array<{ user_id: number }>;
  for (const u of users) foldSpecialPayments(db, periodId, u.user_id);
}

function foldForUserDate(db: Database.Database, userId: number, paidOn: string): void {
  for (const p of periodsFor(db, userId, paidOn)) if (p.status === "draft") foldSpecialPayments(db, p.periodId, userId);
}
