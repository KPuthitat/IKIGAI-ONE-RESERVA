// Quotation comparison (owner 2026-11-27). Anything that is not the only one of its kind needs rival quotes. The person who brings each quote in scores it
// twice on a 0–100 % scale — price, and every other benefit to the company — with a reason for each; the team and the executives weigh the two against each
// other (a weight slider) and pick the winner. A "sole source" purchase skips the comparison but must say why.
import { getDb, logPersonaAction } from "./db";
import { combinedScore, clampPct } from "./quotes-score";
import type { Viewer } from "./purchasing";

export type Scope = "memo" | "pr";
export class QuoteError extends Error { constructor(public code: "not_found" | "forbidden" | "bad_status" | "invalid" | "too_many" | "duplicate_vendor", msg?: string) { super(msg ?? code); } }
export const QUOTE_ERROR_TH: Record<QuoteError["code"], string> = {
  not_found: "ไม่พบรายการ", forbidden: "ท่านไม่มีสิทธิ์แก้ไขใบเสนอราคาของรายการนี้", bad_status: "รายการนี้ส่งไปแล้ว แก้ไขใบเสนอราคาไม่ได้",
  invalid: "ข้อมูลใบเสนอราคาไม่ครบหรือไม่ถูกต้อง", too_many: "เพิ่มใบเสนอราคาได้ไม่เกิน 8 ราย", duplicate_vendor: "ผู้เสนอราคารายนี้มีอยู่แล้ว — การเทียบต้องเป็นคนละราย"
};

export type Quote = {
  id: number; vendorId: number | null; vendorName: string; quoteNo: string; quoteDate: string | null; validUntil: string | null; amount: number; note: string;
  priceScore: number; priceReason: string; benefitScore: number; benefitReason: string; createdByName: string | null;
};
export type Compare = {
  scope: Scope; refId: number; required: boolean; soleSource: boolean; soleReason: string; weightPrice: number;
  chosenQuoteId: number | null; chosenReason: string; chosenByName: string | null; chosenAt: string | null; quotes: Quote[];
  ready: { ok: boolean; problems: string[] };
};
export type ComparePerms = { edit: boolean; choose: boolean };

