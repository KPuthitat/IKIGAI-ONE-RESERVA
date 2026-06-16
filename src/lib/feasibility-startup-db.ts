// FEASIBILITY — itemised startup-spend ledger (owner 2026-06-16). Each startup
// category can hold real payment records (date / payee / amount / withholding
// tax / document / paid-status / image). The category's number in the project's
// `inputs.startup` is kept in sync = SUM(amount) of its items, so the engine +
// KPIs flow unchanged. Everything is scoped through the parent project's owner.

import { getDb } from "./db";
import { getProject, updateProject } from "./feasibility-db";

export const STARTUP_CATEGORIES = [
  "construction", "ffe", "stock", "hardOther", "franchise",
  "deposit", "permit", "professional", "preOpening", "softOther"
] as const;
export type StartupCategory = (typeof STARTUP_CATEGORIES)[number];

export type WhtMode = "none" | "baht" | "pct";
export type DocType = "tax_invoice" | "receipt" | null;
export type PaymentStatus = "paid" | "pending";

export type StartupItemRow = {
  id: number;
  project_id: number;
  category: string;
  paid_date: string | null;
  item_name: string;
  payee: string | null;
  amount: number;
  wht_mode: string;
  wht_value: number;
  doc_type: string | null;
  payment_status: string;
  doc_image_path: string | null;
  created_at: string;
  updated_at: string;
};

export type StartupItemWrite = {
  category: string;
  paid_date?: string | null;
  item_name: string;
  payee?: string | null;
  amount: number;
  wht_mode?: WhtMode;
  wht_value?: number;
  doc_type?: DocType;
  payment_status?: PaymentStatus;
  doc_image_path?: string | null;
};

/** Withholding-tax amount in baht for one item. */
export function whtBaht(it: { amount: number; wht_mode: string; wht_value: number }): number {
  if (it.wht_mode === "pct") return (it.amount * it.wht_value) / 100;
  if (it.wht_mode === "baht") return it.wht_value;
  return 0;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** All items for a project (scoped to the owner via the project). */
export function listItems(projectId: number, userId: number): StartupItemRow[] {
  if (!getProject(projectId, userId)) return [];
  return getDb().prepare(`
    SELECT * FROM feasibility_startup_items
    WHERE project_id = ?
    ORDER BY category, COALESCE(paid_date, '9999'), id
  `).all(projectId) as StartupItemRow[];
}

function categorySum(projectId: number, category: string): number {
  const r = getDb().prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM feasibility_startup_items WHERE project_id = ? AND category = ?"
  ).get(projectId, category) as { s: number };
  return round2(r.s);
}

/** Push a category's item-sum back into the project's inputs.startup so the
 *  engine + summary stay correct. Sets it to the current sum (0 if no items). */
function syncCategory(projectId: number, userId: number, category: string): void {
  const proj = getProject(projectId, userId);
  if (!proj) return;
  const startup = { ...proj.inputs.startup, [category]: categorySum(projectId, category) };
  updateProject(projectId, userId, {
    company: proj.company,
    project_name: proj.project_name,
    location: proj.location,
    business_type: proj.business_type,
    status: proj.status as never,
    inputs: { ...proj.inputs, startup }
  });
}

export function createItem(projectId: number, userId: number, d: StartupItemWrite): number | null {
  if (!getProject(projectId, userId)) return null;
  const info = getDb().prepare(`
    INSERT INTO feasibility_startup_items
      (project_id, category, paid_date, item_name, payee, amount,
       wht_mode, wht_value, doc_type, payment_status, doc_image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, d.category, d.paid_date ?? null, d.item_name.trim(),
    d.payee ?? null, d.amount, d.wht_mode ?? "none", d.wht_value ?? 0,
    d.doc_type ?? null, d.payment_status ?? "paid", d.doc_image_path ?? null
  );
  syncCategory(projectId, userId, d.category);
  return Number(info.lastInsertRowid);
}

export function updateItem(itemId: number, projectId: number, userId: number, d: StartupItemWrite): boolean {
  if (!getProject(projectId, userId)) return false;
  const prev = getDb().prepare(
    "SELECT category FROM feasibility_startup_items WHERE id = ? AND project_id = ?"
  ).get(itemId, projectId) as { category: string } | undefined;
  if (!prev) return false;
  getDb().prepare(`
    UPDATE feasibility_startup_items
    SET category = ?, paid_date = ?, item_name = ?, payee = ?, amount = ?,
        wht_mode = ?, wht_value = ?, doc_type = ?, payment_status = ?,
        doc_image_path = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND project_id = ?
  `).run(
    d.category, d.paid_date ?? null, d.item_name.trim(), d.payee ?? null, d.amount,
    d.wht_mode ?? "none", d.wht_value ?? 0, d.doc_type ?? null,
    d.payment_status ?? "paid", d.doc_image_path ?? null, itemId, projectId
  );
  syncCategory(projectId, userId, d.category);
  if (prev.category !== d.category) syncCategory(projectId, userId, prev.category);
  return true;
}

export function deleteItem(itemId: number, projectId: number, userId: number): boolean {
  if (!getProject(projectId, userId)) return false;
  const row = getDb().prepare(
    "SELECT category, doc_image_path FROM feasibility_startup_items WHERE id = ? AND project_id = ?"
  ).get(itemId, projectId) as { category: string; doc_image_path: string | null } | undefined;
  if (!row) return false;
  getDb().prepare("DELETE FROM feasibility_startup_items WHERE id = ? AND project_id = ?")
    .run(itemId, projectId);
  syncCategory(projectId, userId, row.category);
  return true;
}

export type PayeeShare = { payee: string; amount: number; pct: number; count: number };

/** Total paid per payee across the project + each one's share of the total —
 *  "this project paid X to whom". */
export function payeeBreakdown(projectId: number, userId: number): PayeeShare[] {
  if (!getProject(projectId, userId)) return [];
  const rows = getDb().prepare(`
    SELECT COALESCE(NULLIF(TRIM(payee), ''), '(ไม่ระบุผู้รับเงิน)') AS payee,
           SUM(amount) AS amount, COUNT(*) AS count
    FROM feasibility_startup_items
    WHERE project_id = ?
    GROUP BY payee
    ORDER BY amount DESC
  `).all(projectId) as Array<{ payee: string; amount: number; count: number }>;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return rows.map((r) => ({
    payee: r.payee,
    amount: round2(r.amount),
    count: r.count,
    pct: total > 0 ? round2((r.amount / total) * 100) : 0
  }));
}
