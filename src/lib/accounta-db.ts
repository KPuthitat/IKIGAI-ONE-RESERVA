// ── ACCOUNTA — data access (SQLite, server-only) ───────────────────
// Expense ledger (รายจ่าย) + vendor master + OCR usage log. Shared across
// every admin granted accounta.manage (route guards enforce that). Two
// time axes power the accrual-vs-cashflow split: bill_date (ตามบิล) and
// paid_date (กระแสเงินสด). See lib/accounta.ts for the pure helpers.

import { getDb } from "./db";
import {
  splitVat, round2, ocrCostBaht,
  type ExpenseInput, type PaymentStatus
} from "./accounta";

export type VendorRow = {
  id: number;
  name: string;
  tax_id: string | null;
  category: string | null;
};

export type ExpenseRow = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  company_id: number | null;
  company_name: string | null;
  bill_date: string;
  vendor_id: number | null;
  vendor_name: string | null;
  doc_type: string | null;
  category: string | null;
  description: string | null;
  amount_total: number;
  has_tax_invoice: number;
  vat_amount: number;
  base_amount: number;
  payment_status: PaymentStatus;
  payment_method: string | null;
  paid_date: string | null;
  has_doc: boolean;
  doc_mime: string | null;
  ocr_source: string | null;
  ocr_cost_baht: number | null;
  review_status: string;          // 'draft' (จากไลน์ รอตรวจ) | 'confirmed'
  note: string | null;
  created_at: string;
  updated_at: string;
};

// ── Reference lists ────────────────────────────────────────────────

export function listBranches(): Array<{ id: number; name: string; company_id: number | null }> {
  return getDb().prepare(
    "SELECT id, name, company_id FROM branches WHERE status != 'closed' ORDER BY display_order, name"
  ).all() as Array<{ id: number; name: string; company_id: number | null }>;
}

export function listCompanies(): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name_th AS name FROM companies WHERE active = 1 ORDER BY name_th COLLATE NOCASE"
  ).all() as Array<{ id: number; name: string }>;
}

export type CategoryRow = {
  id: number; code: string | null; name: string;
  description: string | null; target_pct_min: number | null; target_pct_max: number | null;
};

export function listCategories(): CategoryRow[] {
  return getDb().prepare(
    "SELECT id, code, name, description, target_pct_min, target_pct_max FROM accounta_categories WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all() as CategoryRow[];
}

export function createCategory(d: { name: string; code?: string | null }): number {
  const name = d.name.trim();
  const existing = getDb().prepare(
    "SELECT id FROM accounta_categories WHERE name = ? COLLATE NOCASE"
  ).get(name) as { id: number } | undefined;
  if (existing) {
    getDb().prepare("UPDATE accounta_categories SET active = 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const max = (getDb().prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_categories").get() as { m: number }).m;
  const info = getDb().prepare(
    "INSERT INTO accounta_categories (code, name, sort_order) VALUES (?, ?, ?)"
  ).run(d.code?.trim() || null, name, max + 10);
  return Number(info.lastInsertRowid);
}

export function listPaymentMethods(): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name FROM accounta_payment_methods WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all() as Array<{ id: number; name: string }>;
}

export function createPaymentMethod(d: { name: string }): number {
  const name = d.name.trim();
  const existing = getDb().prepare(
    "SELECT id FROM accounta_payment_methods WHERE name = ? COLLATE NOCASE"
  ).get(name) as { id: number } | undefined;
  if (existing) {
    getDb().prepare("UPDATE accounta_payment_methods SET active = 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const max = (getDb().prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_payment_methods").get() as { m: number }).m;
  const info = getDb().prepare(
    "INSERT INTO accounta_payment_methods (name, sort_order) VALUES (?, ?)"
  ).run(name, max + 10);
  return Number(info.lastInsertRowid);
}

