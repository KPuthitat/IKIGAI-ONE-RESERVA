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

export function listBranches(): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name FROM branches WHERE status != 'closed' ORDER BY display_order, name"
  ).all() as Array<{ id: number; name: string }>;
}

export function listCompanies(): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name_th AS name FROM companies WHERE active = 1 ORDER BY name_th COLLATE NOCASE"
  ).all() as Array<{ id: number; name: string }>;
}

export function listCategories(): Array<{ id: number; code: string | null; name: string }> {
  return getDb().prepare(
    "SELECT id, code, name FROM accounta_categories WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all() as Array<{ id: number; code: string | null; name: string }>;
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

export function listIncomeChannels(): Array<{ id: number; name: string }> {
  return getDb().prepare(
    "SELECT id, name FROM accounta_income_channels WHERE active = 1 ORDER BY sort_order, name COLLATE NOCASE"
  ).all() as Array<{ id: number; name: string }>;
}

export function createIncomeChannel(d: { name: string }): number {
  const name = d.name.trim();
  const existing = getDb().prepare(
    "SELECT id FROM accounta_income_channels WHERE name = ? COLLATE NOCASE"
  ).get(name) as { id: number } | undefined;
  if (existing) {
    getDb().prepare("UPDATE accounta_income_channels SET active = 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const max = (getDb().prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM accounta_income_channels").get() as { m: number }).m;
  const info = getDb().prepare(
    "INSERT INTO accounta_income_channels (name, sort_order) VALUES (?, ?)"
  ).run(name, max + 10);
  return Number(info.lastInsertRowid);
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
           i.income_date, i.channel, i.amount, i.note
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
           i.income_date, i.channel, i.amount, i.note
      FROM accounta_income i
      LEFT JOIN branches b ON b.id = i.branch_id
      LEFT JOIN companies c ON c.id = i.company_id
     WHERE i.id = ?
  `).get(id) as IncomeRow | undefined ?? null;
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
  // De-dup on name (case-insensitive) so the picker doesn't accrue twins.
  const existing = getDb().prepare(
    "SELECT id FROM accounta_vendors WHERE active = 1 AND name = ? COLLATE NOCASE"
  ).get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = getDb().prepare(`
    INSERT INTO accounta_vendors (name, tax_id, category, created_by)
    VALUES (?, ?, ?, ?)
  `).run(name, d.tax_id?.trim() || null, d.category?.trim() || null, userId);
  return Number(info.lastInsertRowid);
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
      branch_id, company_id, bill_date, vendor_id, vendor_name, category, description,
      amount_total, has_tax_invoice, vat_amount, base_amount,
      payment_status, payment_method, paid_date,
      ocr_source, ocr_cost_baht, review_status, line_message_id, note, created_by
    ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?,?)
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.category, d.description?.trim() || null,
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
      category = ?, description = ?, amount_total = ?, has_tax_invoice = ?,
      vat_amount = ?, base_amount = ?, payment_status = ?, payment_method = ?,
      paid_date = ?, note = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.category, d.description?.trim() || null, d.amount_total, d.has_tax_invoice ? 1 : 0,
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

/** Delete an expense; returns the doc path (if any) so the caller can
 *  unlink the orphaned file. */
export function deleteExpense(id: number): { ok: boolean; doc_path: string | null } {
  const doc = getExpenseDoc(id);
  const info = getDb().prepare("DELETE FROM accounta_expenses WHERE id = ?").run(id);
  return { ok: info.changes > 0, doc_path: doc?.doc_path ?? null };
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
