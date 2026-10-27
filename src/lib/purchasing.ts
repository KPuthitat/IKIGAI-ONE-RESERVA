// งบประมาณ OPEX/CAPEX + ใบขอซื้อ (PR) → อนุมัติ → ใบสั่งซื้อ (PO) → รับของ → ผูกกับบิลใน ACCOUNTA (owner 2026-10-27).
//
//  • Budget: one amount per (year, branch, ACCOUNTA category). A category is CAPEX when it is the CapEx category,
//    otherwise OPEX. Budget vs. real spend vs. what is already committed by open PRs is shown side by side.
//  • A PR that would exceed the remaining budget is flagged and cannot be submitted without a reason.
//  • Requester = a branch admin (or super_admin); approver = a C-level user (or super_admin — never one's own PR,
//    except super_admin). PO / receiving / bill-linking are done by the branch's admins or an approver.
//  • Spend commitments: submitted / approved / ordered / received PRs count against the budget until their bills are
//    linked (closed) — from then on the ACCOUNTA bills are the actual spend, so nothing is counted twice.
import { getDb } from "./db";
import { CAPEX_CATEGORY_NAME } from "./accounta";

export type Kind = "opex" | "capex";
export type PrStatus = "draft" | "submitted" | "approved" | "rejected" | "ordered" | "received" | "closed" | "cancelled";

export type PurchasingErrorCode =
  | "not_found" | "forbidden" | "bad_status" | "no_items" | "invalid_item" | "invalid_category" | "invalid_vendor" | "invalid_amount"
  | "over_budget_reason_required" | "reject_note_required" | "own_request" | "bill_invalid" | "bill_taken" | "no_bills" | "invalid_branch";
export class PurchasingError extends Error { constructor(public code: PurchasingErrorCode) { super(code); } }
export const PURCHASING_ERROR_TH: Record<PurchasingErrorCode, string> = {
  not_found: "ไม่พบรายการ",
  forbidden: "ไม่มีสิทธิ์ทำรายการนี้",
  bad_status: "สถานะปัจจุบันทำรายการนี้ไม่ได้",
  no_items: "ต้องมีรายการสินค้า/บริการอย่างน้อย 1 รายการ",
  invalid_item: "รายการสินค้าไม่ถูกต้อง (ต้องมีชื่อรายการ จำนวนมากกว่า 0 และราคาไม่ติดลบ)",
  invalid_category: "เลือกหมวดค่าใช้จ่ายไม่ถูกต้อง",
  invalid_vendor: "ผู้ขายไม่ถูกต้อง",
  invalid_amount: "จำนวนเงินไม่ถูกต้อง",
  over_budget_reason_required: "ยอดนี้เกินงบคงเหลือของหมวด — ต้องใส่เหตุผลขอเกินงบก่อนส่งอนุมัติ",
  reject_note_required: "ต้องใส่เหตุผลที่ไม่อนุมัติ",
  own_request: "ไม่สามารถอนุมัติใบขอซื้อของตัวเองได้",
  bill_invalid: "บิลนี้ผูกไม่ได้ (ต้องเป็นบิลที่ลงบัญชีแล้วของสาขาเดียวกัน)",
  bill_taken: "บิลนี้ผูกกับใบสั่งซื้ออื่นแล้ว",
  no_bills: "ยังไม่ได้ผูกบิล",
  invalid_branch: "สาขาไม่ถูกต้อง"
};

export type Viewer = { userId: number; role: "staff" | "admin" | "super_admin"; adminBranchIds: number[]; isCLevel: boolean };

const round2 = (n: number) => Math.round(n * 100) / 100;
const nowSql = () => new Date().toISOString().slice(0, 19).replace("T", " ");
export const kindOfCategory = (category: string): Kind => (category === CAPEX_CATEGORY_NAME ? "capex" : "opex");
/** PR statuses whose value is still only a promise (the ACCOUNTA bill does not exist yet or is not linked). */
const COMMITTED: PrStatus[] = ["submitted", "approved", "ordered", "received"];