// Per-branch income channels (owner 2026-06-21). Each branch has its own
// list (a clinic's insurer credit accounts differ from a restaurant's card
// types). A branch with no list of its own falls back to the shared defaults
// (branch_id IS NULL) so nothing breaks before it's configured.
export function listIncomeChannels(branchId?: number | null): Array<{ id: number; name: string }> {
  const db = getDb();
  if (branchId != null) {
    const own = db.prepare(
      "SELECT id, name FROM accounta_income_channels WHERE branch_id = ? AND active = 1 ORDER BY sort_order, name COLLATE NOCASE"
    ).all(branchId) as Array<{ id: number; name: string }>;
    if (own.length > 0) return own;
  }
  return db.prepare(
    "SELECT id, name FROM accounta_income_channels WHERE branch_id IS NULL AND active = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all() as Array<{ id: number; name: string }>;
}

/** Channels that staff fill on the shift-close report — the branch's OWN
 *  active + show_on_close channels. Strictly OPT-IN per branch (owner
 *  2026-06-21): a branch that hasn't set up its channels gets NO breakdown
 *  panel (and no reconciliation) — staff just enter the daily total, exactly
 *  as before the feature. No global fallback, so a half-configured branch is
 *  never forced to reconcile against the wrong default channels. */
export function listShiftCloseChannels(branchId?: number | null): Array<{ id: number; name: string; is_credit: number }> {
  if (branchId == null) return [];
  return getDb().prepare(
    "SELECT id, name, is_credit FROM accounta_income_channels WHERE branch_id = ? AND active = 1 AND show_on_close = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all(branchId) as Array<{ id: number; name: string; is_credit: number }>;
}

export function createIncomeChannel(d: { name: string; branchId: number }): number {
  const db = getDb();
  const name = d.name.trim();
  const existing = db.prepare(
    "SELECT id FROM accounta_income_channels WHERE branch_id = ? AND name = ? COLLATE NOCASE"
  ).get(d.branchId, name) as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE accounta_income_channels SET active = 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const max = (db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_income_channels WHERE branch_id = ?").get(d.branchId) as { m: number }).m;
  const info = db.prepare(
    "INSERT INTO accounta_income_channels (branch_id, name, sort_order) VALUES (?, ?, ?)"
  ).run(d.branchId, name, max + 10);
  return Number(info.lastInsertRowid);
}

// ── Channel master management (owner 2026-06-21) — per branch ─────
// Drives both the manual รายรับ picklist AND the shift-close breakdown.

export type ChannelRow = { id: number; name: string; sort_order: number; active: number; show_on_close: number; is_credit: number };

/** The branch's OWN channels (incl. inactive) for the manager. */
export function listAllIncomeChannels(branchId: number): ChannelRow[] {
  return getDb().prepare(
    "SELECT id, name, sort_order, active, show_on_close, is_credit FROM accounta_income_channels WHERE branch_id = ? ORDER BY active DESC, sort_order, name COLLATE NOCASE"
  ).all(branchId) as ChannelRow[];
}

/** Shared default channel names (branch_id NULL) — offered as a starter set. */
export function listDefaultChannelNames(): string[] {
  return (getDb().prepare(
    "SELECT name FROM accounta_income_channels WHERE branch_id IS NULL AND active = 1 ORDER BY sort_order"
  ).all() as Array<{ name: string }>).map((r) => r.name);
}

/** Copy the shared defaults into a branch's own list (skip ones it has). */
export function copyDefaultChannelsToBranch(branchId: number): number {
  return getDb().prepare(`
    INSERT INTO accounta_income_channels (branch_id, name, sort_order, active)
    SELECT ?, d.name, d.sort_order, 1 FROM accounta_income_channels d
     WHERE d.branch_id IS NULL AND d.active = 1
       AND NOT EXISTS (SELECT 1 FROM accounta_income_channels x WHERE x.branch_id = ? AND x.name = d.name COLLATE NOCASE)
  `).run(branchId, branchId).changes;
}

/** branch-scope guard: only mutate a channel that belongs to this branch. */
function channelInBranch(id: number, branchId: number): { sort_order: number } | null {
  return getDb().prepare(
    "SELECT sort_order FROM accounta_income_channels WHERE id = ? AND branch_id = ?"
  ).get(id, branchId) as { sort_order: number } | null;
}

export function renameIncomeChannel(id: number, branchId: number, name: string): boolean {
  const db = getDb();
  const trimmed = name.trim();
  if (!trimmed || !channelInBranch(id, branchId)) return false;
  const clash = db.prepare(
    "SELECT id FROM accounta_income_channels WHERE branch_id = ? AND name = ? COLLATE NOCASE AND id <> ?"
  ).get(branchId, trimmed, id) as { id: number } | undefined;
  if (clash) return false;
  return db.prepare("UPDATE accounta_income_channels SET name = ? WHERE id = ?").run(trimmed, id).changes > 0;
}

export function setIncomeChannelActive(id: number, branchId: number, active: boolean): boolean {
  if (!channelInBranch(id, branchId)) return false;
  return getDb().prepare("UPDATE accounta_income_channels SET active = ? WHERE id = ?")
    .run(active ? 1 : 0, id).changes > 0;
}

export function setIncomeChannelShowOnClose(id: number, branchId: number, show: boolean): boolean {
  if (!channelInBranch(id, branchId)) return false;
  return getDb().prepare("UPDATE accounta_income_channels SET show_on_close = ? WHERE id = ?")
    .run(show ? 1 : 0, id).changes > 0;
}

export function setIncomeChannelCredit(id: number, branchId: number, credit: boolean): boolean {
  if (!channelInBranch(id, branchId)) return false;
  return getDb().prepare("UPDATE accounta_income_channels SET is_credit = ? WHERE id = ?")
    .run(credit ? 1 : 0, id).changes > 0;
}

/** Swap sort_order with the active neighbour (same branch) in the direction. */
export function moveIncomeChannel(id: number, branchId: number, dir: "up" | "down"): boolean {
  const db = getDb();
  const me = channelInBranch(id, branchId);
  if (!me) return false;
  const neighbour = db.prepare(
    dir === "up"
      ? "SELECT id, sort_order FROM accounta_income_channels WHERE branch_id = ? AND active = 1 AND sort_order < ? ORDER BY sort_order DESC LIMIT 1"
      : "SELECT id, sort_order FROM accounta_income_channels WHERE branch_id = ? AND active = 1 AND sort_order > ? ORDER BY sort_order ASC LIMIT 1"
  ).get(branchId, me.sort_order) as { id: number; sort_order: number } | undefined;
  if (!neighbour) return false;
  const swap = db.transaction(() => {
    db.prepare("UPDATE accounta_income_channels SET sort_order = ? WHERE id = ?").run(neighbour.sort_order, id);
    db.prepare("UPDATE accounta_income_channels SET sort_order = ? WHERE id = ?").run(me.sort_order, neighbour.id);
  });
  swap();
  return true;
}

export type IncomeRow = {
  id: number;
  branch_id: number | null;
  branch_name: string | null;
  company_id: number | null;
  company_name: string | null;
  income_date: string;
  channel: string | null;
  amount: number;
  note: string | null;
  source: string;
  is_outstanding: number;
  settled_date: string | null;
};

export type IncomeInput = {
  branch_id: number | null;
  company_id: number | null;
  income_date: string;
  channel: string | null;
  amount: number;
  note: string | null;
};

export type IncomeFilter = { branchId?: number | null; companyId?: number | null; month?: string | null };

export function listIncome(f: IncomeFilter = {}): IncomeRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.branchId != null) { where.push("i.branch_id = ?"); args.push(f.branchId); }
  if (f.companyId != null) { where.push("i.company_id = ?"); args.push(f.companyId); }
  if (f.month) { where.push("substr(i.income_date,1,7) = ?"); args.push(f.month); }
  const sql = `
    SELECT i.id, i.branch_id, b.name AS branch_name, i.company_id, c.name_th AS company_name,
           i.income_date, i.channel, i.amount, i.note, i.source, i.is_outstanding, i.settled_date
      FROM accounta_income i
      LEFT JOIN branches b  ON b.id = i.branch_id
      LEFT JOIN companies c ON c.id = i.company_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.income_date DESC, i.id DESC`;
  return getDb().prepare(sql).all(...args) as IncomeRow[];
}

export function createIncome(userId: number, d: IncomeInput): number {
  const info = getDb().prepare(`
    INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(d.branch_id, d.company_id, d.income_date, d.channel, round2(Number(d.amount) || 0), d.note?.trim() || null, userId);
  return Number(info.lastInsertRowid);
}

export function updateIncome(id: number, d: IncomeInput): boolean {
  const info = getDb().prepare(`
    UPDATE accounta_income SET branch_id = ?, company_id = ?, income_date = ?, channel = ?,
      amount = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(d.branch_id, d.company_id, d.income_date, d.channel, round2(Number(d.amount) || 0), d.note?.trim() || null, id);
  return info.changes > 0;
}

export function deleteIncome(id: number): boolean {
  return getDb().prepare("DELETE FROM accounta_income WHERE id = ?").run(id).changes > 0;
}

export function getIncome(id: number): IncomeRow | null {
  return listIncome().find((r) => r.id === id) ?? getDb().prepare(`
    SELECT i.id, i.branch_id, b.name AS branch_name, i.company_id, c.name_th AS company_name,
           i.income_date, i.channel, i.amount, i.note, i.source, i.is_outstanding, i.settled_date
      FROM accounta_income i
      LEFT JOIN branches b ON b.id = i.branch_id
      LEFT JOIN companies c ON c.id = i.company_id
     WHERE i.id = ?
  `).get(id) as IncomeRow | undefined ?? null;
}

// ── Shift-close → รายรับ ledger mirror ───────────────────────────
// The payment channels staff already fill in at shift-close double as
// the income breakdown: any SECTION row flagged income_breakdown=1 has
// its amount children mirrored here as per-channel income (owner
// 2026-06-21). source='shift_close' rows are owned by this flow and
// rebuilt on every submit — admins edit the source (ยอดขายรายวัน), not
// the mirror. When a branch has no breakdown configured we fall back to
// a single channel-less total row (the daily revenue figure).

/** Rebuild the source='shift_close' income rows for a (branch, date):
 *  delete the old ones, insert the given rows. Channel names are also
 *  registered in accounta_income_channels so they appear in the manual
 *  รายรับ dropdown (one source of truth for channels). */
export function replaceShiftCloseIncome(
  branchId: number,
  date: string,
  userId: number,
  rows: Array<{ channel: string | null; amount: number; isOutstanding?: boolean }>
): void {
  const db = getDb();
  const company = db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(branchId) as { company_id: number | null } | undefined;
  const companyId = company?.company_id ?? null;
  const txn = db.transaction(() => {
    db.prepare(
      "DELETE FROM accounta_income WHERE branch_id = ? AND income_date = ? AND source = 'shift_close'"
    ).run(branchId, date);
    const ins = db.prepare(
      `INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, created_by, source, is_outstanding)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'shift_close', ?)`
    );
    for (const r of rows) {
      const amt = round2(r.amount);
      if (amt <= 0) continue;
      const outstanding = r.isOutstanding ? 1 : 0;
      const note = r.channel
        ? `จากรายงานปิดกะ · ${r.channel}${outstanding ? " (ค้างชำระ)" : ""}`
        : "ดึงอัตโนมัติจากรายงานปิดกะ (ยอดขายรวมทุกช่องทาง)";
      ins.run(branchId, companyId, date, r.channel, amt, note, userId, outstanding);
    }
  });
  txn();
}

/** Called from the admin daily-revenue edit. Only mirrors the total when
 *  there's no per-channel breakdown for that date — never clobbers the
 *  channel rows a shift-close submit produced. */
export function syncShiftCloseTotalIfNoChannels(
  branchId: number,
  date: string,
  total: number | null,
  userId: number
): void {
  const hasChannel = getDb().prepare(
    "SELECT 1 FROM accounta_income WHERE branch_id = ? AND income_date = ? AND source = 'shift_close' AND channel IS NOT NULL LIMIT 1"
  ).get(branchId, date);
  if (hasChannel) return;
  replaceShiftCloseIncome(branchId, date, userId, total != null ? [{ channel: null, amount: total }] : []);
}

export type IncomeSummary = { total: number; byChannel: Array<{ channel: string; total: number }> };

export function incomeSummary(month: string, branchId?: number | null, companyId?: number | null): IncomeSummary {
  const where = ["substr(income_date,1,7) = ?"];
  const args: Array<string | number> = [month];
  if (branchId != null) { where.push("branch_id = ?"); args.push(branchId); }
  if (companyId != null) { where.push("company_id = ?"); args.push(companyId); }
  const rows = getDb().prepare(`
    SELECT COALESCE(channel,'(ไม่ระบุ)') AS channel, COALESCE(SUM(amount),0) AS total
      FROM accounta_income WHERE ${where.join(" AND ")}
     GROUP BY COALESCE(channel,'(ไม่ระบุ)') ORDER BY total DESC
  `).all(...args) as Array<{ channel: string; total: number }>;
  const total = round2(rows.reduce((s, r) => s + r.total, 0));
  return { total, byChannel: rows.map((r) => ({ channel: r.channel, total: round2(r.total) })) };
}

// ── Accounts receivable / ลูกหนี้ค้างชำระ (owner 2026-06-22) ─────────
// A credit sale (is_outstanding=1) counts as revenue on its income_date but
// the cash arrives later. settled_date = when it was collected (NULL = still
// owed). Outstanding balance = is_outstanding=1 AND settled_date IS NULL.

export type ReceivableRow = {
  id: number; income_date: string; channel: string | null; amount: number; note: string | null;
};

/** Open receivables for a branch (oldest first). */
export function listOutstandingReceivables(branchId: number): ReceivableRow[] {
  return getDb().prepare(
    `SELECT id, income_date, channel, amount, note FROM accounta_income
      WHERE branch_id = ? AND is_outstanding = 1 AND settled_date IS NULL
      ORDER BY income_date ASC, id ASC`
  ).all(branchId) as ReceivableRow[];
}

/** Outstanding balance grouped by channel/entity (who owes how much). */
export function receivablesByEntity(branchId: number): Array<{ channel: string; amount: number; count: number }> {
  return (getDb().prepare(
    `SELECT COALESCE(NULLIF(channel,''),'(ไม่ระบุ)') AS channel, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count
       FROM accounta_income
      WHERE branch_id = ? AND is_outstanding = 1 AND settled_date IS NULL
      GROUP BY COALESCE(NULLIF(channel,''),'(ไม่ระบุ)') ORDER BY amount DESC`
  ).all(branchId) as Array<{ channel: string; amount: number; count: number }>)
    .map((r) => ({ channel: r.channel, amount: round2(r.amount), count: r.count }));
}

/** Total open receivables for a branch. */
export function receivablesTotal(branchId: number): number {
  const r = getDb().prepare(
    "SELECT COALESCE(SUM(amount),0) AS t FROM accounta_income WHERE branch_id = ? AND is_outstanding = 1 AND settled_date IS NULL"
  ).get(branchId) as { t: number };
  return round2(r.t);
}

/** Mark a receivable collected (รับชำระแล้ว) — records the cash-in date.
 *  is_outstanding stays as the credit-sale marker so accrual history is intact. */
export function settleReceivable(id: number, branchId: number, settledDate: string): boolean {
  return getDb().prepare(
    "UPDATE accounta_income SET settled_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND branch_id = ? AND is_outstanding = 1 AND settled_date IS NULL"
  ).run(settledDate, id, branchId).changes > 0;
}

// ── Payroll → ACCOUNTA auto-posting (owner 2026-06-22) ──────────────
// When a payroll run is finalized, post one รายจ่าย per employee (เงินเดือน =
// net pay, จ่ายแล้ว) plus two payables for the period: ภาษีหัก ณ ที่จ่าย and
// ประกันสังคม (รอจ่าย — admin picks the remit date when paid). Salary(net) +
// WHT + SSO = gross, so nothing double-counts. Tagged with payroll_period_id
// so a re-finalize replaces them and an unfinalize removes them.

function ensureExpenseCategory(name: string, code: string | null): void {
  getDb().prepare(
    "INSERT OR IGNORE INTO accounta_categories (code, name, sort_order) VALUES (?, ?, 600)"
  ).run(code, name);
}

export function removePayrollFromAccounta(periodId: number): void {
  getDb().prepare("DELETE FROM accounta_expenses WHERE payroll_period_id = ?").run(periodId);
}

export function postPayrollToAccounta(periodId: number, userId: number): { salaries: number; tax: number; sso: number } {
  const db = getDb();
  // Payroll runs org-wide (no branch on the period), so these post as
  // company-level รายจ่าย: branch_id = NULL. company_id is filled only when
  // the org has exactly one company, otherwise left NULL.
  const period = db.prepare(
    "SELECT id, period_start, period_end, pay_date FROM payroll_periods WHERE id = ?"
  ).get(periodId) as { id: number; period_start: string; period_end: string; pay_date: string | null } | undefined;
  if (!period) return { salaries: 0, tax: 0, sso: 0 };
  const companies = db.prepare("SELECT id FROM companies").all() as Array<{ id: number }>;
  const companyId = companies.length === 1 ? companies[0].id : null;
  const branchId: number | null = null;
  const lines = db.prepare(
    "SELECT display_name, employment_type, net_pay, tax_amount, sso_amount FROM payroll_lines WHERE period_id = ?"
  ).all(periodId) as Array<{ display_name: string; employment_type: string | null; net_pay: number; tax_amount: number; sso_amount: number }>;

  ensureExpenseCategory("เงินเดือน/ค่าจ้าง", "LB");
  ensureExpenseCategory("ภาษีหัก ณ ที่จ่าย", "WHT");
  ensureExpenseCategory("ประกันสังคม", "SSO");

  const payDate = period.pay_date ?? bkkToday();
  const periodLabel = `${period.period_start} – ${period.period_end}`;
  const ins = db.prepare(`
    INSERT INTO accounta_expenses
      (branch_id, company_id, bill_date, vendor_name, category, amount_total, has_tax_invoice,
       vat_amount, base_amount, payment_status, payment_method, paid_date, note, review_status, created_by, payroll_period_id)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`);

  const run = db.transaction(() => {
    db.prepare("DELETE FROM accounta_expenses WHERE payroll_period_id = ?").run(periodId);
    let salaries = 0, totalTax = 0, totalSso = 0;
    for (const l of lines) {
      const net = round2(l.net_pay || 0);
      totalTax += l.tax_amount || 0;
      totalSso += l.sso_amount || 0;
      if (net <= 0) continue;
      const typeLabel = l.employment_type === "pt" ? "พนักงานพาร์ทไทม์ " : l.employment_type === "ft" ? "พนักงานประจำ " : "";
      ins.run(branchId, companyId, payDate, `${typeLabel}${l.display_name}`,
        "เงินเดือน/ค่าจ้าง", net, net, "paid", "transfer", payDate,
        `เงินเดือน/ค่าจ้าง รอบ ${periodLabel}`, userId, periodId);
      salaries += 1;
    }
    totalTax = round2(totalTax); totalSso = round2(totalSso);
    if (totalTax > 0) {
      ins.run(branchId, companyId, payDate, "กรมสรรพากร (ภาษีหัก ณ ที่จ่าย)",
        "ภาษีหัก ณ ที่จ่าย", totalTax, totalTax, "unpaid", null, null,
        `ภาษีหัก ณ ที่จ่าย รอนำส่ง · รอบ ${periodLabel} (${lines.length} คน)`, userId, periodId);
    }
    if (totalSso > 0) {
      ins.run(branchId, companyId, payDate, "สำนักงานประกันสังคม",
        "ประกันสังคม", totalSso, totalSso, "unpaid", null, null,
        `ประกันสังคมรอนำส่ง · รอบ ${periodLabel}`, userId, periodId);
    }
    return { salaries, tax: totalTax, sso: totalSso };
  });
  return run();
}

// ── Category vs benchmark % (owner 2026-06-18) ─────────────────────
// Each category's actual spend as a % of REVENUE for the month, compared to
// its target band, so the owner can see what's over/under the F&B benchmark.

export type CategoryBudgetItem = {
  code: string | null; name: string; description: string | null;
  spent: number; pct: number | null;            // pct = of revenue (null when no revenue)
  targetMin: number | null; targetMax: number | null;
  status: "over" | "under" | "ok" | "na";
};
export type CategoryBudget = {
  month: string; revenue: number; totalExpense: number;
  items: CategoryBudgetItem[];
  uncategorized: number;
};

export function categoryBudget(month: string, branchId?: number | null, companyId?: number | null): CategoryBudget {
  const db = getDb();
  const revenue = incomeSummary(month, branchId, companyId).total;

  const where = ["review_status = 'confirmed'", "substr(bill_date,1,7) = ?"];
  const args: Array<string | number> = [month];
  if (branchId != null) { where.push("branch_id = ?"); args.push(branchId); }
  if (companyId != null) { where.push("company_id = ?"); args.push(companyId); }
  const rows = db.prepare(
    `SELECT COALESCE(category,'') AS name, ROUND(SUM(amount_total),2) AS spent
       FROM accounta_expenses WHERE ${where.join(" AND ")} GROUP BY COALESCE(category,'')`
  ).all(...args) as Array<{ name: string; spent: number }>;
  const spentByName = new Map(rows.map((r) => [r.name, r.spent]));
  const totalExpense = round2(rows.reduce((s, r) => s + r.spent, 0));

  const matched = new Set<string>();
  const items: CategoryBudgetItem[] = listCategories().map((c) => {
    matched.add(c.name);
    const spent = round2(spentByName.get(c.name) ?? 0);
    const pct = revenue > 0 ? round2((spent / revenue) * 100) : null;
    let status: CategoryBudgetItem["status"] = "ok";
    if (pct == null || (c.target_pct_min == null && c.target_pct_max == null)) status = "na";
    else if (c.target_pct_max != null && pct > c.target_pct_max) status = "over";
    else if (c.target_pct_min != null && pct < c.target_pct_min) status = "under";
    return {
      code: c.code, name: c.name, description: c.description,
      spent, pct, targetMin: c.target_pct_min, targetMax: c.target_pct_max, status
    };
  });
  // Spend on a category not in the active list (renamed/blank) — surfaced once.
  let uncategorized = 0;
  for (const [name, spent] of spentByName) if (!matched.has(name)) uncategorized += spent;

  return { month, revenue, totalExpense, items, uncategorized: round2(uncategorized) };
}

export function listVendors(): VendorRow[] {
  return getDb().prepare(
    "SELECT id, name, tax_id, category FROM accounta_vendors WHERE active = 1 ORDER BY name COLLATE NOCASE"
  ).all() as VendorRow[];
}

export function createVendor(
  userId: number,
  d: { name: string; tax_id?: string | null; category?: string | null }
): number {
  const name = d.name.trim();
  const cat = d.category?.trim() || null;
  const tax = d.tax_id?.trim() || null;
  // De-dup on name (case-insensitive) so the picker doesn't accrue twins.
  const existing = getDb().prepare(
    "SELECT id FROM accounta_vendors WHERE active = 1 AND name = ? COLLATE NOCASE"
  ).get(name) as { id: number } | undefined;
  if (existing) {
    // "Learn from edits": when the admin saves a bill with a corrected
    // category/tax_id for a known vendor, remember the latest values so the
    // next bill from that vendor auto-fills them. Only overwrite with a real
    // value — never blank out a good one (owner 2026-06-18).
    if (cat || tax) {
      getDb().prepare(
        "UPDATE accounta_vendors SET category = COALESCE(?, category), tax_id = COALESCE(?, tax_id) WHERE id = ?"
      ).run(cat, tax, existing.id);
    }
    return existing.id;
  }
  const info = getDb().prepare(`
    INSERT INTO accounta_vendors (name, tax_id, category, created_by)
    VALUES (?, ?, ?, ?)
  `).run(name, tax, cat, userId);
  return Number(info.lastInsertRowid);
}

/** Look up an active vendor by name (case-insensitive). Used to auto-fill the
 *  remembered category/tax_id when OCR reads a known vendor. */
export function findVendorByName(name: string): VendorRow | null {
  const v = name.trim();
  if (!v) return null;
  return getDb().prepare(
    "SELECT id, name, tax_id, category FROM accounta_vendors WHERE active = 1 AND name = ? COLLATE NOCASE"
  ).get(v) as VendorRow | undefined ?? null;
}

// ── Expense CRUD ───────────────────────────────────────────────────

const SELECT_EXPENSE = `
  SELECT e.*,
         b.name AS branch_name,
         c.name_th AS company_name,
         (e.doc_path IS NOT NULL) AS has_doc
    FROM accounta_expenses e
    LEFT JOIN branches b  ON b.id = e.branch_id
    LEFT JOIN companies c ON c.id = e.company_id
`;

type RawExpense = Omit<ExpenseRow, "has_doc"> & { has_doc: number; doc_path?: string | null };

function shape(r: RawExpense): ExpenseRow {
  const { doc_path, ...rest } = r;
  void doc_path;
  return { ...rest, has_doc: !!r.has_doc } as ExpenseRow;
}

export type ExpenseFilter = {
  branchId?: number | null;
  companyId?: number | null;
  month?: string | null;      // 'YYYY-MM' — filters bill_date
  status?: PaymentStatus | null;
  // Review state: defaults to 'confirmed' so the ledger / summaries never
  // include LINE drafts that haven't been reviewed. 'draft' = the review
  // inbox; 'all' = both.
  reviewStatus?: "draft" | "confirmed" | "all";
};

export function listExpenses(f: ExpenseFilter = {}): ExpenseRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.branchId != null) { where.push("e.branch_id = ?"); args.push(f.branchId); }
  if (f.companyId != null) { where.push("e.company_id = ?"); args.push(f.companyId); }
  if (f.month) { where.push("substr(e.bill_date, 1, 7) = ?"); args.push(f.month); }
  if (f.status) { where.push("e.payment_status = ?"); args.push(f.status); }
  const review = f.reviewStatus ?? "confirmed";
  if (review !== "all") { where.push("e.review_status = ?"); args.push(review); }
  // Drafts read newest-submitted-first (id), confirmed rows by bill_date.
  const order = review === "draft" ? "e.id DESC" : "e.bill_date DESC, e.id DESC";
  const sql = SELECT_EXPENSE +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY ${order}`;
  return (getDb().prepare(sql).all(...args) as RawExpense[]).map(shape);
}

/** Count LINE-submitted drafts awaiting review (badge in the expenses UI). */
export function countDraftExpenses(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS n FROM accounta_expenses WHERE review_status = 'draft'"
  ).get() as { n: number }).n;
}

/** Mark a draft as reviewed → it now counts in the ledger/summaries. */
export function confirmExpense(id: number): boolean {
  return getDb().prepare(
    "UPDATE accounta_expenses SET review_status = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(id).changes > 0;
}

/** Dedup guard for the LINE webhook — true if this message already produced
 *  an expense (LINE retries deliveries on slow responses). */
export function expenseExistsForLineMessage(messageId: string): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM accounta_expenses WHERE line_message_id = ?"
  ).get(messageId);
}

export function getExpense(id: number): ExpenseRow | null {
  const r = getDb().prepare(`${SELECT_EXPENSE} WHERE e.id = ?`).get(id) as RawExpense | undefined;
  return r ? shape(r) : null;
}

/** Raw doc path for serving / cleanup (not exposed to clients). */
export function getExpenseDoc(id: number): { doc_path: string | null; doc_mime: string | null } | null {
  return getDb().prepare(
    "SELECT doc_path, doc_mime FROM accounta_expenses WHERE id = ?"
  ).get(id) as { doc_path: string | null; doc_mime: string | null } | undefined ?? null;
}

/** Normalise an input: re-derive VAT/base from the total unless the caller
 *  supplied an explicit override, and clear paid_date when still unpaid. */
function normalise(d: ExpenseInput): ExpenseInput {
  const total = round2(Number(d.amount_total) || 0);
  let vat = round2(Number(d.vat_amount) || 0);
  let base = round2(Number(d.base_amount) || 0);
  // If the caller didn't give a coherent split, derive it.
  if (round2(base + vat) !== total) {
    const s = splitVat(total, !!d.has_tax_invoice);
    vat = s.vat; base = s.base;
  }
  if (!d.has_tax_invoice) { vat = 0; base = total; }
  return {
    ...d,
    amount_total: total,
    vat_amount: vat,
    base_amount: base,
    paid_date: d.payment_status === "paid" ? (d.paid_date || d.bill_date) : null
  };
}

export function createExpense(
  userId: number,
  input: ExpenseInput,
  ocr?: { source: string; costBaht: number },
  // LINE-submitted bills land as 'draft' with the message id for dedup;
  // everything else defaults to 'confirmed'.
  extra?: { reviewStatus?: "draft" | "confirmed"; lineMessageId?: string | null }
): number {
  const d = normalise(input);
  const info = getDb().prepare(`
    INSERT INTO accounta_expenses (
      branch_id, company_id, bill_date, vendor_id, vendor_name, doc_type, category, description,
      amount_total, has_tax_invoice, vat_amount, base_amount,
      payment_status, payment_method, paid_date,
      ocr_source, ocr_cost_baht, review_status, line_message_id, note, created_by
    ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?)
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.doc_type, d.category, d.description?.trim() || null,
    d.amount_total, d.has_tax_invoice ? 1 : 0, d.vat_amount, d.base_amount,
    d.payment_status, d.payment_method, d.paid_date,
    ocr?.source ?? null, ocr?.costBaht ?? null,
    extra?.reviewStatus ?? "confirmed", extra?.lineMessageId ?? null,
    d.note?.trim() || null, userId
  );
  return Number(info.lastInsertRowid);
}

