// ── ACCOUNTA — data access (SQLite, server-only) ───────────────────
// Expense ledger (รายจ่าย) + vendor master + OCR usage log. Shared across
// every admin granted accounta.manage (route guards enforce that). Two
// time axes power the accrual-vs-cashflow split: bill_date (ตามบิล) and
// paid_date (กระแสเงินสด). See lib/accounta.ts for the pure helpers.

import { getDb } from "./db";
import {
  splitVat, round2, ocrCostBaht, CAPEX_CATEGORY_NAME,
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
  capex_bucket: string | null;    // FEASIBILITY investment bucket when category is CapEx
  ocr_tax_id: string | null;      // 13-digit เลขผู้เสียภาษี OCR read off a LINE bill
  description: string | null;
  amount_total: number;
  has_tax_invoice: number;
  vat_amount: number;
  base_amount: number;
  wht_rate: number;               // หัก ณ ที่จ่าย rate (0/.01/.03/.05)
  wht_amount: number;             // = base_amount × wht_rate (ยอดนำส่ง ภ.ง.ด.3)
  awaiting_doc: number;           // 1 = จ่าย/ลงบัญชีแล้วแต่ยังไม่ได้รับเอกสาร (รอเอกสาร)
  payment_status: PaymentStatus;
  payment_method: string | null;
  paid_date: string | null;
  due_date: string | null;
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
  is_vat: number;
  is_revenue: number;
};

export type IncomeInput = {
  branch_id: number | null;
  company_id: number | null;
  income_date: string;
  channel: string | null;
  amount: number;
  note: string | null;
  /** carries 7% output VAT (true for sales; false for non-revenue inflows like
   *  loans). Defaults to true so existing callers keep the sales behavior. */
  is_vat?: boolean;
  /** counts as ยอดขาย/sales (true). false for financing inflows (loans) that are
   *  money-in but not sales. Defaults to true. */
  is_revenue?: boolean;
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
           i.income_date, i.channel, i.amount, i.note, i.source, i.is_outstanding, i.settled_date,
           COALESCE(i.is_vat,1) AS is_vat, COALESCE(i.is_revenue,1) AS is_revenue
      FROM accounta_income i
      LEFT JOIN branches b  ON b.id = i.branch_id
      LEFT JOIN companies c ON c.id = i.company_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY i.income_date DESC, i.id DESC`;
  return getDb().prepare(sql).all(...args) as IncomeRow[];
}

export function createIncome(userId: number, d: IncomeInput): number {
  const info = getDb().prepare(`
    INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, is_vat, is_revenue, created_by)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(d.branch_id, d.company_id, d.income_date, d.channel, round2(Number(d.amount) || 0), d.note?.trim() || null, d.is_vat === false ? 0 : 1, d.is_revenue === false ? 0 : 1, userId);
  return Number(info.lastInsertRowid);
}