export function viewerOf(user: { id: number; role: Viewer["role"]; adminBranchIds: number[] }): Viewer {
  const c = getDb().prepare("SELECT COALESCE(is_c_level, 0) AS c FROM users WHERE id = ?").get(user.id) as { c: number } | undefined;
  return { userId: user.id, role: user.role, adminBranchIds: user.adminBranchIds, isCLevel: c?.c === 1 };
}
export const isApprover = (v: Viewer) => v.role === "super_admin" || v.isCLevel;
export const canActOnBranch = (v: Viewer, branchId: number) => isApprover(v) || (v.role === "admin" && v.adminBranchIds.includes(branchId));

// ── budget ───────────────────────────────────────────────────────────────

export type BudgetUsage = { branchId: number; category: string; kind: Kind; budget: number; actual: number; committed: number; remaining: number };

function categoryExists(category: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM accounta_categories WHERE name = ? AND active = 1").get(category);
}

/** Set (amount > 0) or clear (amount 0) the budget of one category for a branch and year. Approvers only. */
export function setBudget(args: { year: number; branchId: number; category: string; amount: number; note?: string; viewer: Viewer }): void {
  if (!isApprover(args.viewer)) throw new PurchasingError("forbidden");
  if (!Number.isFinite(args.amount) || args.amount < 0) throw new PurchasingError("invalid_amount");
  if (!categoryExists(args.category)) throw new PurchasingError("invalid_category");
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM branches WHERE id = ?").get(args.branchId)) throw new PurchasingError("invalid_branch");
  if (args.amount === 0) { db.prepare("DELETE FROM budget_lines WHERE year = ? AND branch_id = ? AND category = ?").run(args.year, args.branchId, args.category); return; }
  db.prepare(`INSERT INTO budget_lines (year, branch_id, kind, category, amount, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(year, branch_id, category) DO UPDATE SET amount = excluded.amount, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(args.year, args.branchId, kindOfCategory(args.category), args.category, round2(args.amount), args.note?.trim() || null, args.viewer.userId);
}

/** Budget, real spend (confirmed ACCOUNTA bills) and open commitments, for every (branch, category) that has any of them. */
export function usageTable(year: number, branchIds: number[]): BudgetUsage[] {
  if (branchIds.length === 0) return [];
  const db = getDb();
  const q = branchIds.map(() => "?").join(",");
  const map = new Map<string, BudgetUsage>();
  const slot = (branchId: number, category: string) => {
    const k = `${branchId}|${category}`;
    let u = map.get(k);
    if (!u) { u = { branchId, category, kind: kindOfCategory(category), budget: 0, actual: 0, committed: 0, remaining: 0 }; map.set(k, u); }
    return u;
  };
  for (const r of db.prepare(`SELECT branch_id AS b, category AS c, amount AS a FROM budget_lines WHERE year = ? AND branch_id IN (${q})`).all(year, ...branchIds) as Array<{ b: number; c: string; a: number }>) slot(r.b, r.c).budget = r.a;
  for (const r of db.prepare(`SELECT branch_id AS b, category AS c, SUM(amount_total) AS a FROM accounta_expenses
                               WHERE branch_id IN (${q}) AND substr(bill_date, 1, 4) = ? AND review_status = 'confirmed' AND category IS NOT NULL AND category != ''
                               GROUP BY branch_id, category`).all(...branchIds, String(year)) as Array<{ b: number; c: string; a: number }>) slot(r.b, r.c).actual = round2(r.a);
  for (const r of db.prepare(`SELECT branch_id AS b, category AS c, SUM(total) AS a FROM purchase_requests
                               WHERE branch_id IN (${q}) AND status IN (${COMMITTED.map(() => "?").join(",")}) AND substr(COALESCE(needed_date, created_at), 1, 4) = ?
                               GROUP BY branch_id, category`).all(...branchIds, ...COMMITTED, String(year)) as Array<{ b: number; c: string; a: number }>) slot(r.b, r.c).committed = round2(r.a);
  const out = [...map.values()];
  for (const u of out) u.remaining = round2(u.budget - u.actual - u.committed);
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "opex" ? -1 : 1) || a.branchId - b.branchId || a.category.localeCompare(b.category, "th"));
}

export function usageOf(year: number, branchId: number, category: string): BudgetUsage {
  return usageTable(year, [branchId]).find((u) => u.category === category)
    ?? { branchId, category, kind: kindOfCategory(category), budget: 0, actual: 0, committed: 0, remaining: 0 };
}

// ── purchase requests ────────────────────────────────────────────────────

export type PrItemInput = { description: string; qty: number; unit?: string; unit_price: number };
export type PrInput = {
  branchId: number; category: string; title: string; reason?: string; neededDate?: string | null;
  vendorId?: number | null; vendorName?: string; vatRate?: number; overBudgetReason?: string; items: PrItemInput[];
};
export type PrRow = {
  id: number; prNo: string; branchId: number; branchName: string; kind: Kind; category: string; title: string; reason: string; neededDate: string | null;
  status: PrStatus; vendorId: number | null; vendorName: string; vatRate: number; subtotal: number; vatAmount: number; total: number;
  overBudget: boolean; overBudgetReason: string; requestedBy: number; requestedByName: string; submittedAt: string | null;
  decidedBy: number | null; decidedByName: string | null; decidedAt: string | null; decisionNote: string; createdAt: string; poNo: string | null;
};
type PrDb = {
  id: number; pr_no: string; branch_id: number; branch_name: string; kind: Kind; category: string; title: string; reason: string; needed_date: string | null;
  status: PrStatus; vendor_id: number | null; vendor_name: string; vat_rate: number; subtotal: number; vat_amount: number; total: number;
  over_budget: number; over_budget_reason: string; requested_by: number; requested_by_name: string; submitted_at: string | null;
  decided_by: number | null; decided_by_name: string | null; decided_at: string | null; decision_note: string; created_at: string; po_no: string | null;
};
const PR_SELECT = `SELECT p.*, b.name AS branch_name, ru.display_name AS requested_by_name, du.display_name AS decided_by_name, po.po_no AS po_no
  FROM purchase_requests p JOIN branches b ON b.id = p.branch_id JOIN users ru ON ru.id = p.requested_by
  LEFT JOIN users du ON du.id = p.decided_by LEFT JOIN purchase_orders po ON po.pr_id = p.id`;
const toRow = (r: PrDb): PrRow => ({
  id: r.id, prNo: r.pr_no, branchId: r.branch_id, branchName: r.branch_name, kind: r.kind, category: r.category, title: r.title, reason: r.reason, neededDate: r.needed_date,
  status: r.status, vendorId: r.vendor_id, vendorName: r.vendor_name, vatRate: r.vat_rate, subtotal: r.subtotal, vatAmount: r.vat_amount, total: r.total,
  overBudget: r.over_budget === 1, overBudgetReason: r.over_budget_reason, requestedBy: r.requested_by, requestedByName: r.requested_by_name, submittedAt: r.submitted_at,
  decidedBy: r.decided_by, decidedByName: r.decided_by_name, decidedAt: r.decided_at, decisionNote: r.decision_note, createdAt: r.created_at, poNo: r.po_no
});

export function getPr(id: number): PrRow | null {
  const r = getDb().prepare(`${PR_SELECT} WHERE p.id = ?`).get(id) as PrDb | undefined;
  return r ? toRow(r) : null;
}
function load(id: number): PrRow { const p = getPr(id); if (!p) throw new PurchasingError("not_found"); return p; }

export function listPrs(args: { branchIds: number[]; year?: number; status?: PrStatus[] }): PrRow[] {
  if (args.branchIds.length === 0) return [];
  const where = [`p.branch_id IN (${args.branchIds.map(() => "?").join(",")})`]; const vals: Array<string | number> = [...args.branchIds];
  if (args.year) { where.push("substr(COALESCE(p.needed_date, p.created_at), 1, 4) = ?"); vals.push(String(args.year)); }
  if (args.status?.length) { where.push(`p.status IN (${args.status.map(() => "?").join(",")})`); vals.push(...args.status); }
  return (getDb().prepare(`${PR_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.id DESC`).all(...vals) as PrDb[]).map(toRow);
}

function cleanItems(items: PrItemInput[]): Array<{ description: string; qty: number; unit: string; unit_price: number; amount: number }> {
  if (!Array.isArray(items) || items.length === 0) throw new PurchasingError("no_items");
  return items.map((i) => {
    const description = (i.description ?? "").trim(), qty = Number(i.qty), price = Number(i.unit_price);
    if (!description || description.length > 200 || !(qty > 0) || !Number.isFinite(price) || price < 0) throw new PurchasingError("invalid_item");
    return { description, qty, unit: (i.unit ?? "").trim().slice(0, 20), unit_price: round2(price), amount: round2(qty * price) };
  });
}

function nextNo(prefix: "PR" | "PO", table: "purchase_requests" | "purchase_orders", col: "pr_no" | "po_no"): string {
  const year = new Date().getFullYear();
  const like = `${prefix}-${year}-%`;
  const last = (getDb().prepare(`SELECT ${col} AS n FROM ${table} WHERE ${col} LIKE ? ORDER BY ${col} DESC LIMIT 1`).get(like) as { n: string } | undefined)?.n;
  const seq = last ? Number(last.split("-")[2]) + 1 : 1;
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}

function prepare(input: PrInput, viewer: Viewer) {
  if (!canActOnBranch(viewer, input.branchId)) throw new PurchasingError("forbidden");
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM branches WHERE id = ?").get(input.branchId)) throw new PurchasingError("invalid_branch");
  if (!categoryExists(input.category)) throw new PurchasingError("invalid_category");
  const title = (input.title ?? "").trim();
  if (!title || title.length > 200) throw new PurchasingError("invalid_item");
  const items = cleanItems(input.items);
  const vatRate = input.vatRate === 7 ? 7 : 0;
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const vatAmount = round2(subtotal * vatRate / 100);
  let vendorName = (input.vendorName ?? "").trim();
  let vendorId: number | null = input.vendorId ?? null;
  if (vendorId != null) {
    const v = db.prepare("SELECT name FROM inventa_suppliers WHERE id = ? AND branch_id = ?").get(vendorId, input.branchId) as { name: string } | undefined;
    if (!v) throw new PurchasingError("invalid_vendor");
    vendorName = v.name;
  }
  return { items, vatRate, subtotal, vatAmount, total: round2(subtotal + vatAmount), title, vendorId, vendorName };
}

function writeItems(prId: number, items: ReturnType<typeof cleanItems>): void {
  const db = getDb();
  db.prepare("DELETE FROM purchase_request_items WHERE pr_id = ?").run(prId);
  const ins = db.prepare("INSERT INTO purchase_request_items (pr_id, line_no, description, qty, unit, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?, ?)");
  items.forEach((i, n) => ins.run(prId, n + 1, i.description, i.qty, i.unit, i.unit_price, i.amount));
}

export function createPr(input: PrInput, viewer: Viewer): number {
  const c = prepare(input, viewer);
  const db = getDb();
  return db.transaction(() => {
    const id = Number(db.prepare(`INSERT INTO purchase_requests (pr_no, branch_id, kind, category, title, reason, needed_date, vendor_id, vendor_name, vat_rate, subtotal, vat_amount, total, over_budget_reason, requested_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nextNo("PR", "purchase_requests", "pr_no"), input.branchId, kindOfCategory(input.category), input.category, c.title, (input.reason ?? "").trim(), input.neededDate || null,
        c.vendorId, c.vendorName, c.vatRate, c.subtotal, c.vatAmount, c.total, (input.overBudgetReason ?? "").trim(), viewer.userId).lastInsertRowid);
    writeItems(id, c.items);
    return id;
  })();
}