export function updateExpense(id: number, input: ExpenseInput): boolean {
  const d = normalise(input);
  const info = getDb().prepare(`
    UPDATE accounta_expenses SET
      branch_id = ?, company_id = ?, bill_date = ?, vendor_id = ?, vendor_name = ?,
      doc_type = ?, category = ?, description = ?, amount_total = ?, has_tax_invoice = ?,
      vat_amount = ?, base_amount = ?, payment_status = ?, payment_method = ?,
      paid_date = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.doc_type, d.category, d.description?.trim() || null, d.amount_total, d.has_tax_invoice ? 1 : 0,
    d.vat_amount, d.base_amount, d.payment_status, d.payment_method,
    d.paid_date, d.note?.trim() || null, id
  );
  return info.changes > 0;
}

export function setExpenseDoc(id: number, docPath: string | null, docMime: string | null): void {
  getDb().prepare(
    "UPDATE accounta_expenses SET doc_path = ?, doc_mime = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(docPath, docMime, id);
}

/** Delete an expense; returns every file path (primary + extra attachments)
 *  so the caller can unlink the orphaned files. The child rows are removed
 *  by the FK ON DELETE CASCADE. */
export function deleteExpense(id: number): { ok: boolean; paths: string[] } {
  const db = getDb();
  const primary = getExpenseDoc(id)?.doc_path ?? null;
  const extras = (db.prepare("SELECT doc_path FROM accounta_expense_docs WHERE expense_id = ?")
    .all(id) as Array<{ doc_path: string }>).map((r) => r.doc_path);
  const info = db.prepare("DELETE FROM accounta_expenses WHERE id = ?").run(id);
  const paths = [primary, ...extras].filter((p): p is string => !!p);
  return { ok: info.changes > 0, paths };
}

// ── Extra attachments (owner 2026-06-20, #3.3) ─────────────────────

export type ExpenseDocRow = {
  id: number; expense_id: number; doc_path: string; doc_mime: string | null;
  label: string | null; drive_file_id: string | null; created_at: string;
};

export function addExpenseDoc(expenseId: number, docPath: string, docMime: string | null, label: string | null, createdBy: number): number {
  const info = getDb().prepare(
    "INSERT INTO accounta_expense_docs (expense_id, doc_path, doc_mime, label, created_by) VALUES (?, ?, ?, ?, ?)"
  ).run(expenseId, docPath, docMime, label, createdBy);
  return Number(info.lastInsertRowid);
}

/** Extra attachments for an expense (metadata only — doc_path stays server-side). */
export function listExpenseDocs(expenseId: number): Array<Omit<ExpenseDocRow, "doc_path" | "expense_id">> {
  return getDb().prepare(
    "SELECT id, doc_mime, label, drive_file_id, created_at FROM accounta_expense_docs WHERE expense_id = ? ORDER BY id"
  ).all(expenseId) as Array<Omit<ExpenseDocRow, "doc_path" | "expense_id">>;
}

export function getExpenseDocRow(docId: number): ExpenseDocRow | undefined {
  return getDb().prepare("SELECT * FROM accounta_expense_docs WHERE id = ?").get(docId) as ExpenseDocRow | undefined;
}

/** Delete one extra attachment; returns its file path for unlinking. */
export function deleteExpenseDocRow(docId: number): string | null {
  const db = getDb();
  const row = db.prepare("SELECT doc_path FROM accounta_expense_docs WHERE id = ?").get(docId) as { doc_path: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM accounta_expense_docs WHERE id = ?").run(docId);
  return row.doc_path;
}

// ── Period summary (accrual vs cash flow + input VAT) ──────────────

export type AccountaSummary = {
  month: string;
  accrual: { count: number; base: number; vat: number; total: number };  // by bill_date
  cash: { count: number; total: number };                                // paid, by paid_date
  inputVat: number;        // ภาษีซื้อ this month (= accrual.vat)
  unpaidTotal: number;     // outstanding ค้างชำระ (branch-scoped, all dates)
  unpaidCount: number;
};

export function summarise(month: string, branchId?: number | null, companyId?: number | null): AccountaSummary {
  const db = getDb();
  const parts: string[] = [];
  const scope: number[] = [];
  if (branchId != null) { parts.push(" AND branch_id = ?"); scope.push(branchId); }
  if (companyId != null) { parts.push(" AND company_id = ?"); scope.push(companyId); }
  const bf = parts.join("");
  const bArg = scope;

  // review_status='confirmed' on every subquery so unreviewed LINE drafts
  // never inflate the totals (owner 2026-06-18).
  const accrual = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(base_amount),0) AS base,
           COALESCE(SUM(vat_amount),0)  AS vat,
           COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE review_status = 'confirmed' AND substr(bill_date,1,7) = ?${bf}
  `).get(month, ...bArg) as { count: number; base: number; vat: number; total: number };

  const cash = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE review_status = 'confirmed' AND payment_status = 'paid' AND substr(COALESCE(paid_date,bill_date),1,7) = ?${bf}
  `).get(month, ...bArg) as { count: number; total: number };

  const unpaid = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE review_status = 'confirmed' AND payment_status = 'unpaid'${bf}
  `).get(...bArg) as { count: number; total: number };

  return {
    month,
    accrual: {
      count: accrual.count,
      base: round2(accrual.base),
      vat: round2(accrual.vat),
      total: round2(accrual.total)
    },
    cash: { count: cash.count, total: round2(cash.total) },
    inputVat: round2(accrual.vat),
    unpaidTotal: round2(unpaid.total),
    unpaidCount: unpaid.count
  };
}

