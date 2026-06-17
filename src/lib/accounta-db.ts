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
};

export function listExpenses(f: ExpenseFilter = {}): ExpenseRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (f.branchId != null) { where.push("e.branch_id = ?"); args.push(f.branchId); }
  if (f.companyId != null) { where.push("e.company_id = ?"); args.push(f.companyId); }
  if (f.month) { where.push("substr(e.bill_date, 1, 7) = ?"); args.push(f.month); }
  if (f.status) { where.push("e.payment_status = ?"); args.push(f.status); }
  const sql = SELECT_EXPENSE +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY e.bill_date DESC, e.id DESC";
  return (getDb().prepare(sql).all(...args) as RawExpense[]).map(shape);
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
  ocr?: { source: string; costBaht: number }
): number {
  const d = normalise(input);
  const info = getDb().prepare(`
    INSERT INTO accounta_expenses (
      branch_id, company_id, bill_date, vendor_id, vendor_name, category, description,
      amount_total, has_tax_invoice, vat_amount, base_amount,
      payment_status, payment_method, paid_date,
      ocr_source, ocr_cost_baht, note, created_by
    ) VALUES (?,?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?)
  `).run(
    d.branch_id, d.company_id, d.bill_date, d.vendor_id, d.vendor_name?.trim() || null,
    d.category, d.description?.trim() || null,
    d.amount_total, d.has_tax_invoice ? 1 : 0, d.vat_amount, d.base_amount,
    d.payment_status, d.payment_method, d.paid_date,
    ocr?.source ?? null, ocr?.costBaht ?? null, d.note?.trim() || null, userId
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

  const accrual = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(base_amount),0) AS base,
           COALESCE(SUM(vat_amount),0)  AS vat,
           COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE substr(bill_date,1,7) = ?${bf}
  `).get(month, ...bArg) as { count: number; base: number; vat: number; total: number };

  const cash = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE payment_status = 'paid' AND substr(COALESCE(paid_date,bill_date),1,7) = ?${bf}
  `).get(month, ...bArg) as { count: number; total: number };

  const unpaid = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(amount_total),0) AS total
      FROM accounta_expenses
     WHERE payment_status = 'unpaid'${bf}
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