const SOLE_MIN = 10;
export function quotesRequired(): boolean {
  const r = getDb().prepare("SELECT value FROM purchasing_settings WHERE key = 'quotes_required'").get() as { value: string } | undefined;
  return r ? r.value !== "0" : true;
}
export function setQuotesRequired(on: boolean, userId: number): void {
  getDb().prepare("INSERT INTO purchasing_settings (key, value) VALUES ('quotes_required', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? "1" : "0");
  logPersonaAction(userId, on ? "quotes.required_on" : "quotes.required_off", 0);
}

type Ctx = { scope: Scope; refId: number; status: string; branchId: number; ownerId: number; kind: string };
function ctx(scope: Scope, refId: number): Ctx {
  const db = getDb();
  const r = scope === "memo"
    ? db.prepare("SELECT status, branch_id, author_id AS owner, memo_kind AS kind FROM memos WHERE id = ?").get(refId) as { status: string; branch_id: number; owner: number; kind: string } | undefined
    : db.prepare("SELECT status, branch_id, requested_by AS owner, 'purchase' AS kind FROM purchase_requests WHERE id = ?").get(refId) as { status: string; branch_id: number; owner: number; kind: string } | undefined;
  if (!r) throw new QuoteError("not_found");
  return { scope, refId, status: r.status, branchId: r.branch_id, ownerId: r.owner, kind: r.kind };
}
const isExec = (v: Viewer) => v.role === "super_admin" || v.isCLevel;
const branchAdmin = (v: Viewer, branchId: number) => v.role === "admin" && v.adminBranchIds.includes(branchId);

/** Who may do what on the comparison. Editing quotes / scores: only while the memo or PR is still a draft. Choosing the winner: the same time; executives may re-choose on a sent PR until the first approval. */
export function permsFor(scope: Scope, refId: number, v: Viewer): ComparePerms {
  const c = ctx(scope, refId);
  if (c.kind === "funding") return { edit: false, choose: false };
  const mine = c.ownerId === v.userId || v.role === "super_admin" || (scope === "pr" && branchAdmin(v, c.branchId)) || (scope === "pr" && isExec(v));
  const draft = c.status === "draft";
  const edit = draft && mine;
  let choose = edit;
  if (!choose && scope === "pr" && c.status === "submitted" && isExec(v)) choose = (getDb().prepare("SELECT COUNT(*) n FROM pr_approvals WHERE pr_id = ?").get(refId) as { n: number }).n === 0;
  return { edit, choose };
}

type QDb = { id: number; vendor_id: number | null; vendor_name: string; quote_no: string; quote_date: string | null; valid_until: string | null; amount: number; note: string; price_score: number; price_reason: string; benefit_score: number; benefit_reason: string; by_name: string | null };
const toQuote = (r: QDb): Quote => ({ id: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name, quoteNo: r.quote_no, quoteDate: r.quote_date, validUntil: r.valid_until, amount: r.amount, note: r.note,
  priceScore: r.price_score, priceReason: r.price_reason, benefitScore: r.benefit_score, benefitReason: r.benefit_reason, createdByName: r.by_name });

export function getCompare(scope: Scope, refId: number): Compare {
  const db = getDb();
  const row = db.prepare("SELECT c.*, u.display_name AS by_name FROM purchase_compare c LEFT JOIN users u ON u.id = c.chosen_by WHERE c.scope = ? AND c.ref_id = ?").get(scope, refId) as
    { sole_source: number; sole_reason: string; weight_price: number; chosen_quote_id: number | null; chosen_reason: string; chosen_at: string | null; by_name: string | null } | undefined;
  const quotes = (db.prepare("SELECT q.*, u.display_name AS by_name FROM purchase_quotes q LEFT JOIN users u ON u.id = q.created_by WHERE q.scope = ? AND q.ref_id = ? ORDER BY q.id").all(scope, refId) as QDb[]).map(toQuote);
  const cmp: Compare = {
    scope, refId, required: quotesRequired(), soleSource: row?.sole_source === 1, soleReason: row?.sole_reason ?? "", weightPrice: row?.weight_price ?? 60,
    chosenQuoteId: row?.chosen_quote_id ?? null, chosenReason: row?.chosen_reason ?? "", chosenByName: row?.by_name ?? null, chosenAt: row?.chosen_at ?? null, quotes, ready: { ok: true, problems: [] }
  };
  cmp.ready = evaluate(cmp);
  return cmp;
}

function evaluate(c: Compare): { ok: boolean; problems: string[] } {
  if (!c.required) return { ok: true, problems: [] };
  const p: string[] = [];
  if (c.soleSource) {
    if (c.soleReason.trim().length < SOLE_MIN) p.push(`ระบุเหตุผลที่สินค้า/บริการนี้มีเพียงรายเดียวในตลาด (อย่างน้อย ${SOLE_MIN} ตัวอักษร)`);
    return { ok: p.length === 0, problems: p };
  }
  const vendors = new Set(c.quotes.map((q) => q.vendorName.trim().toLowerCase()));
  if (vendors.size < 2) p.push("ต้องมีใบเสนอราคาจากผู้เสนออย่างน้อย 2 ราย (หรือระบุว่าเป็นสินค้า/บริการที่มีเพียงรายเดียว)");
  for (const q of c.quotes) {
    if (!(q.amount > 0)) p.push(`${q.vendorName}: ยังไม่ได้ใส่ยอดเสนอราคา`);
    if (!q.priceReason.trim() || !q.benefitReason.trim()) p.push(`${q.vendorName}: ต้องใส่เหตุผลทั้งด้านราคาและด้านประโยชน์อื่น`);
  }
  const chosen = c.quotes.find((q) => q.id === c.chosenQuoteId);
  if (!chosen) p.push("ยังไม่ได้เลือกรายที่เสนอให้ซื้อ");
  else if (!c.chosenReason.trim()) p.push("ใส่เหตุผลที่เลือกรายนี้");
  return { ok: p.length === 0, problems: p };
}

/** Called before a memo / PR is sent: throws nothing, returns the problems (empty when fine or when the rule is off / not a purchase). */
export function compareProblems(scope: Scope, refId: number): string[] {
  const c = ctx(scope, refId);
  if (c.kind === "funding") return [];
  return getCompare(scope, refId).ready.problems;
}

const must = (scope: Scope, refId: number, v: Viewer, need: "edit" | "choose"): Ctx => {
  const c = ctx(scope, refId);
  const p = permsFor(scope, refId, v);
  if (!p[need]) throw new QuoteError(c.status === "draft" || (scope === "pr" && c.status === "submitted") ? "forbidden" : "bad_status");
  return c;
};

export type QuoteInput = { id?: number; vendorId?: number | null; vendorName?: string; quoteNo?: string; quoteDate?: string | null; validUntil?: string | null; amount: number; note?: string;
  priceScore: number; priceReason?: string; benefitScore: number; benefitReason?: string };
const date = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);