// ── Daybook (Excel-style: date rows, รายรับ left / รายจ่าย right) ───

export type DaybookExpense = {
  id: number; vendor: string | null; category: string | null;
  amount: number; status: PaymentStatus; method: string | null; vat: number;
};
export type DaybookDay = {
  date: string;
  income: number;
  incomeByChannel: Array<{ channel: string; amount: number }>;
  expenses: DaybookExpense[];
  expenseTotal: number;
  balance: number;          // running (income − expense) within the month
};
export type Daybook = {
  days: DaybookDay[];
  totalIncome: number;
  totalExpense: number;
  net: number;
};

/** Build the two-sided daily ledger for a month (owner 2026-06-17, "แบบ
 *  Excel"): income (branch_daily_revenue, fed from shift-close) on the
 *  left, expenses (accounta_expenses) on the right, with a running
 *  balance. Income is branch-scoped only; the company filter narrows the
 *  expense side. */
export function daybook(month: string, branchId?: number | null, companyId?: number | null): Daybook {
  const db = getDb();

  // Income from the ACCOUNTA รายรับ ledger, grouped by date + channel
  // (owner 2026-06-17). branch_daily_revenue stays a separate concern (COL).
  const incWhere = ["substr(income_date,1,7) = ?"];
  const incArgs: Array<string | number> = [month];
  if (branchId != null) { incWhere.push("branch_id = ?"); incArgs.push(branchId); }
  if (companyId != null) { incWhere.push("company_id = ?"); incArgs.push(companyId); }
  const incRows = db.prepare(
    `SELECT income_date AS date, COALESCE(channel,'(ไม่ระบุ)') AS channel, SUM(amount) AS amt
       FROM accounta_income WHERE ${incWhere.join(" AND ")}
      GROUP BY income_date, COALESCE(channel,'(ไม่ระบุ)')`
  ).all(...incArgs) as Array<{ date: string; channel: string; amt: number }>;
  const incByDate = new Map<string, number>();
  const incChannelsByDate = new Map<string, Array<{ channel: string; amount: number }>>();
  for (const r of incRows) {
    incByDate.set(r.date, round2((incByDate.get(r.date) ?? 0) + r.amt));
    const arr = incChannelsByDate.get(r.date) ?? [];
    arr.push({ channel: r.channel, amount: round2(r.amt) });
    incChannelsByDate.set(r.date, arr);
  }

  const exps = listExpenses({ month, branchId, companyId });
  const byDate = new Map<string, DaybookExpense[]>();
  for (const e of exps) {
    const arr = byDate.get(e.bill_date) ?? [];
    arr.push({
      id: e.id, vendor: e.vendor_name, category: e.category,
      amount: e.amount_total, status: e.payment_status,
      method: e.payment_method, vat: e.vat_amount
    });
    byDate.set(e.bill_date, arr);
  }

  const dates = [...new Set([...incByDate.keys(), ...byDate.keys()])].sort();
  let bal = 0, totalIncome = 0, totalExpense = 0;
  const days: DaybookDay[] = dates.map((date) => {
    const income = round2(incByDate.get(date) ?? 0);
    const incomeByChannel = incChannelsByDate.get(date) ?? [];
    const dayExps = byDate.get(date) ?? [];
    const expenseTotal = round2(dayExps.reduce((s, x) => s + x.amount, 0));
    bal += income - expenseTotal;
    totalIncome += income; totalExpense += expenseTotal;
    return { date, income, incomeByChannel, expenses: dayExps, expenseTotal, balance: round2(bal) };
  });
  return {
    days,
    totalIncome: round2(totalIncome),
    totalExpense: round2(totalExpense),
    net: round2(totalIncome - totalExpense)
  };
}