export function updateIncome(id: number, d: IncomeInput): boolean {
  const info = getDb().prepare(`
    UPDATE accounta_income SET branch_id = ?, company_id = ?, income_date = ?, channel = ?,
      amount = ?, note = ?, is_vat = ?, is_revenue = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(d.branch_id, d.company_id, d.income_date, d.channel, round2(Number(d.amount) || 0), d.note?.trim() || null, d.is_vat === false ? 0 : 1, d.is_revenue === false ? 0 : 1, id);
  return info.changes > 0;
}

export function deleteIncome(id: number): boolean {
  return getDb().prepare("DELETE FROM accounta_income WHERE id = ?").run(id).changes > 0;
}

export function getIncome(id: number): IncomeRow | null {
  return listIncome().find((r) => r.id === id) ?? getDb().prepare(`
    SELECT i.id, i.branch_id, b.name AS branch_name, i.company_id, c.name_th AS company_name,
           i.income_date, i.channel, i.amount, i.note, i.source, i.is_outstanding, i.settled_date,
           COALESCE(i.is_vat,1) AS is_vat, COALESCE(i.is_revenue,1) AS is_revenue
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
  // Post to the period's branch so the รายจ่าย shows on that branch's daybook
  // (owner 2026-06-22 — was branch NULL, so per-branch dashboards never saw it).
  // Legacy all-branch periods (branch_id NULL) still post org-level; company_id
  // comes from the branch, else the single company when there's exactly one.
  const period = db.prepare(
    "SELECT id, branch_id, period_start, period_end, pay_date FROM payroll_periods WHERE id = ?"
  ).get(periodId) as { id: number; branch_id: number | null; period_start: string; period_end: string; pay_date: string | null } | undefined;
  if (!period) return { salaries: 0, tax: 0, sso: 0 };
  const branchId: number | null = period.branch_id ?? null;
  let companyId: number | null = null;
  if (branchId != null) {
    companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?").get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  } else {
    const companies = db.prepare("SELECT id FROM companies").all() as Array<{ id: number }>;
    companyId = companies.length === 1 ? companies[0].id : null;
  }
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

// Vendors/suppliers are ONE branch-scoped master shared with INVENTA, stored in
// inventa_suppliers (owner 2026-06-25). ACCOUNTA reads/writes the same per-branch
// list so a คู่ค้า added in either module shows in both.
export function listVendors(branchId: number | null): VendorRow[] {
  if (branchId == null) return [];
  return getDb().prepare(
    "SELECT id, name, tax_id, category FROM inventa_suppliers WHERE active = 1 AND branch_id = ? ORDER BY name COLLATE NOCASE"
  ).all(branchId) as VendorRow[];
}

/** Most-recent non-empty รายละเอียด per vendor for a branch — so the expense
 *  form can prefill the description the vendor was last recorded with (owner
 *  2026-07-05). Rows are newest-first; the first hit per vendor wins. */
export function vendorLastDescriptions(branchId: number | null): Record<string, string> {
  if (branchId == null) return {};
  const rows = getDb().prepare(
    `SELECT vendor_name, description FROM accounta_expenses
     WHERE branch_id = ? AND vendor_name IS NOT NULL
       AND description IS NOT NULL AND TRIM(description) != ''
     ORDER BY bill_date DESC, id DESC`
  ).all(branchId) as Array<{ vendor_name: string; description: string }>;
  const map: Record<string, string> = {};
  for (const r of rows) if (!(r.vendor_name in map)) map[r.vendor_name] = r.description;
  return map;
}

export function createVendor(
  branchId: number,
  userId: number,
  d: { name: string; tax_id?: string | null; category?: string | null; pay_cycle?: string | null; needsReview?: boolean }
): number {
  const name = d.name.trim();
  const cat = d.category?.trim() || null;
  const tax = d.tax_id?.trim() || null;
  const cycle = d.pay_cycle?.trim() || null;
  // De-dup on (branch, name) case-insensitive so the picker doesn't accrue twins.
  const existing = getDb().prepare(
    "SELECT id FROM inventa_suppliers WHERE active = 1 AND branch_id = ? AND name = ? COLLATE NOCASE"
  ).get(branchId, name) as { id: number } | undefined;
  if (existing) {
    // "Learn from edits": remember a corrected category/tax_id/รอบจ่าย for next
    // time. Only overwrite with a real value — never blank a good one (owner 2026-06-18).
    if (cat || tax || cycle) {
      getDb().prepare(
        "UPDATE inventa_suppliers SET category = COALESCE(?, category), tax_id = COALESCE(?, tax_id), pay_cycle = COALESCE(?, pay_cycle) WHERE id = ?"
      ).run(cat, tax, cycle, existing.id);
    }
    return existing.id;
  }
  const info = getDb().prepare(`
    INSERT INTO inventa_suppliers (branch_id, name, tax_id, category, pay_cycle, created_by, display_order, active, needs_review)
    VALUES (?, ?, ?, ?, ?, ?, 100, 1, ?)
  `).run(branchId, name, tax, cat, cycle, userId, d.needsReview ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export type VendorManageRow = { id: number; name: string; tax_id: string | null; category: string | null; needs_review: number };

/** Full vendor list for the manage page (incl. id + needs_review flag). */
export function listVendorsManage(branchId: number | null): VendorManageRow[] {
  if (branchId == null) return [];
  return getDb().prepare(
    `SELECT id, name, tax_id, category, COALESCE(needs_review,0) AS needs_review
       FROM inventa_suppliers WHERE active = 1 AND branch_id = ?
      ORDER BY needs_review DESC, name COLLATE NOCASE`
  ).all(branchId) as VendorManageRow[];
}

/** Edit a vendor in this branch (rename / fix tax id / category). Clears the
 *  needs_review flag — an admin has now looked at it. */
export function updateVendor(
  id: number, branchId: number,
  d: { name?: string; tax_id?: string | null; category?: string | null; pay_cycle?: string | null }
): boolean {
  const sets: string[] = ["needs_review = 0"]; const vals: Array<string | number | null> = [];
  if (d.name !== undefined) { sets.push("name = ?"); vals.push(d.name.trim()); }
  if (d.tax_id !== undefined) { sets.push("tax_id = ?"); vals.push(d.tax_id?.trim() || null); }
  if (d.category !== undefined) { sets.push("category = ?"); vals.push(d.category?.trim() || null); }
  if (d.pay_cycle !== undefined) { sets.push("pay_cycle = ?"); vals.push(d.pay_cycle?.trim() || null); }
  vals.push(id, branchId);
  return getDb().prepare(
    `UPDATE inventa_suppliers SET ${sets.join(", ")} WHERE id = ? AND branch_id = ?`
  ).run(...vals).changes > 0;
}

export function deleteVendor(id: number, branchId: number): boolean {
  return getDb().prepare(
    "DELETE FROM inventa_suppliers WHERE id = ? AND branch_id = ?"
  ).run(id, branchId).changes > 0;
}

/** Look up an active vendor by its 13-digit tax id within a branch (digits-only
 *  compare). The most reliable OCR match for repeat vendors — the printed tax id
 *  reads cleanly even when the name is garbled (owner 2026-06-26). */
export function findVendorByTaxId(taxId: string, branchId: number | null): VendorRow | null {
  const t = (taxId || "").replace(/\D/g, "");
  if (t.length < 10 || branchId == null) return null;
  return getDb().prepare(
    `SELECT id, name, tax_id, category FROM inventa_suppliers
      WHERE active = 1 AND branch_id = ?
        AND REPLACE(REPLACE(COALESCE(tax_id,''),'-',''),' ','') = ?`
  ).get(branchId, t) as VendorRow | undefined ?? null;
}

/** Look up an active vendor by name within a branch (case-insensitive). Used to
 *  auto-fill the remembered category/tax_id when OCR reads a known vendor. */
export function findVendorByName(name: string, branchId: number | null): VendorRow | null {
  const v = name.trim();
  if (!v || branchId == null) return null;
  return getDb().prepare(
    "SELECT id, name, tax_id, category FROM inventa_suppliers WHERE active = 1 AND branch_id = ? AND name = ? COLLATE NOCASE"
  ).get(branchId, v) as VendorRow | undefined ?? null;
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

/** Branch-scoped LINE-submitted drafts awaiting review — feeds the daily
 *  pending-requests digest (owner 2026-06-23). Oldest first. */
export function listDraftExpensesForBranch(branchId: number): Array<{
  id: number; vendor_name: string | null; amount_total: number; bill_date: string | null; created_at: string;
}> {
  return getDb().prepare(
    `SELECT id, vendor_name, amount_total, bill_date, created_at
     FROM accounta_expenses WHERE review_status = 'draft' AND branch_id = ?
     ORDER BY created_at ASC`
  ).all(branchId) as Array<{ id: number; vendor_name: string | null; amount_total: number; bill_date: string | null; created_at: string }>;
}

/** Branch-scoped confirmed bills still unpaid (ค้างชำระ) — feeds the daily
 *  digest (owner 2026-06-24). Excludes the company-level WHT/SSO postings;
 *  oldest bill first so the most overdue reads at the top. */
export function listUnpaidExpensesForBranch(branchId: number): Array<{
  id: number; vendor_name: string | null; amount_total: number; bill_date: string | null; due_date: string | null;
}> {
  return getDb().prepare(
    `SELECT id, vendor_name, amount_total, bill_date, due_date
     FROM accounta_expenses
     WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND branch_id = ?
       AND COALESCE(category,'') NOT IN ('ภาษีหัก ณ ที่จ่าย','ประกันสังคม')
     ORDER BY due_date IS NULL, due_date ASC, bill_date ASC, id ASC`
  ).all(branchId) as Array<{ id: number; vendor_name: string | null; amount_total: number; bill_date: string | null; due_date: string | null }>;
}

/** Mark one confirmed-unpaid bill as ชำระแล้ว with the cash-out date (owner
 *  2026-06-27). Mirrors settleReceivable on the AP side: only flips a row that
 *  is still unpaid + confirmed in this branch, so a double-tap or stale id is a
 *  no-op. Clears due_date (no longer pending). Returns false if nothing matched. */
export function markExpensePaid(
  id: number, branchId: number, paidDate: string, method?: string | null
): boolean {
  return getDb().prepare(
    `UPDATE accounta_expenses
        SET payment_status = 'paid', paid_date = ?,
            payment_method = COALESCE(?, payment_method), due_date = NULL,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND branch_id = ? AND review_status = 'confirmed' AND payment_status = 'unpaid'`
  ).run(paidDate, method ?? null, id, branchId).changes > 0;
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

/** Sender-filled detail from the LINE bill-detail form (owner 2026-06-29) —
 *  updates a DRAFT in place and keeps it 'draft' for admin review. Re-derives
 *  base from total/vat. Returns false if the row isn't a draft (already reviewed
 *  or gone). Branch attribution is untouched (set from the sender at ingest). */
export function submitLineBillDetail(id: number, d: {
  doc_type: string | null; vendor_name: string | null; ocr_tax_id: string | null;
  category: string | null; amount_total: number; has_tax_invoice: boolean;
  vat_amount: number; note: string | null;
}): boolean {
  const row = getDb().prepare("SELECT review_status FROM accounta_expenses WHERE id = ?")
    .get(id) as { review_status: string } | undefined;
  if (!row || row.review_status !== "draft") return false;
  const total = round2(d.amount_total);
  const vat = d.has_tax_invoice ? round2(d.vat_amount) : 0;
  const base = round2(total - vat);
  return getDb().prepare(`
    UPDATE accounta_expenses SET
      doc_type = ?, vendor_name = ?, ocr_tax_id = ?, category = ?,
      amount_total = ?, has_tax_invoice = ?, vat_amount = ?, base_amount = ?,
      note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND review_status = 'draft'
  `).run(d.doc_type, d.vendor_name?.trim() || null, d.ocr_tax_id?.trim() || null, d.category,
    total, d.has_tax_invoice ? 1 : 0, vat, base, d.note?.trim() || null, id).changes > 0;
}

const SENDER_VERIFY_RE = /\s*·\s*ผู้ส่ง(ยืนยันว่าถูกต้อง|แจ้งว่าไม่ตรง \(รอแก้ไข\))/g;

/** Record a LINE sender's reply to the "ตรวจสอบผู้จำหน่าย/ยอด" verify card on
 *  their own draft bill (owner 2026-06-27). ok=true → looks right (admin still
 *  confirms it into the ledger); ok=false → flag it so the admin fixes it first.
 *  Stored as a tag on the note; review_status stays 'draft'. Scoped to the
 *  draft's own submitter so one staff member can't touch another's bill.
 *  Returns false if the row isn't a draft they own. */
export function markDraftSenderVerify(id: number, userId: number, ok: boolean): boolean {
  const e = getDb().prepare(
    "SELECT note, review_status, created_by FROM accounta_expenses WHERE id = ?"
  ).get(id) as { note: string | null; review_status: string; created_by: number | null } | undefined;
  if (!e || e.review_status !== "draft" || e.created_by !== userId) return false;
  const tag = ok ? "ผู้ส่งยืนยันว่าถูกต้อง" : "ผู้ส่งแจ้งว่าไม่ตรง (รอแก้ไข)";
  // Strip any previous verify tag so a re-tap replaces (not stacks) it.
  const base = (e.note ?? "").replace(SENDER_VERIFY_RE, "").trim();
  const note = base ? `${base} · ${tag}` : tag;
  getDb().prepare("UPDATE accounta_expenses SET note = ? WHERE id = ?").run(note, id);
  return true;
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
  // WHT is computed on the ex-VAT base × rate — never trust a client amount.
  const whtRate = Number(d.wht_rate) || 0;
  const whtAmount = round2(base * whtRate);
  return {
    ...d,
    amount_total: total,
    vat_amount: vat,
    base_amount: base,
    wht_rate: whtRate,
    wht_amount: whtAmount,
    awaiting_doc: !!d.awaiting_doc,
    paid_date: d.payment_status === "paid" ? (d.paid_date || d.bill_date) : null,
    // due date is only meaningful for unpaid (credit-term) bills.
    due_date: d.payment_status === "unpaid" ? (d.due_date || null) : null,
    // capex_bucket only applies to CapEx bills — drop a stale value if the
    // category was changed away, so it can't keep feeding FEASIBILITY.
    capex_bucket: d.category === CAPEX_CATEGORY_NAME ? (d.capex_bucket || null) : null
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
      branch_id, company_id, bill_date, vendor_id, vendor_name, doc_type, category, capex_bucket, ocr_tax_id, description,
      amount_total, has_tax_invoice, vat_amount, base_amount, wht_rate, wht_amount, awaiting_doc,
      payment_status, payment_method, paid_date, due_date,
      ocr_source, ocr_cost_baht, review_status, line_message_id, note, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?)
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.doc_type, d.category, d.capex_bucket ?? null, d.ocr_tax_id ?? null, d.description?.trim() || null,
    d.amount_total, d.has_tax_invoice ? 1 : 0, d.vat_amount, d.base_amount, d.wht_rate ?? 0, d.wht_amount ?? 0, d.awaiting_doc ? 1 : 0,
    d.payment_status, d.payment_method, d.paid_date, d.due_date,
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
      doc_type = ?, category = ?, capex_bucket = ?, description = ?, amount_total = ?, has_tax_invoice = ?,
      vat_amount = ?, base_amount = ?, wht_rate = ?, wht_amount = ?, awaiting_doc = ?, payment_status = ?, payment_method = ?,
      paid_date = ?, due_date = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.doc_type, d.category, d.capex_bucket ?? null, d.description?.trim() || null, d.amount_total, d.has_tax_invoice ? 1 : 0,
    d.vat_amount, d.base_amount, d.wht_rate ?? 0, d.wht_amount ?? 0, d.awaiting_doc ? 1 : 0, d.payment_status, d.payment_method,
    d.paid_date, d.due_date, d.note?.trim() || null, id
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
  revenue: number; salesRevenue: number; financing: number; expense: number; net: number;
  inputVat: number; outputVat: number; vatPayable: number; vatRegistered: boolean;
  daysWithRevenue: number; avgPerDay: number; avgWeekday: number; avgWeekend: number;
  salesPerBillMonth: number | null; salesPerBillYear: number | null;
  forecast: number | null;
  categories: LedgerCatItem[];
  uncategorized: number;
  dailyRows: Array<{ date: string; revenue: number; financing: number; expense: number; net: number; balance: number; billCount: number | null }>;
  incomeByChannel: Array<{ channel: string; amount: number }>;
  incomeRows: Array<{ date: string; channel: string; amount: number; ar: number; cash: number }>;
  byVendor: Array<{ vendor: string; amount: number }>;
  byPaymentMethod: Array<{ method: string; amount: number }>;
  cashReceived: number;                                          // เงินเข้าจริงในช่วง (cash basis)
  outstandingTotal: number;                                      // ลูกหนี้ค้างชำระคงค้าง (สะสม)
  outstandingByEntity: Array<{ channel: string; amount: number; count: number }>;
};

// Every YYYY-MM-DD in [start, end] inclusive — so the daybook table can show
// every day of a month even when a day has no activity (owner 2026-06-28).
function enumDays(start: string, end: string): string[] {
  const toT = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  const out: string[] = [];
  const endT = toT(end);
  for (let t = toT(start), i = 0; t <= endT && i < 400; t += 86400000, i++) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

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

  // Revenue by day — the ACCOUNTA ledger view (owner 2026-06-25): sum the
  // accounta_income rows so manual per-channel edits reflect in the headline.
  // Supersede rule: once a day has a per-channel breakdown, the channel-less
  // shift_close lump is redundant — exclude it so the breakdown replaces it
  // (no double-count). Days with NO ledger rows fall back to the close total in
  // branch_daily_revenue (preserves pre-mirror history).
  // `total` = all money-in (รายรับ/cash-in, incl financing). `salesTotal` =
  // ยอดขาย only (is_revenue=1) — loans are money-in but not sales (owner 2026-06-28).
  // `channelled` counts only SALES per-channel rows so a loan never trips the
  // shift-close lump supersede.
  const incLedger = db.prepare(
    `SELECT income_date AS d,
            COALESCE(SUM(amount),0) AS total,
            COALESCE(SUM(CASE WHEN COALESCE(is_revenue,1)=1 THEN amount ELSE 0 END),0) AS salesTotal,
            COALESCE(SUM(CASE WHEN COALESCE(NULLIF(TRIM(channel),''),NULL) IS NOT NULL AND COALESCE(is_revenue,1)=1 THEN 1 ELSE 0 END),0) AS channelled,
            COALESCE(SUM(CASE WHEN source='shift_close' AND COALESCE(NULLIF(TRIM(channel),''),NULL) IS NULL THEN amount ELSE 0 END),0) AS lump
       FROM accounta_income
      WHERE branch_id = ? AND income_date BETWEEN ? AND ?
      GROUP BY income_date`
  ).all(branchId, start, end) as Array<{ d: string; total: number; salesTotal: number; channelled: number; lump: number }>;
  const ledgerByDate = new Map(incLedger.map((r) => [r.d, r.channelled > 0 ? round2(r.total - r.lump) : round2(r.total)]));
  const salesByDate = new Map(incLedger.map((r) => [r.d, r.channelled > 0 ? round2(r.salesTotal - r.lump) : round2(r.salesTotal)]));
  const bdrByDate = new Map((db.prepare(
    "SELECT date AS d, revenue AS amt FROM branch_daily_revenue WHERE branch_id = ? AND date BETWEEN ? AND ?"
  ).all(branchId, start, end) as Array<{ d: string; amt: number }>).map((r) => [r.d, round2(r.amt)]));
  const incDays = [...new Set([...ledgerByDate.keys(), ...bdrByDate.keys()])]
    .map((d) => ({ d, amt: ledgerByDate.has(d) ? ledgerByDate.get(d)! : (bdrByDate.get(d) ?? 0) }))
    .filter((r) => r.amt !== 0)
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  let revenue = 0;
  for (const r of incDays) revenue += r.amt;
  revenue = round2(revenue);
  // Sales-only days drive the ยอดขาย averages + forecast (loans excluded). bdr
  // (shift-close) is always sales, so it's the fallback for pre-mirror days.
  const salesDays = [...new Set([...salesByDate.keys(), ...bdrByDate.keys()])]
    .map((d) => ({ d, amt: salesByDate.has(d) ? salesByDate.get(d)! : (bdrByDate.get(d) ?? 0) }))
    .filter((r) => r.amt !== 0)
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  let salesRevenue = 0, wkdaySum = 0, wkdayN = 0, wkendSum = 0, wkendN = 0;
  for (const r of salesDays) {
    salesRevenue += r.amt;
    if (isWeekend(r.d)) { wkendSum += r.amt; wkendN += 1; } else { wkdaySum += r.amt; wkdayN += 1; }
  }
  salesRevenue = round2(salesRevenue);
  const daysWithRevenue = salesDays.length;
  const avgPerDay = daysWithRevenue ? round2(salesRevenue / daysWithRevenue) : 0;
  const avgWeekday = wkdayN ? round2(wkdaySum / wkdayN) : 0;
  const avgWeekend = wkendN ? round2(wkendSum / wkendN) : 0;

  // ยอดขายต่อบิล (owner 2026-06-25): close revenue ÷ จำนวนบิล, over the days that
  // have a bill count. Month = anchor's month, year = anchor's year — independent
  // of the week/month/year view so both figures always show.
  const perBill = (dateFilter: string, arg: string): number | null => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(revenue),0) AS rev, COALESCE(SUM(bill_count),0) AS bills
         FROM branch_daily_revenue
        WHERE branch_id = ? AND bill_count IS NOT NULL AND bill_count > 0 AND ${dateFilter}`
    ).get(branchId, arg) as { rev: number; bills: number };
    return row.bills > 0 ? round2(row.rev / row.bills) : null;
  };
  const salesPerBillMonth = perBill("substr(date,1,7) = ?", anchor.slice(0, 7));
  const salesPerBillYear = perBill("substr(date,1,4) = ?", anchor.slice(0, 4));

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

  // Output VAT (ภาษีขาย) + ภพ.30 — only when the company is VAT-registered, and
  // only on the TAXABLE portion of income. Non-revenue inflows (เงินยืมกรรมการ /
  // เงินกู้ธนาคาร, is_vat=0) are money-in but carry no output VAT (owner 2026-06-27),
  // so subtract them before deriving 7%.
  const nonTaxable = round2((db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM accounta_income WHERE branch_id = ? AND income_date BETWEEN ? AND ? AND COALESCE(is_vat,1) = 0"
  ).get(branchId, start, end) as { s: number }).s);
  const taxableRevenue = Math.max(0, round2(revenue - nonTaxable));
  const outputVat = vatRegistered ? round2((taxableRevenue * 7) / 107) : 0;
  const vatPayable = vatRegistered ? round2(outputVat - inputVat) : 0;

  // Run-rate forecast (ประมาณการยอดขาย) — month period only: SALES-so-far /
  // days-elapsed × days-in-month (loans excluded). Future months → no forecast.
  let forecast: number | null = null;
  if (period === "month") {
    const daysInMonth = Number(end.slice(8, 10));
    const today = bkkToday();
    let elapsed = daysInMonth;
    if (today >= start && today <= end) elapsed = Number(today.slice(8, 10));
    else if (today < start) elapsed = 0;
    if (elapsed > 0) forecast = round2((salesRevenue / elapsed) * daysInMonth);
  }

  // Excel-style daily rows: revenue (shift-close) vs expense per day, with a
  // running balance — the comparison table the owner wanted back.
  const expByDate = db.prepare(
    "SELECT bill_date AS d, COALESCE(SUM(amount_total),0) AS amt FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND bill_date BETWEEN ? AND ? GROUP BY bill_date"
  ).all(branchId, start, end) as Array<{ d: string; amt: number }>;
  const expByDateMap = new Map(expByDate.map((r) => [r.d, round2(r.amt)]));
  // จำนวนบิลต่อวัน (owner 2026-06-25) — captured at shift-close, stored on
  // branch_daily_revenue. Shown in the daybook day detail.
  const billByDate = new Map((db.prepare(
    "SELECT date AS d, bill_count AS c FROM branch_daily_revenue WHERE branch_id = ? AND date BETWEEN ? AND ? AND bill_count IS NOT NULL"
  ).all(branchId, start, end) as Array<{ d: string; c: number }>).map((r) => [r.d, r.c]));
  // Per day: revenue = ยอดขาย (sales), financing = เงินกู้/เงินเข้าอื่น (loans),
  // net = sales − expense (true operating profit, excl financing), balance =
  // running CASH on hand = cumulative (sales + financing − expense), so loan
  // inflows show up and the balance reconciles with money actually in/out (owner
  // 2026-06-29). Week/month show EVERY calendar day (0 when no activity, no day
  // disappears — owner 2026-06-28); year stays data-only (365 rows is unwieldy).
  const dayList = period === "year"
    ? [...new Set([...ledgerByDate.keys(), ...bdrByDate.keys(), ...expByDateMap.keys()])].sort()
    : enumDays(start, end);
  let bal = 0;
  const dailyRows = dayList.map((d) => {
    const sales = salesByDate.has(d) ? round2(salesByDate.get(d)!) : (bdrByDate.get(d) ?? 0);
    const allInc = ledgerByDate.has(d) ? ledgerByDate.get(d)! : (bdrByDate.get(d) ?? 0);
    const financing = round2(allInc - sales);
    const exp = expByDateMap.get(d) ?? 0;
    const net = round2(sales - exp);
    bal = round2(bal + sales + financing - exp);
    return { date: d, revenue: sales, financing, expense: exp, net, balance: bal, billCount: billByDate.get(d) ?? null };
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
    `SELECT income_date AS date, COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)') AS channel,
            COALESCE(SUM(amount),0) AS amount,
            COALESCE(SUM(CASE WHEN is_outstanding = 1 THEN amount ELSE 0 END),0) AS ar,
            COALESCE(SUM(CASE WHEN is_outstanding = 0 THEN amount ELSE 0 END),0) AS cash
       FROM accounta_income WHERE branch_id = ? AND income_date BETWEEN ? AND ?
      GROUP BY income_date, COALESCE(NULLIF(channel,''),'(ไม่ระบุช่องทาง)')`
  ).all(branchId, start, end) as Array<{ date: string; channel: string; amount: number; ar: number; cash: number }>)
    .map((r) => ({ date: r.date, channel: r.channel, amount: round2(r.amount), ar: round2(r.ar), cash: round2(r.cash) }));

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

  const financing = round2(revenue - salesRevenue);
  return {
    period, start, end, label,
    revenue, salesRevenue, financing, expense, net: round2(salesRevenue - expense),
    inputVat, outputVat, vatPayable, vatRegistered,
    daysWithRevenue, avgPerDay, avgWeekday, avgWeekend,
    salesPerBillMonth, salesPerBillYear,
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
  // WHT/SSO are scoped to this branch + any legacy org-level (branch_id NULL)
  // rows — payroll now posts these to the period's branch.
  const wht = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND category = 'ภาษีหัก ณ ที่จ่าย' AND (branch_id = ? OR branch_id IS NULL)"
  ).get(branchId) as { s: number };
  const sso = db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND payment_status = 'unpaid' AND category = 'ประกันสังคม' AND (branch_id = ? OR branch_id IS NULL)"
  ).get(branchId) as { s: number };
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

// Financial-channel master. 'type' is one of cash | bank | ewallet |
// credit_card. Bank rows carry account detail; credit_card rows carry only the
// holder name + bank + last 4 (card_last4) — never the full PAN. use_income /
// use_expense flag which sides may pick the channel (PEAK ใช้รับเงิน/ใช้จ่ายเงิน).
export type CashAccountType = "cash" | "bank" | "ewallet" | "credit_card";
const CASH_ACCOUNT_TYPES: CashAccountType[] = ["cash", "bank", "ewallet", "credit_card"];
const normCashType = (t: string | undefined): CashAccountType =>
  (CASH_ACCOUNT_TYPES as string[]).includes(t ?? "") ? (t as CashAccountType) : "cash";

export type CashAccount = {
  id: number; branch_id: number | null; name: string; type: string;
  bank_label: string | null; balance: number; balance_as_of: string | null;
  sort_order: number; active: number; note: string | null;
  bank_name: string | null; account_type: string | null; account_name: string | null;
  account_no: string | null; account_branch: string | null; account_branch_no: string | null;
  description: string | null; card_last4: string | null; settle_day: number | null;
  use_income: number; use_expense: number;
};

const CASH_ACCOUNT_COLS =
  `id, branch_id, name, type, bank_label, balance, balance_as_of, sort_order, active, note,
   bank_name, account_type, account_name, account_no, account_branch, account_branch_no,
   description, card_last4, settle_day, use_income, use_expense`;

/** Accounts visible to a branch = its own + company-wide (branch_id NULL). */
export function listCashAccounts(branchId: number, includeInactive = false): CashAccount[] {
  const where = includeInactive ? "" : "AND active = 1";
  return getDb().prepare(
    `SELECT ${CASH_ACCOUNT_COLS}
       FROM accounta_cash_accounts
      WHERE (branch_id = ? OR branch_id IS NULL) ${where}
      ORDER BY active DESC, sort_order, name COLLATE NOCASE`
  ).all(branchId) as CashAccount[];
}

/** Display label for a channel in a dropdown, e.g.
 *  "ไทยพาณิชย์ · ออมทรัพย์ ···8595" or "บัตรเครดิตกรรมการ ···1234". */
export function cashAccountLabel(a: CashAccount): string {
  if (a.type === "credit_card") {
    const tail = a.card_last4 ? ` ···${a.card_last4}` : "";
    return a.bank_name ? `${a.name} · ${a.bank_name}${tail}` : `${a.name}${tail}`;
  }
  if (a.type === "bank") {
    const tail = a.account_no ? ` ···${a.account_no.slice(-4)}` : "";
    const bank = a.bank_name || a.bank_label || "";
    return bank ? `${a.name} · ${bank}${tail}` : `${a.name}${tail}`;
  }
  return a.name;
}

/** Channels usable on one side (income/expense), active only, with labels. */
export function listPaymentChannels(branchId: number, side: "income" | "expense"): Array<{ id: number; label: string }> {
  const flag = side === "income" ? "use_income" : "use_expense";
  return listCashAccounts(branchId, false)
    .filter((a) => (a as unknown as Record<string, number>)[flag] === 1)
    .map((a) => ({ id: a.id, label: cashAccountLabel(a) }));
}

export function cashAccountsTotal(branchId: number): number {
  const r = getDb().prepare(
    "SELECT COALESCE(SUM(balance),0) AS s FROM accounta_cash_accounts WHERE (branch_id = ? OR branch_id IS NULL) AND active = 1"
  ).get(branchId) as { s: number };
  return round2(r.s);
}

// Keep only the last ≤4 digits of a card number — defensive even though the UI
// already restricts input. We never persist a full PAN.
const last4 = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const digits = v.replace(/\D/g, "").slice(-4);
  return digits || null;
};

export type CashAccountFields = {
  name?: string; type?: string; bankLabel?: string | null;
  balance?: number; balanceAsOf?: string | null; note?: string | null;
  bankName?: string | null; accountType?: string | null; accountName?: string | null;
  accountNo?: string | null; accountBranch?: string | null; accountBranchNo?: string | null;
  description?: string | null; cardLast4?: string | null; settleDay?: number | null;
  useIncome?: boolean; useExpense?: boolean;
};

export function createCashAccount(d: CashAccountFields & { branchId: number | null; name: string; createdBy: number }): number {
  const db = getDb();
  const max = (db.prepare(
    "SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_cash_accounts WHERE branch_id IS ?"
  ).get(d.branchId) as { m: number }).m;
  return Number(db.prepare(
    `INSERT INTO accounta_cash_accounts
       (branch_id, name, type, bank_label, balance, balance_as_of, sort_order, note, created_by,
        bank_name, account_type, account_name, account_no, account_branch, account_branch_no,
        description, card_last4, settle_day, use_income, use_expense)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    d.branchId, d.name.trim(), normCashType(d.type), d.bankLabel ?? null,
    round2(d.balance ?? 0), d.balanceAsOf ?? null, max + 10, d.note ?? null, d.createdBy,
    d.bankName ?? null, d.accountType ?? null, d.accountName ?? null, d.accountNo ?? null,
    d.accountBranch ?? null, d.accountBranchNo ?? null, d.description ?? null,
    normCashType(d.type) === "credit_card" ? last4(d.cardLast4) : null,
    normCashType(d.type) === "credit_card" ? (d.settleDay ?? null) : null,
    d.useIncome === false ? 0 : 1, d.useExpense === false ? 0 : 1
  ).lastInsertRowid);
}

/** Update editable fields; branchId guards that the account belongs to this
 *  branch or is company-wide (NULL). Only provided keys change. */
export function updateCashAccount(id: number, branchId: number, d: CashAccountFields & { active?: boolean }): boolean {
  const db = getDb();
  const owned = db.prepare(
    "SELECT id FROM accounta_cash_accounts WHERE id = ? AND (branch_id = ? OR branch_id IS NULL)"
  ).get(id, branchId);
  if (!owned) return false;
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  if (d.name !== undefined) { sets.push("name = ?"); vals.push(d.name.trim()); }
  if (d.type !== undefined) { sets.push("type = ?"); vals.push(normCashType(d.type)); }
  if (d.bankLabel !== undefined) { sets.push("bank_label = ?"); vals.push(d.bankLabel); }
  if (d.balance !== undefined) { sets.push("balance = ?"); vals.push(round2(d.balance)); }
  if (d.balanceAsOf !== undefined) { sets.push("balance_as_of = ?"); vals.push(d.balanceAsOf); }
  if (d.active !== undefined) { sets.push("active = ?"); vals.push(d.active ? 1 : 0); }
  if (d.note !== undefined) { sets.push("note = ?"); vals.push(d.note); }
  if (d.bankName !== undefined) { sets.push("bank_name = ?"); vals.push(d.bankName); }
  if (d.accountType !== undefined) { sets.push("account_type = ?"); vals.push(d.accountType); }
  if (d.accountName !== undefined) { sets.push("account_name = ?"); vals.push(d.accountName); }
  if (d.accountNo !== undefined) { sets.push("account_no = ?"); vals.push(d.accountNo); }
  if (d.accountBranch !== undefined) { sets.push("account_branch = ?"); vals.push(d.accountBranch); }
  if (d.accountBranchNo !== undefined) { sets.push("account_branch_no = ?"); vals.push(d.accountBranchNo); }
  if (d.description !== undefined) { sets.push("description = ?"); vals.push(d.description); }
  if (d.cardLast4 !== undefined) { sets.push("card_last4 = ?"); vals.push(last4(d.cardLast4)); }
  if (d.settleDay !== undefined) { sets.push("settle_day = ?"); vals.push(d.settleDay ?? null); }
  if (d.useIncome !== undefined) { sets.push("use_income = ?"); vals.push(d.useIncome ? 1 : 0); }
  if (d.useExpense !== undefined) { sets.push("use_expense = ?"); vals.push(d.useExpense ? 1 : 0); }
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
  targetSales: number;        // configured เป้ายอดขาย X — used on day 1 of the month
  forecastSales: number | null; // run-rate ประมาณการยอดขายทั้งเดือน — X on day 2+
  xUsed: number;              // the X actually applied today (target on day 1, else forecast)
  isFirstDay: boolean;
  budgetPct: number;          // Y (% COG)
  weekday: number; weekdayLabel: string;  // the fixed purchase weekday (NAMA = Monday)
  monthBudget: number;        // xUsed × Y%  = โควตาสั่งซื้อทั้งเดือน
  spentThisMonth: number;     // confirmed GD spend so far this month
  remainingBudget: number;    // monthBudget − spent
  daysInMonth: number; todayDate: number; daysLeft: number;
  todayIsPurchaseDay: boolean; quotaToday: number;
};

const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

/** Material-purchase quota for `date` (owner 2026-07-10, taught logic):
 *   • X = เป้ายอดขาย on day 1 of the month (configured material_target_sales),
 *     otherwise the run-rate ประมาณการยอดขายทั้งเดือน passed in `forecastSales`
 *     (falls back to the target when no sales yet).
 *   • โควตาทั้งเดือน = X × Y% (Y = material_budget_pct).
 *   • On the fixed purchase weekday (NAMA = Monday): quota = โควตาทั้งเดือน ÷
 *     (จำนวนวันจันทร์ในเดือนนั้น) — because Sat/Sun sell a lot, restock on Monday.
 *   • Any other day: quota = (โควตาทั้งเดือน − ที่ใช้ไปแล้ว) ÷ (วันคงเหลือในเดือน),
 *     where วันคงเหลือ = daysInMonth − todayDate (per the owner's example). */
export function materialPurchaseQuota(
  branchId: number, date: string, forecastSales?: number | null
): MaterialQuota | null {
  const db = getDb();
  const b = db.prepare(
    "SELECT material_quota_enabled AS en, material_target_sales AS x, material_budget_pct AS y, material_purchase_weekday AS wd FROM branches WHERE id = ?"
  ).get(branchId) as { en: number; x: number; y: number; wd: number } | undefined;
  if (!b || !b.en) return null;
  const month = date.slice(0, 7);
  const gd = db.prepare("SELECT name FROM accounta_categories WHERE code = 'GD'")
    .get() as { name: string } | undefined;
  const gdName = gd?.name ?? "ต้นทุนสินค้า/วัตถุดิบ";
  const spent = round2((db.prepare(
    "SELECT COALESCE(SUM(amount_total),0) AS s FROM accounta_expenses WHERE review_status = 'confirmed' AND branch_id = ? AND substr(bill_date,1,7) = ? AND category = ?"
  ).get(branchId, month, gdName) as { s: number }).s);

  const [yy, mm, dd] = date.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const isFirstDay = dd === 1;
  // X: day 1 uses the configured target; day 2+ uses the run-rate forecast
  // (fall back to the target until there's a forecast to go on).
  const fc = Number(forecastSales) || 0;
  const xUsed = round2(isFirstDay || fc <= 0 ? b.x : fc);
  const monthBudget = round2(xUsed * (b.y / 100));
  const remainingBudget = round2(monthBudget - spent);

  const todayIsPurchaseDay = new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() === b.wd;
  const daysLeft = daysInMonth - dd;   // owner's example: (30 − 10) = 20

  // Purchase weekday (Monday): a FLAT daily rate = โควตาทั้งเดือน ÷ จำนวนวันในเดือน
  // (owner 2026-07-10 — divide by days-in-month, NOT #Mondays; ยึดแบบหารจำนวนวัน).
  // Any other day: spread the remaining budget over the days left in the month.
  const quotaToday = todayIsPurchaseDay
    ? round2(monthBudget / daysInMonth)
    : (daysLeft > 0 ? Math.max(0, round2(remainingBudget / daysLeft)) : Math.max(0, remainingBudget));

  return {
    targetSales: round2(b.x), forecastSales: fc > 0 ? round2(fc) : null, xUsed, isFirstDay,
    budgetPct: b.y, weekday: b.wd, weekdayLabel: TH_WEEKDAYS[b.wd] ?? "",
    monthBudget, spentThisMonth: spent, remainingBudget,
    daysInMonth, todayDate: dd, daysLeft, todayIsPurchaseDay, quotaToday
  };
}

export type CapexBucketLine = {
  id: number; bill_date: string; payee: string | null; amount: number;
  bucket: string; payment_status: PaymentStatus; has_doc: boolean;
};

/** Confirmed CapEx bills for a branch that carry a FEASIBILITY bucket tag —
 *  feeds the project editor's "เงินลงทุนตั้งต้น" live (owner 2026-06-29). Uses
 *  amount_total (gross cash out, what the investment actually cost). Chronological
 *  within each bucket. */
export function listCapexForFeasibility(branchId: number): CapexBucketLine[] {
  const rows = getDb().prepare(
    `SELECT id, bill_date, vendor_name AS payee, amount_total AS amount,
            capex_bucket AS bucket, payment_status, (doc_path IS NOT NULL) AS has_doc
       FROM accounta_expenses
      WHERE branch_id = ? AND review_status = 'confirmed'
        AND category = ? AND capex_bucket IS NOT NULL
      ORDER BY capex_bucket, bill_date, id`
  ).all(branchId, CAPEX_CATEGORY_NAME) as Array<Omit<CapexBucketLine, "has_doc"> & { has_doc: number }>;
  return rows.map((r) => ({ ...r, has_doc: !!r.has_doc }));
}

/** Confirmed expenses in a date range (for the dashboard's editable list). */
export function listExpensesInRange(branchId: number, start: string, end: string): ExpenseRow[] {
  const r = getDb().prepare(
    `${SELECT_EXPENSE} WHERE e.review_status = 'confirmed' AND e.branch_id = ? AND e.bill_date BETWEEN ? AND ? ORDER BY e.bill_date DESC, e.id DESC`
  ).all(branchId, start, end) as RawExpense[];
  return r.map(shape);
}

// ── Recurring expense templates (owner 2026-06-30) ─────────────────
// Monthly auto-posting: cron creates a CONFIRMED expense on day_of_month each
// month from start_month..end_month; last_posted_month guards double-posting.

export type RecurringRow = {
  id: number;
  branch_id: number | null; branch_name: string | null;
  company_id: number | null; company_name: string | null;
  vendor_name: string | null; category: string | null; capex_bucket: string | null;
  doc_type: string | null; description: string | null;
  amount_total: number; has_tax_invoice: number; vat_amount: number; wht_rate: number;
  payment_status: PaymentStatus; payment_method: string | null; note: string | null;
  day_of_month: number; start_month: string; end_month: string | null;
  active: number; last_posted_month: string | null; created_by: number | null;
  created_at: string; updated_at: string;
};

export type RecurringInput = {
  branch_id: number | null; company_id: number | null;
  vendor_name: string | null; category: string | null; capex_bucket: string | null;
  doc_type: string | null; description: string | null;
  amount_total: number; has_tax_invoice: boolean; vat_amount: number; wht_rate?: number;
  payment_status: PaymentStatus; payment_method: string | null; note: string | null;
  day_of_month: number; start_month: string; end_month: string | null; active: boolean;
};

const SELECT_RECURRING = `
  SELECT r.*, b.name AS branch_name, c.name_th AS company_name
    FROM accounta_recurring_expenses r
    LEFT JOIN branches b  ON b.id = r.branch_id
    LEFT JOIN companies c ON c.id = r.company_id
`;

export function listRecurring(branchId?: number | null): RecurringRow[] {
  const order = " ORDER BY r.active DESC, r.day_of_month, r.id DESC";
  if (branchId != null) {
    return getDb().prepare(`${SELECT_RECURRING} WHERE r.branch_id = ?${order}`).all(branchId) as RecurringRow[];
  }
  return getDb().prepare(SELECT_RECURRING + order).all() as RecurringRow[];
}

export function getRecurring(id: number): RecurringRow | null {
  return getDb().prepare(`${SELECT_RECURRING} WHERE r.id = ?`).get(id) as RecurringRow | undefined ?? null;
}

function normRecurring(d: RecurringInput) {
  const total = round2(Number(d.amount_total) || 0);
  const vat = d.has_tax_invoice ? round2(Number(d.vat_amount) || 0) : 0;
  const dom = Math.min(31, Math.max(1, Math.round(Number(d.day_of_month)) || 1));
  const capex = d.category === CAPEX_CATEGORY_NAME ? (d.capex_bucket || null) : null;
  const wht = Math.max(0, Math.min(0.05, Number(d.wht_rate) || 0));
  return { total, vat, dom, capex, wht };
}

export function createRecurring(userId: number, d: RecurringInput): number {
  const { total, vat, dom, capex, wht } = normRecurring(d);
  const info = getDb().prepare(`
    INSERT INTO accounta_recurring_expenses
      (branch_id, company_id, vendor_name, category, capex_bucket, doc_type, description,
       amount_total, has_tax_invoice, vat_amount, wht_rate, payment_status, payment_method, note,
       day_of_month, start_month, end_month, active, created_by)
    VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?)
  `).run(
    d.branch_id, d.company_id, d.vendor_name?.trim() || null, d.category, capex, d.doc_type, d.description?.trim() || null,
    total, d.has_tax_invoice ? 1 : 0, vat, wht, d.payment_status, d.payment_method?.trim() || null, d.note?.trim() || null,
    dom, d.start_month, d.end_month || null, d.active ? 1 : 0, userId
  );
  return Number(info.lastInsertRowid);
}

export function updateRecurring(id: number, d: RecurringInput): boolean {
  const { total, vat, dom, capex, wht } = normRecurring(d);
  return getDb().prepare(`
    UPDATE accounta_recurring_expenses SET
      branch_id = ?, company_id = ?, vendor_name = ?, category = ?, capex_bucket = ?, doc_type = ?, description = ?,
      amount_total = ?, has_tax_invoice = ?, vat_amount = ?, wht_rate = ?, payment_status = ?, payment_method = ?, note = ?,
      day_of_month = ?, start_month = ?, end_month = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    d.branch_id, d.company_id, d.vendor_name?.trim() || null, d.category, capex, d.doc_type, d.description?.trim() || null,
    total, d.has_tax_invoice ? 1 : 0, vat, wht, d.payment_status, d.payment_method?.trim() || null, d.note?.trim() || null,
    dom, d.start_month, d.end_month || null, d.active ? 1 : 0, id
  ).changes > 0;
}

export function setRecurringActive(id: number, active: boolean): boolean {
  return getDb().prepare("UPDATE accounta_recurring_expenses SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(active ? 1 : 0, id).changes > 0;
}

export function deleteRecurring(id: number): boolean {
  return getDb().prepare("DELETE FROM accounta_recurring_expenses WHERE id = ?").run(id).changes > 0;
}

/** Post recurring templates due as of `today` (YYYY-MM-DD, Bangkok). Idempotent
 *  via last_posted_month (cron pings often). Posts a CONFIRMED expense dated the
 *  intended day; catch-up if today is on/after the day and this month isn't
 *  posted. Auto-deactivates once past end_month. Returns count posted. */
export function postDueRecurringExpenses(today: string): number {
  const db = getDb();
  const [y, m, d] = today.split("-").map(Number);
  const month = today.slice(0, 7);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = db.prepare("SELECT * FROM accounta_recurring_expenses WHERE active = 1").all() as RecurringRow[];
  let posted = 0;
  for (const r of rows) {
    if (r.end_month && month > r.end_month) {
      db.prepare("UPDATE accounta_recurring_expenses SET active = 0 WHERE id = ?").run(r.id);
      continue;
    }
    if (month < r.start_month) continue;
    if (r.last_posted_month === month) continue;
    const postDay = Math.min(r.day_of_month, lastDay);
    if (d < postDay) continue;
    const billDate = `${month}-${String(postDay).padStart(2, "0")}`;
    try {
      createExpense(r.created_by ?? 1, {
        branch_id: r.branch_id, company_id: r.company_id, bill_date: billDate, vendor_id: null,
        vendor_name: r.vendor_name, doc_type: r.doc_type as never, category: r.category,
        capex_bucket: r.capex_bucket, description: r.description, amount_total: r.amount_total,
        has_tax_invoice: r.has_tax_invoice !== 0, vat_amount: r.vat_amount,
        base_amount: round2(r.amount_total - r.vat_amount),
        wht_rate: r.wht_rate,
        payment_status: r.payment_status,
        payment_method: r.payment_status === "paid" ? r.payment_method : null,
        paid_date: r.payment_status === "paid" ? billDate : null,
        due_date: r.payment_status === "unpaid" ? billDate : null,
        note: [r.note, "สร้างอัตโนมัติ (รายจ่ายประจำ)"].filter(Boolean).join(" · ")
      }, undefined, { reviewStatus: "confirmed" });
      db.prepare("UPDATE accounta_recurring_expenses SET last_posted_month = ? WHERE id = ?").run(month, r.id);
      posted++;
    } catch { /* skip a bad template; others still post */ }
  }
  return posted;
}

// ── Director credit-card charges + reserve schedule (owner 2026-07-02) ──
// Track each รูดบัตรกรรมการ (full or ผ่อน) → month-by-month amount to set aside to
// pay the bank on schedule, so that cash isn't accidentally spent.

export type CCChargeRow = {
  id: number; branch_id: number | null; card_id: number | null; card_name: string | null;
  merchant: string | null; description: string | null; purchase_date: string;
  total_amount: number; installments: number; first_due_month: string;
  note: string | null; created_by: number | null; created_at: string; updated_at: string;
};
export type CCChargeInput = {
  branch_id: number | null; card_id: number | null; card_name: string | null;
  merchant: string | null; description: string | null; purchase_date: string;
  total_amount: number; installments: number; first_due_month: string; note: string | null;
};

function addMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function listCCCharges(branchId: number): CCChargeRow[] {
  return getDb().prepare(
    "SELECT * FROM accounta_cc_charges WHERE branch_id = ? ORDER BY purchase_date DESC, id DESC"
  ).all(branchId) as CCChargeRow[];
}
export function getCCCharge(id: number): CCChargeRow | null {
  return getDb().prepare("SELECT * FROM accounta_cc_charges WHERE id = ?").get(id) as CCChargeRow | undefined ?? null;
}
function normCC(d: CCChargeInput) {
  return { total: round2(Number(d.total_amount) || 0), inst: Math.min(60, Math.max(1, Math.round(Number(d.installments)) || 1)) };
}
export function createCCCharge(userId: number, d: CCChargeInput): number {
  const { total, inst } = normCC(d);
  const info = getDb().prepare(`
    INSERT INTO accounta_cc_charges
      (branch_id, card_id, card_name, merchant, description, purchase_date, total_amount, installments, first_due_month, note, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(d.branch_id, d.card_id, d.card_name?.trim() || null, d.merchant?.trim() || null, d.description?.trim() || null,
    d.purchase_date, total, inst, d.first_due_month, d.note?.trim() || null, userId);
  return Number(info.lastInsertRowid);
}
export function updateCCCharge(id: number, d: CCChargeInput): boolean {
  const { total, inst } = normCC(d);
  return getDb().prepare(`
    UPDATE accounta_cc_charges SET branch_id = ?, card_id = ?, card_name = ?, merchant = ?, description = ?, purchase_date = ?,
      total_amount = ?, installments = ?, first_due_month = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(d.branch_id, d.card_id, d.card_name?.trim() || null, d.merchant?.trim() || null, d.description?.trim() || null,
    d.purchase_date, total, inst, d.first_due_month, d.note?.trim() || null, id).changes > 0;
}
export function deleteCCCharge(id: number): boolean {
  return getDb().prepare("DELETE FROM accounta_cc_charges WHERE id = ?").run(id).changes > 0;
}

/** Per-installment amounts for one charge (last month absorbs the rounding). */
function chargeSchedule(total: number, inst: number, firstMonth: string): Array<{ month: string; amount: number }> {
  const per = round2(total / inst);
  const out: Array<{ month: string; amount: number }> = [];
  for (let i = 0; i < inst; i++) {
    out.push({ month: addMonth(firstMonth, i), amount: i === inst - 1 ? round2(total - per * (inst - 1)) : per });
  }
  return out;
}

export type CardReserve = {
  card_id: number | null; card_name: string; bank_label: string | null; last4: string | null;
  months: string[]; byMonth: Record<string, number>;
  thisMonth: number; outstanding: number; charges: CCChargeRow[];
};

/** Group charges by card → month-by-month due + reserve. `outstanding` = total
 *  still owed to the bank from currentMonth onward = the amount to keep set aside.
 *  Includes every director credit-card channel (even with no charges yet). */
export function creditCardReserve(branchId: number, currentMonth: string): CardReserve[] {
  const cards = getDb().prepare(
    "SELECT id, name, bank_label, card_last4 FROM accounta_cash_accounts WHERE branch_id = ? AND type = 'credit_card' ORDER BY sort_order, name"
  ).all(branchId) as Array<{ id: number; name: string; bank_label: string | null; card_last4: string | null }>;

  const groups = new Map<string, CardReserve>();
  const mk = (key: string, base: Partial<CardReserve>): CardReserve => {
    const g: CardReserve = { card_id: null, card_name: "บัตรอื่น", bank_label: null, last4: null,
      months: [], byMonth: {}, thisMonth: 0, outstanding: 0, charges: [], ...base };
    groups.set(key, g); return g;
  };
  for (const c of cards) mk(`id:${c.id}`, { card_id: c.id, card_name: c.name, bank_label: c.bank_label, last4: c.card_last4 });

  for (const ch of listCCCharges(branchId)) {
    const key = ch.card_id != null ? `id:${ch.card_id}` : `name:${ch.card_name ?? "บัตรอื่น"}`;
    const g = groups.get(key) ?? mk(key, { card_id: ch.card_id ?? null, card_name: ch.card_name ?? "บัตรอื่น" });
    g.charges.push(ch);
    for (const s of chargeSchedule(ch.total_amount, ch.installments, ch.first_due_month)) {
      g.byMonth[s.month] = round2((g.byMonth[s.month] ?? 0) + s.amount);
    }
  }

  const out: CardReserve[] = [];
  for (const g of groups.values()) {
    const dueMonths = Object.keys(g.byMonth).sort();
    if (dueMonths.length) {
      const startM = dueMonths[0] < currentMonth ? dueMonths[0] : currentMonth;
      const lastM = dueMonths[dueMonths.length - 1] < currentMonth ? currentMonth : dueMonths[dueMonths.length - 1];
      for (let mth = startM; mth <= lastM && g.months.length <= 60; mth = addMonth(mth, 1)) g.months.push(mth);
    }
    g.thisMonth = round2(g.byMonth[currentMonth] ?? 0);
    g.outstanding = round2(Object.keys(g.byMonth).filter((m) => m >= currentMonth).reduce((s, m) => s + g.byMonth[m], 0));
    out.push(g);
  }
  return out.sort((a, b) => b.outstanding - a.outstanding);
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