export function saveQuote(scope: Scope, refId: number, q: QuoteInput, v: Viewer): number {
  const c = must(scope, refId, v, "edit");
  const db = getDb();
  let vendorName = (q.vendorName ?? "").trim(); let vendorId = q.vendorId ?? null;
  if (vendorId != null) {
    const s = db.prepare("SELECT name FROM inventa_suppliers WHERE id = ? AND branch_id = ?").get(vendorId, c.branchId) as { name: string } | undefined;
    if (!s) throw new QuoteError("invalid");
    vendorName = s.name;
  }
  const amount = Math.round(Number(q.amount) * 100) / 100;
  if (!vendorName || vendorName.length > 200 || !(amount >= 0) || !Number.isFinite(amount) || !Number.isInteger(Number(q.priceScore)) || !Number.isInteger(Number(q.benefitScore))) throw new QuoteError("invalid");
  if (Number(q.priceScore) < 0 || Number(q.priceScore) > 100 || Number(q.benefitScore) < 0 || Number(q.benefitScore) > 100) throw new QuoteError("invalid");   // a score is a percentage
  const price = clampPct(Number(q.priceScore)), benefit = clampPct(Number(q.benefitScore));
  const dup = db.prepare("SELECT id FROM purchase_quotes WHERE scope = ? AND ref_id = ? AND lower(vendor_name) = lower(?) AND id <> ?").get(scope, refId, vendorName, q.id ?? 0);
  if (dup) throw new QuoteError("duplicate_vendor");
  const text = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);
  const vals = [vendorId, vendorName, text(q.quoteNo, 60), date(q.quoteDate), date(q.validUntil), amount, text(q.note, 600), price, text(q.priceReason, 600), benefit, text(q.benefitReason, 600)];
  if (q.id) {
    const own = db.prepare("SELECT id FROM purchase_quotes WHERE id = ? AND scope = ? AND ref_id = ?").get(q.id, scope, refId);
    if (!own) throw new QuoteError("not_found");
    db.prepare(`UPDATE purchase_quotes SET vendor_id = ?, vendor_name = ?, quote_no = ?, quote_date = ?, valid_until = ?, amount = ?, note = ?, price_score = ?, price_reason = ?, benefit_score = ?, benefit_reason = ?, updated_at = datetime('now') WHERE id = ?`).run(...vals, q.id);
    return q.id;
  }
  if ((db.prepare("SELECT COUNT(*) n FROM purchase_quotes WHERE scope = ? AND ref_id = ?").get(scope, refId) as { n: number }).n >= 8) throw new QuoteError("too_many");
  const id = Number(db.prepare(`INSERT INTO purchase_quotes (scope, ref_id, vendor_id, vendor_name, quote_no, quote_date, valid_until, amount, note, price_score, price_reason, benefit_score, benefit_reason, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(scope, refId, ...vals, v.userId).lastInsertRowid);
  db.prepare("UPDATE purchase_compare SET sole_source = 0 WHERE scope = ? AND ref_id = ?").run(scope, refId);   // adding a rival means it is not sole-source
  return id;
}

export function deleteQuote(scope: Scope, refId: number, quoteId: number, v: Viewer): void {
  must(scope, refId, v, "edit");
  const db = getDb();
  db.prepare("DELETE FROM purchase_quotes WHERE id = ? AND scope = ? AND ref_id = ?").run(quoteId, scope, refId);
  db.prepare("UPDATE purchase_compare SET chosen_quote_id = NULL, chosen_reason = '', chosen_by = NULL, chosen_at = NULL WHERE scope = ? AND ref_id = ? AND chosen_quote_id = ?").run(scope, refId, quoteId);
}

function ensureRow(scope: Scope, refId: number): void { getDb().prepare("INSERT OR IGNORE INTO purchase_compare (scope, ref_id) VALUES (?, ?)").run(scope, refId); }

export function setSoleSource(scope: Scope, refId: number, on: boolean, reason: string, v: Viewer): void {
  must(scope, refId, v, "edit");
  ensureRow(scope, refId);
  getDb().prepare("UPDATE purchase_compare SET sole_source = ?, sole_reason = ? WHERE scope = ? AND ref_id = ?").run(on ? 1 : 0, (reason ?? "").trim().slice(0, 600), scope, refId);
  if (on) getDb().prepare("UPDATE purchase_compare SET chosen_quote_id = NULL, chosen_reason = '', chosen_by = NULL, chosen_at = NULL WHERE scope = ? AND ref_id = ?").run(scope, refId);
}

/** Pick the winner. The weight in force at that moment is kept with the decision; the memo / PR takes the winner as its vendor. */
export function chooseQuote(scope: Scope, refId: number, quoteId: number, weightPrice: number, reason: string, v: Viewer): void {
  const c = must(scope, refId, v, "choose");
  const db = getDb();
  const q = db.prepare("SELECT vendor_id, vendor_name FROM purchase_quotes WHERE id = ? AND scope = ? AND ref_id = ?").get(quoteId, scope, refId) as { vendor_id: number | null; vendor_name: string } | undefined;
  if (!q) throw new QuoteError("not_found");
  if (!(reason ?? "").trim()) throw new QuoteError("invalid");
  ensureRow(scope, refId);
  db.transaction(() => {
    db.prepare("UPDATE purchase_compare SET sole_source = 0, weight_price = ?, chosen_quote_id = ?, chosen_reason = ?, chosen_by = ?, chosen_at = datetime('now') WHERE scope = ? AND ref_id = ?")
      .run(clampPct(weightPrice), quoteId, reason.trim().slice(0, 600), v.userId, scope, refId);
    if (scope === "memo") db.prepare("UPDATE memos SET vendor_id = ?, vendor_name = ? WHERE id = ?").run(q.vendor_id, q.vendor_name, refId);
    else db.prepare("UPDATE purchase_requests SET vendor_id = ?, vendor_name = ?, updated_at = datetime('now') WHERE id = ?").run(q.vendor_id, q.vendor_name, refId);
  })();
  logPersonaAction(v.userId, `quotes.choose.${c.scope}`, refId);
}

/** The PR opened from a memo inherits the memo's comparison (a copy, so the memo keeps what its signers saw). */
export function copyCompare(memoId: number, prId: number): void {
  const db = getDb();
  const cmp = db.prepare("SELECT * FROM purchase_compare WHERE scope = 'memo' AND ref_id = ?").get(memoId) as { sole_source: number; sole_reason: string; weight_price: number; chosen_quote_id: number | null; chosen_reason: string; chosen_by: number | null; chosen_at: string | null } | undefined;
  const map = new Map<number, number>();
  for (const q of db.prepare("SELECT * FROM purchase_quotes WHERE scope = 'memo' AND ref_id = ? ORDER BY id").all(memoId) as Array<Record<string, unknown> & { id: number }>) {
    const r = db.prepare(`INSERT INTO purchase_quotes (scope, ref_id, vendor_id, vendor_name, quote_no, quote_date, valid_until, amount, note, price_score, price_reason, benefit_score, benefit_reason, created_by)
      VALUES ('pr', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(prId, q.vendor_id, q.vendor_name, q.quote_no, q.quote_date, q.valid_until, q.amount, q.note, q.price_score, q.price_reason, q.benefit_score, q.benefit_reason, q.created_by);
    map.set(q.id, Number(r.lastInsertRowid));
  }
  if (cmp) db.prepare("INSERT OR REPLACE INTO purchase_compare (scope, ref_id, sole_source, sole_reason, weight_price, chosen_quote_id, chosen_reason, chosen_by, chosen_at) VALUES ('pr', ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(prId, cmp.sole_source, cmp.sole_reason, cmp.weight_price, cmp.chosen_quote_id != null ? map.get(cmp.chosen_quote_id) ?? null : null, cmp.chosen_reason, cmp.chosen_by, cmp.chosen_at);
}

/** Suppliers of the memo's / PR's branch — suggestions for the vendor field of a quote. */
export function branchVendors(scope: Scope, refId: number): Array<{ id: number; name: string }> {
  const c = ctx(scope, refId);
  return getDb().prepare("SELECT id, name FROM inventa_suppliers WHERE active = 1 AND branch_id = ? ORDER BY name").all(c.branchId) as Array<{ id: number; name: string }>;
}

export { combinedScore };