// ── Income/Expense dashboard (owner 2026-06-20) ────────────────────
// Single-branch financial overview: revenue / expense / net, ภาษีซื้อ-ขาย-
// ภพ.30 (output VAT only when the branch's company is vat_registered),
// per-category % of revenue, daily averages (weekday/weekend), and a
// run-rate forecast for the month. Period = week / month / year.

export type LedgerPeriod = "week" | "month" | "year";

export type LedgerCatItem = {
  code: string | null; name: string; spent: number;
  pct: number | null; targetMin: number | null; targetMax: number | null;
  status: "over" | "under" | "ok" | "na";
};

export type LedgerDashboard = {
  period: LedgerPeriod;
  start: string; end: string; label: string;
  revenue: number; expense: number; net: number;
  inputVat: number; outputVat: number; vatPayable: number; vatRegistered: boolean;
  daysWithRevenue: number; avgPerDay: number; avgWeekday: number; avgWeekend: number;
  forecast: number | null;
  categories: LedgerCatItem[];
  uncategorized: number;
  dailyRows: Array<{ date: string; revenue: number; expense: number; net: number; balance: number }>;
  incomeByChannel: Array<{ channel: string; amount: number }>;
  incomeRows: Array<{ date: string; channel: string; amount: number }>;
  byVendor: Array<{ vendor: string; amount: number }>;
  byPaymentMethod: Array<{ method: string; amount: number }>;
  cashReceived: number;                                          // เงินเข้าจริงในช่วง (cash basis)
  outstandingTotal: number;                                      // ลูกหนี้ค้างชำระคงค้าง (สะสม)
  outstandingByEntity: Array<{ channel: string; amount: number; count: number }>;
};