/** Only a draft can be edited; the requester's branch admins and approvers may do it. */
export function updatePr(id: number, input: PrInput, viewer: Viewer): void {
  const cur = load(id);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (cur.status !== "draft") throw new PurchasingError("bad_status");
  if (input.branchId !== cur.branchId) throw new PurchasingError("invalid_branch");
  const c = prepare(input, viewer);
  const db = getDb();
  db.transaction(() => {
    db.prepare(`UPDATE purchase_requests SET kind = ?, category = ?, title = ?, reason = ?, needed_date = ?, vendor_id = ?, vendor_name = ?, vat_rate = ?, subtotal = ?, vat_amount = ?, total = ?,
                over_budget_reason = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(kindOfCategory(input.category), input.category, c.title, (input.reason ?? "").trim(), input.neededDate || null, c.vendorId, c.vendorName, c.vatRate, c.subtotal, c.vatAmount, c.total,
        (input.overBudgetReason ?? "").trim(), id);
    writeItems(id, c.items);
  })();
}

export type PrItem = { lineNo: number; description: string; qty: number; unit: string; unitPrice: number; amount: number };
export function listItems(prId: number): PrItem[] {
  return (getDb().prepare("SELECT line_no, description, qty, unit, unit_price, amount FROM purchase_request_items WHERE pr_id = ? ORDER BY line_no").all(prId) as Array<{ line_no: number; description: string; qty: number; unit: string; unit_price: number; amount: number }>)
    .map((r) => ({ lineNo: r.line_no, description: r.description, qty: r.qty, unit: r.unit, unitPrice: r.unit_price, amount: r.amount }));
}

/** What approving this PR would do to its category's budget (the PR's own value is already inside `committed` once submitted). */
export function budgetImpact(pr: PrRow): { usage: BudgetUsage; afterRemaining: number; over: boolean } {
  const year = Number((pr.neededDate ?? pr.createdAt).slice(0, 4));
  const usage = usageOf(year, pr.branchId, pr.category);
  const alreadyCounted = COMMITTED.includes(pr.status) || pr.status === "closed";   // closed: its bills are the actual spend
  const afterRemaining = round2(alreadyCounted ? usage.remaining : usage.remaining - pr.total);
  return { usage, afterRemaining, over: afterRemaining < 0 };
}

/** Draft → submitted. Over-budget PRs need a reason. Returns the PR (for notifying the approvers). */
export function submitPr(id: number, viewer: Viewer): PrRow {
  const cur = load(id);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (cur.status !== "draft") throw new PurchasingError("bad_status");
  if (listItems(id).length === 0) throw new PurchasingError("no_items");
  if (!(cur.total > 0)) throw new PurchasingError("invalid_amount");
  const over = budgetImpact(cur).over;
  if (over && !cur.overBudgetReason.trim()) throw new PurchasingError("over_budget_reason_required");
  getDb().prepare("UPDATE purchase_requests SET status = 'submitted', over_budget = ?, submitted_at = datetime('now'), decided_by = NULL, decided_at = NULL, decision_note = '', updated_at = datetime('now') WHERE id = ?").run(over ? 1 : 0, id);
  return load(id);
}

/** Approver decision on a submitted PR. A reason is required to reject; nobody approves their own PR (except super_admin). */
export function decidePr(id: number, approve: boolean, note: string, viewer: Viewer): PrRow {
  const cur = load(id);
  if (!isApprover(viewer)) throw new PurchasingError("forbidden");
  if (cur.status !== "submitted") throw new PurchasingError("bad_status");
  if (cur.requestedBy === viewer.userId && viewer.role !== "super_admin") throw new PurchasingError("own_request");
  const n = (note ?? "").trim();
  if (!approve && !n) throw new PurchasingError("reject_note_required");
  getDb().prepare("UPDATE purchase_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?, updated_at = datetime('now') WHERE id = ?")
    .run(approve ? "approved" : "rejected", viewer.userId, n, id);
  return load(id);
}

/** A rejected PR goes back to draft so it can be corrected and sent again. */
export function reopenPr(id: number, viewer: Viewer): void {
  const cur = load(id);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (cur.status !== "rejected") throw new PurchasingError("bad_status");
  getDb().prepare("UPDATE purchase_requests SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function cancelPr(id: number, viewer: Viewer): void {
  const cur = load(id);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (!["draft", "submitted", "approved", "rejected"].includes(cur.status)) throw new PurchasingError("bad_status");
  getDb().prepare("UPDATE purchase_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
}

// ── PO, receiving, bills ─────────────────────────────────────────────────

export type PoRow = { id: number; poNo: string; prId: number; vendorName: string; total: number; expectedDate: string | null; note: string; issuedAt: string; receivedAt: string | null; receiveNote: string };
export function getPo(prId: number): PoRow | null {
  const r = getDb().prepare("SELECT id, po_no, pr_id, vendor_name, total, expected_date, note, issued_at, received_at, receive_note FROM purchase_orders WHERE pr_id = ?").get(prId) as
    { id: number; po_no: string; pr_id: number; vendor_name: string; total: number; expected_date: string | null; note: string; issued_at: string; received_at: string | null; receive_note: string } | undefined;
  return r ? { id: r.id, poNo: r.po_no, prId: r.pr_id, vendorName: r.vendor_name, total: r.total, expectedDate: r.expected_date, note: r.note, issuedAt: r.issued_at, receivedAt: r.received_at, receiveNote: r.receive_note } : null;
}

/** Approved PR → PO issued to the vendor (status ordered). A vendor name is required by then. */
export function issuePo(prId: number, args: { expectedDate?: string | null; note?: string; vendorName?: string }, viewer: Viewer): PoRow {
  const cur = load(prId);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (cur.status !== "approved") throw new PurchasingError("bad_status");
  const vendorName = (args.vendorName ?? cur.vendorName).trim();
  if (!vendorName) throw new PurchasingError("invalid_vendor");
  const db = getDb();
  db.transaction(() => {
    db.prepare("INSERT INTO purchase_orders (po_no, pr_id, vendor_id, vendor_name, total, expected_date, note, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(nextNo("PO", "purchase_orders", "po_no"), prId, cur.vendorId, vendorName, cur.total, args.expectedDate || null, (args.note ?? "").trim(), viewer.userId);
    db.prepare("UPDATE purchase_requests SET status = 'ordered', vendor_name = ?, updated_at = datetime('now') WHERE id = ?").run(vendorName, prId);
  })();
  return getPo(prId)!;
}

/** Ordered → received (goods/services arrived). Closes the PR when bills are already linked. */
export function receivePo(prId: number, note: string, viewer: Viewer): void {
  const cur = load(prId);
  if (!canActOnBranch(viewer, cur.branchId)) throw new PurchasingError("forbidden");
  if (cur.status !== "ordered") throw new PurchasingError("bad_status");
  const db = getDb();
  db.prepare("UPDATE purchase_orders SET received_at = datetime('now'), received_by = ?, receive_note = ? WHERE pr_id = ?").run(viewer.userId, (note ?? "").trim(), prId);
  db.prepare("UPDATE purchase_requests SET status = 'received', updated_at = datetime('now') WHERE id = ?").run(prId);
  refreshClosed(prId);
}

export type LinkedBill = { expenseId: number; billDate: string; vendorName: string; description: string; amount: number };
export function listLinkedBills(prId: number): LinkedBill[] {
  return (getDb().prepare(`SELECT e.id, e.bill_date, COALESCE(e.vendor_name, '') AS vendor_name, COALESCE(e.description, '') AS description, e.amount_total
      FROM purchase_order_bills pb JOIN purchase_orders po ON po.id = pb.po_id JOIN accounta_expenses e ON e.id = pb.expense_id WHERE po.pr_id = ? ORDER BY e.bill_date, e.id`).all(prId) as
    Array<{ id: number; bill_date: string; vendor_name: string; description: string; amount_total: number }>)
    .map((r) => ({ expenseId: r.id, billDate: r.bill_date, vendorName: r.vendor_name, description: r.description, amount: r.amount_total }));
}

/** Confirmed, unlinked bills of the same branch and category that could belong to this PR's PO. */
export function listLinkableBills(prId: number): LinkedBill[] {
  const pr = load(prId);
  return (getDb().prepare(`SELECT e.id, e.bill_date, COALESCE(e.vendor_name, '') AS vendor_name, COALESCE(e.description, '') AS description, e.amount_total
      FROM accounta_expenses e WHERE e.branch_id = ? AND e.category = ? AND e.review_status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM purchase_order_bills pb WHERE pb.expense_id = e.id)
        AND e.bill_date >= date(?, '-30 days') ORDER BY e.bill_date DESC, e.id DESC LIMIT 60`).all(pr.branchId, pr.category, pr.decidedAt ?? pr.createdAt) as
    Array<{ id: number; bill_date: string; vendor_name: string; description: string; amount_total: number }>)
    .map((r) => ({ expenseId: r.id, billDate: r.bill_date, vendorName: r.vendor_name, description: r.description, amount: r.amount_total }));
}

function refreshClosed(prId: number): void {
  const db = getDb();
  const pr = load(prId);
  const bills = (db.prepare("SELECT COUNT(*) AS n FROM purchase_order_bills pb JOIN purchase_orders po ON po.id = pb.po_id WHERE po.pr_id = ?").get(prId) as { n: number }).n;
  if (pr.status === "received" && bills > 0) db.prepare("UPDATE purchase_requests SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(prId);
  else if (pr.status === "closed" && bills === 0) db.prepare("UPDATE purchase_requests SET status = 'received', updated_at = datetime('now') WHERE id = ?").run(prId);
}

/** Link ACCOUNTA bills to the PO. From then on those bills are the real spend and the PR stops counting as a commitment. */
export function linkBills(prId: number, expenseIds: number[], viewer: Viewer): void {
  const pr = load(prId);
  if (!canActOnBranch(viewer, pr.branchId)) throw new PurchasingError("forbidden");
  if (!["ordered", "received", "closed"].includes(pr.status)) throw new PurchasingError("bad_status");
  const po = getPo(prId); if (!po) throw new PurchasingError("bad_status");
  const db = getDb();
  db.transaction(() => {
    for (const eid of new Set(expenseIds)) {
      const e = db.prepare("SELECT branch_id, review_status FROM accounta_expenses WHERE id = ?").get(eid) as { branch_id: number; review_status: string } | undefined;
      if (!e || e.branch_id !== pr.branchId || e.review_status !== "confirmed") throw new PurchasingError("bill_invalid");
      if (db.prepare("SELECT 1 FROM purchase_order_bills WHERE expense_id = ?").get(eid)) throw new PurchasingError("bill_taken");
      db.prepare("INSERT INTO purchase_order_bills (po_id, expense_id, linked_by) VALUES (?, ?, ?)").run(po.id, eid, viewer.userId);
    }
  })();
  refreshClosed(prId);
}

export function unlinkBill(prId: number, expenseId: number, viewer: Viewer): void {
  const pr = load(prId);
  if (!canActOnBranch(viewer, pr.branchId)) throw new PurchasingError("forbidden");
  const po = getPo(prId); if (!po) throw new PurchasingError("bad_status");
  getDb().prepare("DELETE FROM purchase_order_bills WHERE po_id = ? AND expense_id = ?").run(po.id, expenseId);
  refreshClosed(prId);
}

/** Who to tell: every active C-level user and super_admin who has a LINE id. */
export function approverRecipients(): Array<{ userId: number; lineUserId: string | null }> {
  return (getDb().prepare(`SELECT id, line_user_id FROM users WHERE (COALESCE(is_c_level, 0) = 1 OR role = 'super_admin') AND status NOT IN ('disabled','resigned','terminated') AND COALESCE(is_test_account, 0) = 0`).all() as
    Array<{ id: number; line_user_id: string | null }>).map((r) => ({ userId: r.id, lineUserId: r.line_user_id }));
}
export function userLine(userId: number): string | null {
  return (getDb().prepare("SELECT line_user_id FROM users WHERE id = ?").get(userId) as { line_user_id: string | null } | undefined)?.line_user_id ?? null;
}