function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** Resolve {start,end,label} for a period anchored on a YYYY-MM-DD date. */
export function ledgerRange(period: LedgerPeriod, anchor: string): { start: string; end: string; label: string } {
  const [y, m, d] = (/^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : bkkToday()).split("-").map(Number);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  if (period === "year") {
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `ปี ${y + 543}` };
  }
  if (period === "month") {
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const mm = String(m).padStart(2, "0");
    return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}`, label: `${["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"][m]} ${y + 543}` };
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();                 // 0=Sun..6=Sat
  const mon = new Date(dt.getTime() + (dow === 0 ? -6 : 1 - dow) * 86400_000);
  const sun = new Date(mon.getTime() + 6 * 86400_000);
  const TH_M = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const thFull = (x: Date) => `${x.getUTCDate()} ${TH_M[x.getUTCMonth() + 1]} ${x.getUTCFullYear() + 543}`;
  return { start: iso(mon), end: iso(sun), label: `สัปดาห์ ${thFull(mon)} – ${thFull(sun)}` };
}

function isWeekend(ymd: string): boolean {
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function ledgerDashboard(branchId: number, period: LedgerPeriod, anchor: string): LedgerDashboard {
  const db = getDb();
  const { start, end, label } = ledgerRange(period, anchor);

  // VAT status from the branch's company.
  const co = db.prepare(
    "SELECT c.vat_registered AS vat FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.id = ?"
  ).get(branchId) as { vat: number | null } | undefined;
  const vatRegistered = !!co?.vat;

  // Revenue by day — pulled from the shift-close daily total
  // (branch_daily_revenue, recorded by the closing staff). One row per day.
  const incDays = db.prepare(
    "SELECT date AS d, revenue AS amt FROM branch_daily_revenue WHERE branch_id = ? AND date BETWEEN ? AND ? ORDER BY date"
  ).all(branchId, start, end) as Array<{ d: string; amt: number }>;
  let revenue = 0, wkdaySum = 0, wkdayN = 0, wkendSum = 0, wkendN = 0;
  for (const r of incDays) {
    revenue += r.amt;
    if (isWeekend(r.d)) { wkendSum += r.amt; wkendN += 1; } else { wkdaySum += r.amt; wkdayN += 1; }
  }
  revenue = round2(revenue);
  const daysWithRevenue = incDays.length;
  const avgPerDay = daysWithRevenue ? round2(revenue / daysWithRevenue) : 0;
  const avgWeekday = wkdayN ? round2(wkdaySum / wkdayN) : 0;
  const avgWeekend = wkendN ? round2(wkendSum / wkendN) : 0;

  // Expenses (confirmed) → total + input VAT + per-category.
  const expAgg = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS total, COALESCE(SUM(vat_amount),0) AS vat FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ?"
  ).get(branchId, start, end) as { total: number; vat: number };
  const expense = round2(expAgg.total);
  const inputVat = round2(expAgg.vat);

  const catRows = db.prepare(
    "SELECT COALESCE(category,'') AS cat, COALESCE(SUM(amount_total),0) AS spent FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ? GROUP BY COALESCE(category,'')"
  ).all(branchId, start, end) as Array<{ cat: string; spent: number }>;
  const spentByName = new Map(catRows.map((r) => [r.cat, round2(r.spent)]));
  const uncategorized = round2(spentByName.get("") ?? 0);

  const categories: LedgerCatItem[] = listCategories().map((c) => {
    const spent = round2(spentByName.get(c.name) ?? 0);
    const pct = revenue > 0 ? round2((spent / revenue) * 100) : null;
    let status: LedgerCatItem["status"] = "ok";
    if (pct == null || (c.target_pct_min == null && c.target_pct_max == null)) status = "na";
    else if (c.target_pct_max != null && pct > c.target_pct_max) status = "over";
    else if (c.target_pct_min != null && pct < c.target_pct_min) status = "under";
    return { code: c.code, name: c.name, spent, pct, targetMin: c.target_pct_min ?? null, targetMax: c.target_pct_max ?? null, status };
  }).filter((i) => i.spent > 0);

  // Output VAT (ภาษีขาย) + ภพ.30 — only when the company is VAT-registered.
  const outputVat = vatRegistered ? round2((revenue * 7) / 107) : 0;
  const vatPayable = vatRegistered ? round2(outputVat - inputVat) : 0;

  // Run-rate forecast — month period only: revenue-so-far / days-elapsed ×
  // days-in-month. Past months use all days; future months → no forecast.
  let forecast: number | null = null;
  if (period === "month") {
    const daysInMonth = Number(end.slice(8, 10));
    const today = bkkToday();
    let elapsed = daysInMonth;
    if (today >= start && today <= end) elapsed = Number(today.slice(8, 10));
    else if (today < start) elapsed = 0;
    if (elapsed > 0) forecast = round2((revenue / elapsed) * daysInMonth);
  }

  // Excel-style daily rows: revenue (shift-close) vs expense per day, with a
  // running balance — the comparison table the owner wanted back.
  const expByDate = db.prepare(
    "SELECT bill_date AS d, COALESCE(SUM(amount_total),0) AS amt FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ? GROUP BY bill_date"
  ).all(branchId, start, end) as Array<{ d: string; amt: number }>;
  const revByDate = new Map(incDays.map((r) => [r.d, round2(r.amt)]));
  const expByDateMap = new Map(expByDate.map((r) => [r.d, round2(r.amt)]));
  const allDates = [...new Set([...revByDate.keys(), ...expByDateMap.keys()])].sort();
  let bal = 0;
  const dailyRows = allDates.map((d) => {
    const inc = revByDate.get(d) ?? 0;
    const exp = expByDateMap.get(d) ?? 0;
    const net = round2(inc - exp);
    bal = round2(bal + net);
    return { date: d, revenue: inc, expense: exp, net, balance: bal };
  });

  // Revenue split by payment channel for the period (owner 2026-06-21).
  // Comes from accounta_income source='shift_close' rows — populated going
  // forward by the close-form breakdown. Channel-less backfilled history
  // falls under "(ไม่ระบุช่องทาง)".
  const channelRows = db.prepare(
    `SELECT COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)') AS channel, COALESCE(SUM(amount),0) AS amount
       FROM accounta_income
      WHERE branch_id = ? AND income_date BETWEEN ? AND ?
      GROUP BY COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)')
      ORDER BY amount DESC`
  ).all(branchId, start, end) as Array<{ channel: string; amount: number }>;
  const incomeByChannel = channelRows.map((r) => ({ channel: r.channel, amount: round2(r.amount) }));

  // Cash received in the period (cash basis): non-credit income recognised in
  // the period + credit (AR) collected in the period (by settled_date).
  const cashRow = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN is_outstanding = 0 AND income_date BETWEEN ? AND ? THEN amount ELSE 0 END), 0) +
       COALESCE(SUM(CASE WHEN is_outstanding = 1 AND settled_date BETWEEN ? AND ? THEN amount ELSE 0 END), 0) AS cash
       FROM accounta_income WHERE branch_id = ?`
  ).get(start, end, start, end, branchId) as { cash: number };
  const cashReceived = round2(cashRow.cash);
  const outstandingTotal = receivablesTotal(branchId);
  const outstandingByEntity = receivablesByEntity(branchId);

  // Per-day income rows (date + channel) so the client can show the
  // selected day's income detail in the drill-down panel.
  const incomeRows = (db.prepare(
    `SELECT income_date AS date, COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)') AS channel, COALESCE(SUM(amount),0) AS amount
       FROM accounta_income WHERE branch_id = ? AND income_date BETWEEN ? AND ?
      GROUP BY income_date, COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)')`
  ).all(branchId, start, end) as Array<{ date: string; channel: string; amount: number }>)
    .map((r) => ({ date: r.date, channel: r.channel, amount: round2(r.amount) }));

  // Expense analysis — by vendor and by payment method (confirmed only).
  const byVendor = (db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(vendor_name),''),'(ไม่ระบุผู้จำหน่าย)') AS vendor, COALESCE(SUM(amount_total),0) AS amount
       FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ?
      GROUP BY vendor ORDER BY amount DESC`
  ).all(branchId, start, end) as Array<{ vendor: string; amount: number }>)
    .map((r) => ({ vendor: r.vendor, amount: round2(r.amount) }));
  const byPaymentMethod = (db.prepare(
    `SELECT COALESCE(NULLIF(TRIM(payment_method),''),'(ไม่ระบุวิธีจ่าย)') AS method, COALESCE(SUM(amount_total),0) AS amount
       FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ?
      GROUP BY method ORDER BY amount DESC`
  ).all(branchId, start, end) as Array<{ method: string; amount: number }>)
    .map((r) => ({ method: r.method, amount: round2(r.amount) }));

  return {
    period, start, end, label,
    revenue, expense, net: round2(revenue - expense),
    inputVat, outputVat, vatPayable, vatRegistered,
    daysWithRevenue, avgPerDay, avgWeekday, avgWeekend,
    forecast, categories, uncategorized, dailyRows, incomeByChannel,
    incomeRows, byVendor, byPaymentMethod,
    cashReceived, outstandingTotal, outstandingByEntity
  };
}

// ── Dashboard redesign helpers (owner 2026-06-22, PEAK-style) ──────

export type MonthlyTrendRow = { month: number; revenue: number; expense: number; profit: number };

/** 12-month revenue (shift-close totals) vs expense (confirmed bills) + profit,
 *  for one branch + calendar year — feeds the year combo chart. */
export function monthlyTrend(branchId: number, year: number): MonthlyTrendRow[] {
  const db = getDb();
  const y = String(year);
  const rev = db.prepare(
    "SELECT CAST(substr(date,6,2) AS INTEGER) AS m, COALESCE(SUM(revenue),0) AS amt FROM branch_daily_revenue WHERE branch_id = ? AND substr(date,1,4) = ? GROUP BY m"
  ).all(branchId, y) as Array<{ m: number; amt: number }>;
  const exp = db.prepare(
    "SELECT CAST(substr(bill_date,6,2) AS INTEGER) AS m, COALESCE(SUM(amount_total),0) AS amt FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND substr(bill_date,1,4) = ? GROUP BY m"
  ).all(branchId, y) as Array<{ m: number; amt: number }>;
  const rmap = new Map(rev.map((r) => [r.m, round2(r.amt)]));
  const emap = new Map(exp.map((r) => [r.m, round2(r.amt)]));
  const out: MonthlyTrendRow[] = [];
  for (let m = 1; m <= 12; m++) {
    const revenue = rmap.get(m) ?? 0;
    const expense = emap.get(m) ?? 0;
    out.push({ month: m, revenue, expense, profit: round2(revenue - expense) });
  }
  return out;
}

export type AccountaPayables = {
  whtUnpaid: number;          // ภาษีหัก ณ ที่จ่าย รอนำส่ง (org-wide — payroll posts at branch NULL)
  ssoUnpaid: number;          // ประกันสังคม รอนำส่ง (org-wide)
  branchUnpaidTotal: number;  // บิลค้างจ่ายอื่นของสาขานี้
  branchUnpaidCount: number;
};

/** Outstanding payables for the tax/payable cards. WHT + SSO are company-level
 *  (payroll posts them at branch_id NULL), shown as "ทั้งบริษัท"; other unpaid
 *  bills are scoped to this branch. */
export function accountaPayables(branchId: number): AccountaPayables {
  const db = getDb();
  const wht = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND category = 'ภาษีหัก ณ ที่จ่าย'"
  ).get() as { s: number };
  const sso = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND category = 'ประกันสังคม'"
  ).get() as { s: number };
  const bill = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s, COUNT(*) AS n FROM accounta_expenses WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND branch_id = ? AND COALESCE(category,'') NOT IN ('ภาษีหัก ณ ที่จ่าย','ประกันสังคม')"
  ).get(branchId) as { s: number; n: number };
  return {
    whtUnpaid: round2(wht.s), ssoUnpaid: round2(sso.s),
    branchUnpaidTotal: round2(bill.s), branchUnpaidCount: bill.n
  };
}

// ── Cash / bank balance tracking (owner 2026-06-22) ────────────────
// Manual-snapshot balances (we don't tag transactions to accounts). The owner
// records each account's balance + as-of date; the dashboard shows a total.

export type CashAccount = {
  id: number; branch_id: number | null; name: string; type: string;
  bank_label: string | null; balance: number; balance_as_of: string | null;
  sort_order: number; active: number; note: string | null;
};

/** Accounts visible to a branch = its own + company-wide (branch_id NULL). */
export function listCashAccounts(branchId: number, includeInactive = false): CashAccount[] {
  const where = includeInactive ? "" : "AND active = 1";
  return getDb().prepare(
    `SELECT id, branch_id, name, type, bank_label, balance, balance_as_of, sort_order, active, note
       FROM accounta_cash_accounts
      WHERE (branch_id = ? OR branch_id IS NULL) ${where}
      ORDER BY active DESC, sort_order, name COLLATE NOCASE`
  ).all(branchId) as CashAccount[];
}

export function cashAccountsTotal(branchId: number): number {
  const r = getDb().prepare(
    "SELECT COALESCE(SUM(balance),0) AS s FROM accounta_cash_accounts WHERE (branch_id = ? OR branch_id IS NULL) AND active = 1"
  ).get(branchId) as { s: number };
  return round2(r.s);
}

export function createCashAccount(d: {
  branchId: number | null; name: string; type: string; bankLabel?: string | null;
  balance?: number; balanceAsOf?: string | null; note?: string | null; createdBy: number;
}): number {
  const db = getDb();
  const max = (db.prepare(
    "SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_cash_accounts WHERE branch_id IS ?"
  ).get(d.branchId) as { m: number }).m;
  return Number(db.prepare(
    `INSERT INTO accounta_cash_accounts (branch_id, name, type, bank_label, balance, balance_as_of, sort_order, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    d.branchId, d.name.trim(), d.type === "bank" ? "bank" : "cash", d.bankLabel ?? null,
    round2(d.balance ?? 0), d.balanceAsOf ?? null, max + 10, d.note ?? null, d.createdBy
  ).lastInsertRowid);
}

/** Update editable fields; branchId guards that the account belongs to this
 *  branch or is company-wide (NULL). Only provided keys change. */
export function updateCashAccount(id: number, branchId: number, d: {
  name?: string; type?: string; bankLabel?: string | null;
  balance?: number; balanceAsOf?: string | null; active?: boolean; note?: string | null;
}): boolean {
  const db = getDb();
  const owned = db.prepare(
    "SELECT id FROM accounta_cash_accounts WHERE id = ? AND (branch_id = ? OR branch_id IS NULL)"
  ).get(id, branchId);
  if (!owned) return false;
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  if (d.name !== undefined) { sets.push("name = ?"); vals.push(d.name.trim()); }
  if (d.type !== undefined) { sets.push("type = ?"); vals.push(d.type === "bank" ? "bank" : "cash"); }
  if (d.bankLabel !== undefined) { sets.push("bank_label = ?"); vals.push(d.bankLabel); }
  if (d.balance !== undefined) { sets.push("balance = ?"); vals.push(round2(d.balance)); }
  if (d.balanceAsOf !== undefined) { sets.push("balance_as_of = ?"); vals.push(d.balanceAsOf); }
  if (d.active !== undefined) { sets.push("active = ?"); vals.push(d.active ? 1 : 0); }
  if (d.note !== undefined) { sets.push("note = ?"); vals.push(d.note); }
  if (sets.length === 0) return false;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(id);
  return db.prepare(`UPDATE accounta_cash_accounts SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

export function deleteCashAccount(id: number, branchId: number): boolean {
  return getDb().prepare(
    "DELETE FROM accounta_cash_accounts WHERE id = ? AND (branch_id = ? OR branch_id IS NULL)"
  ).run(id, branchId).changes > 0;
}

// ── Material-purchase quota (owner 2026-06-21) ─────────────────────
// Monthly raw-material budget = target sales (X) × max-material-% (Y).
// Buying once a week on a chosen weekday; today's quota redistributes the
// leftover budget (budget − GD spent this month) over the purchase days
// still left in the month. GD = the "ต้นทุนสินค้า/วัตถุดิบ" category (code GD).

export type MaterialQuota = {
  targetSales: number; budgetPct: number; weekday: number; weekdayLabel: string;
  monthBudget: number; spentThisMonth: number; remainingBudget: number;
  otherDaysLeft: number; todayIsPurchaseDay: boolean; quotaToday: number;
};

const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export function materialPurchaseQuota(branchId: number, date: string): MaterialQuota | null {
  const db = getDb();
  const b = db.prepare(
    "SELECT material_quota_enabled AS en, material_target_sales AS x, material_budget_pct AS y, material_purchase_weekday AS wd FROM branches WHERE id = ?"
  ).get(branchId) as { en: number; x: number; y: number; wd: number } | undefined;
  if (!b || !b.en) return null;
  const month = date.slice(0, 7);
  const gd = db.prepare("SELECT name FROM accounta_categories WHERE code = 'GD'")
    .get() as { name: string } | undefined;
  const gdName = gd?.name ?? "ต้นทุนสินค้า/วัตถุดิบ";
  const spentRow = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND substr(bill_date,1,7) = ? AND category = ?"
  ).get(branchId, month, gdName) as { s: number };
  const monthBudget = round2(b.x * (b.y / 100));
  const spent = round2(spentRow.s);
  const remainingBudget = round2(monthBudget - spent);
  // Quota rule (owner 2026-06-21, revised): buying is allowed EVERY day.
  //   • On the chosen weekday (the planned order day) → a flat daily rate =
  //     monthly budget ÷ 30 (e.g. 240,000/30 = 8,000 every Monday).
  //   • On any other day → leftover budget (X×Y% − spent) spread over the
  //     remaining NON-weekday days of the month.
  const [yy, mm, dd] = date.split("-").map(Number);
  const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const todayIsPurchaseDay = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() === b.wd;
  let otherDaysLeft = 0;
  for (let day = dd; day <= lastDay; day++) {
    if (new Date(Date.UTC(yy, mm - 1, day)).getUTCDay() !== b.wd) otherDaysLeft += 1;
  }
  const quotaToday = todayIsPurchaseDay
    ? round2(monthBudget / 30)
    : (otherDaysLeft > 0 ? Math.max(0, round2(remainingBudget / otherDaysLeft)) : 0);
  return {
    targetSales: round2(b.x), budgetPct: b.y, weekday: b.wd,
    weekdayLabel: TH_WEEKDAYS[b.wd] ?? "",
    monthBudget, spentThisMonth: spent, remainingBudget,
    otherDaysLeft, todayIsPurchaseDay, quotaToday
  };
}

/** Confirmed expenses in a date range (for the dashboard's editable list). */
export function listExpensesInRange(branchId: number, start: string, end: string): ExpenseRow[] {
  const r = getDb().prepare(
    `${SELECT_EXPENSE} WHERE e.review_status = 'confirmed' AND e.branch_id = ? AND e.bill_date BETWEEN ? AND ? ORDER BY e.bill_date DESC, e.id DESC`
  ).all(branchId, start, end) as RawExpense[];
  return r.map(shape);
}

// ── OCR usage log ──────────────────────────────────────────────────

export function logOcrUsage(d: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  expenseId?: number | null;
  userId: number;
}): number {
  const cost = ocrCostBaht(d.model, d.inputTokens, d.outputTokens);
  const info = getDb().prepare(`
    INSERT INTO accounta_ocr_usage (model, input_tokens, output_tokens, cost_baht, expense_id, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(d.model, d.inputTokens, d.outputTokens, cost, d.expenseId ?? null, d.userId);
  return Number(info.lastInsertRowid);
}

/** OCR spend this calendar month + all-time, for the toggle UI counter. */
export function ocrUsageStats(month: string): {
  monthCount: number; monthBaht: number; totalCount: number; totalBaht: number;
} {
  const db = getDb();
  const m = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(cost_baht),0) AS b
      FROM accounta_ocr_usage WHERE substr(created_at,1,7) = ?
  `).get(month) as { c: number; b: number };
  const t = db.prepare(
    "SELECT COUNT(*) AS c, COALESCE(SUM(cost_baht),0) AS b FROM accounta_ocr_usage"
  ).get() as { c: number; b: number };
  return {
    monthCount: m.c, monthBaht: round2(m.b),
    totalCount: t.c, totalBaht: round2(t.b)
  };
}
