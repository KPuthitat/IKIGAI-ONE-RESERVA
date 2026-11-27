// Memo → signatures → PR (owner 2026-11-26).
//
// A purchase starts as a memo. The author lists what is needed (the same items / vendor / VAT a PR has) and picks the people who must
// agree. Each of them is told, reads it, and signs with their saved drawn signature plus their PIN (or declines with a reason). When
// everyone has signed the memo is approved; only then can the author open the PR — which copies the memo — and the executives decide
// the PR as before. A signed memo is never edited: changing it means taking it back to a draft, which clears the signatures.
//
// Statuses: draft → pending (sent for signing) → approved (all signed) → pr_opened;   pending → rejected (anyone declines) → draft again;
// cancelled by the author at any point before the PR is opened.
import { getDb } from "./db";
import { verifyAdminPin } from "./admin-pin";
import { createPr, getPr, submitPr, type PrInput, type Viewer, canActOnBranch, isApprover, PurchasingError } from "./purchasing";
import { compareProblems, copyCompare } from "./quotes";
import { eligibleApprovers, executiveIds, ruleFor, topExecIds, RULE_TH, type Rule } from "./pr-authority";

export type MemoStatus = "draft" | "pending" | "approved" | "rejected" | "cancelled" | "pr_opened";
export type MemoErrorCode =
  | "not_found" | "forbidden" | "bad_status" | "invalid" | "no_items" | "no_signers" | "bad_signer" | "no_signature" | "no_pin" | "wrong_pin" | "not_signer" | "already_signed"
  | "reject_reason_required" | "bad_signature_image" | "pr_failed" | "bad_account" | "signers_not_authorised" | "compare_required";
export class MemoError extends Error { constructor(public code: MemoErrorCode, public detail?: string) { super(code); } }
export const MEMO_ERROR_TH: Record<MemoErrorCode, string> = {
  not_found: "ไม่พบ Memo", forbidden: "ท่านไม่มีสิทธิ์ทำรายการนี้", bad_status: "สถานะของ Memo ไม่ให้ทำรายการนี้", invalid: "ข้อมูลไม่ครบหรือไม่ถูกต้อง",
  no_items: "ต้องมีรายการอย่างน้อย 1 รายการและยอดรวมมากกว่า 0", no_signers: "ต้องเลือกผู้ลงนามอย่างน้อย 1 คน", bad_signer: "ผู้ลงนามต้องเป็นผู้ใช้ที่ทำงานอยู่ และไม่ใช่ผู้เขียน Memo",
  no_signature: "ยังไม่ได้ตั้งลายเซ็น กรุณาวาดลายเซ็นก่อน", no_pin: "ยังไม่ได้ตั้ง PIN", wrong_pin: "PIN ไม่ถูกต้อง", not_signer: "ท่านไม่ได้เป็นผู้ลงนามของ Memo นี้",
  already_signed: "ท่านลงนามหรือปฏิเสธไปแล้ว", reject_reason_required: "กรุณาระบุเหตุผลที่ไม่เห็นชอบ", bad_signature_image: "ลายเซ็นไม่ถูกต้อง (ต้องเป็นภาพ PNG ขนาดไม่เกิน 300 KB)",
  pr_failed: "เปิด PR ไม่สำเร็จ", bad_account: "เลือกบัญชีธนาคารไม่ถูกต้อง (ต้องเป็นบัญชีธนาคารที่ใช้งานอยู่ และบัญชีต้นทาง/ปลายทางต้องต่างกัน)",
  signers_not_authorised: "ผู้ลงนามที่เลือกยังไม่ครบตามอำนาจอนุมัติของยอดนี้", compare_required: "ต้องเทียบใบเสนอราคาก่อนส่ง"
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export type MemoItemInput = { description: string; qty: number; unit?: string; unit_price: number; inventa_item_id?: number | null };
export type MemoKind = "purchase" | "funding";
export type MemoInput = {
  kind?: MemoKind; branchId: number; subject: string; body?: string; category: string; neededDate?: string | null; vendorId?: number | null; vendorName?: string;
  vatRate?: number; items: MemoItemInput[]; signerIds: number[];
  payAccountId?: number | null;                                   // purchase: the account the PR will be paid from
  fromAccountId?: number | null; toAccountId?: number | null; weekStart?: string | null; amount?: number;   // funding: SCB → KBANK for one week
};
export type MemoSigner = { userId: number; name: string; status: "pending" | "signed" | "rejected"; signedAt: string | null; comment: string; signature: string | null };
export type MemoRow = {
  id: number; memoNo: string; branchId: number; branchName: string; authorId: number; authorName: string; subject: string; body: string; category: string; neededDate: string | null;
  vendorId: number | null; vendorName: string; vatRate: number; subtotal: number; vatAmount: number; total: number; status: MemoStatus; submittedAt: string | null; approvedAt: string | null;
  prId: number | null; prNo: string | null; createdAt: string; signed: number; signerCount: number;
  kind: MemoKind; payAccountId: number | null; payAccountName: string | null; fromAccountId: number | null; fromAccountName: string | null; toAccountId: number | null; toAccountName: string | null; weekStart: string | null;
};
export type MemoDetail = MemoRow & { items: Array<{ lineNo: number; description: string; qty: number; unit: string; unitPrice: number; amount: number; inventaItemId: number | null }>; signers: MemoSigner[]; events: Array<{ at: string; actor: string; action: string; detail: string }> };

type Db = {
  id: number; memo_no: string; branch_id: number; branch_name: string; author_id: number; author_name: string; subject: string; body: string; category: string; needed_date: string | null;
  vendor_id: number | null; vendor_name: string; vat_rate: number; subtotal: number; vat_amount: number; total: number; status: MemoStatus; submitted_at: string | null; approved_at: string | null;
  pr_id: number | null; pr_no: string | null; created_at: string; signed: number; signer_count: number;
  memo_kind: MemoKind; pay_account_id: number | null; pay_account_name: string | null; from_account_id: number | null; from_account_name: string | null; to_account_id: number | null; to_account_name: string | null; week_start: string | null;
};
const SELECT = `SELECT m.*, b.name AS branch_name, u.display_name AS author_name, p.pr_no AS pr_no,
    (SELECT COUNT(*) FROM memo_signers s WHERE s.memo_id = m.id AND s.status = 'signed') AS signed,
    (SELECT COUNT(*) FROM memo_signers s WHERE s.memo_id = m.id) AS signer_count,
         pa.name AS pay_account_name, fa.name AS from_account_name, ta.name AS to_account_name
  FROM memos m JOIN branches b ON b.id = m.branch_id JOIN users u ON u.id = m.author_id LEFT JOIN purchase_requests p ON p.id = m.pr_id
  LEFT JOIN accounta_cash_accounts pa ON pa.id = m.pay_account_id LEFT JOIN accounta_cash_accounts fa ON fa.id = m.from_account_id LEFT JOIN accounta_cash_accounts ta ON ta.id = m.to_account_id`;
const toRow = (r: Db): MemoRow => ({
  id: r.id, memoNo: r.memo_no, branchId: r.branch_id, branchName: r.branch_name, authorId: r.author_id, authorName: r.author_name, subject: r.subject, body: r.body, category: r.category,
  neededDate: r.needed_date, vendorId: r.vendor_id, vendorName: r.vendor_name, vatRate: r.vat_rate, subtotal: r.subtotal, vatAmount: r.vat_amount, total: r.total, status: r.status,
  submittedAt: r.submitted_at, approvedAt: r.approved_at, prId: r.pr_id, prNo: r.pr_no, createdAt: r.created_at, signed: r.signed, signerCount: r.signer_count,
  kind: r.memo_kind, payAccountId: r.pay_account_id, payAccountName: r.pay_account_name, fromAccountId: r.from_account_id, fromAccountName: r.from_account_name, toAccountId: r.to_account_id, toAccountName: r.to_account_name, weekStart: r.week_start
});

function nextNo(): string {
  const year = new Date(Date.now() + 7 * 3600_000).getUTCFullYear() + 543;
  const like = `MEMO-${year}-%`;
  const last = (getDb().prepare("SELECT memo_no AS n FROM memos WHERE memo_no LIKE ? ORDER BY memo_no DESC LIMIT 1").get(like) as { n: string } | undefined)?.n;
  return `MEMO-${year}-${String(last ? Number(last.split("-")[2]) + 1 : 1).padStart(4, "0")}`;
}
function log(memoId: number, actorId: number | null, action: string, detail = ""): void {
  getDb().prepare("INSERT INTO memo_events (memo_id, actor_id, action, detail) VALUES (?,?,?,?)").run(memoId, actorId, action, detail);
}
function load(id: number): MemoRow {
  const r = getDb().prepare(`${SELECT} WHERE m.id = ?`).get(id) as Db | undefined;
  if (!r) throw new MemoError("not_found");
  return toRow(r);
}

// ── who may see / act ──
/** Authors: branch admins and executives (the people who may open a PR). Signers see the memos they must sign. */
export function canAuthor(v: Viewer, branchId: number): boolean { return canActOnBranch(v, branchId); }
export function isSignerOf(memoId: number, userId: number): boolean { return !!getDb().prepare("SELECT 1 FROM memo_signers WHERE memo_id = ? AND user_id = ?").get(memoId, userId); }
export function canSee(v: Viewer, m: MemoRow): boolean { return m.authorId === v.userId || isApprover(v) || canActOnBranch(v, m.branchId) || isSignerOf(m.id, v.userId); }

/** People who can be asked to sign: active, real accounts that are admins or executives. */
export function signerChoices(): Array<{ id: number; name: string; role: string; cLevel: boolean; hasSignature: boolean }> {
  const rows = getDb().prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.role, COALESCE(u.is_c_level, 0) AS c, EXISTS (SELECT 1 FROM user_signatures s WHERE s.user_id = u.id) AS sig
      FROM users u WHERE u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account, 0) = 0 AND (u.role IN ('admin','super_admin') OR COALESCE(u.is_c_level, 0) = 1)
     ORDER BY COALESCE(u.is_c_level, 0) DESC, u.display_name`).all() as Array<{ id: number; display_name: string; title_prefix: string | null; role: string; c: number; sig: number }>;
  return rows.map((r) => ({ id: r.id, name: `${r.title_prefix ?? ""}${r.display_name}`, role: r.role, cLevel: r.c === 1, hasSignature: r.sig === 1 }));
}

// ── saving ──
function cleanItems(items: MemoItemInput[]) {
  const out = (items ?? []).map((i) => ({ description: String(i.description ?? "").trim(), qty: Number(i.qty), unit: String(i.unit ?? "").trim().slice(0, 20), unit_price: Number(i.unit_price),
    inventa_item_id: i.inventa_item_id != null && Number.isInteger(Number(i.inventa_item_id)) && Number(i.inventa_item_id) > 0 ? Number(i.inventa_item_id) : null }))
    .filter((i) => i.description);
  if (out.some((i) => !(i.qty > 0) || !(i.unit_price >= 0) || !Number.isFinite(i.qty) || !Number.isFinite(i.unit_price))) throw new MemoError("invalid");
  return out.map((i) => ({ ...i, amount: round2(i.qty * i.unit_price) }));
}
function checkSigners(ids: number[], authorId: number): number[] {
  const uniq = [...new Set(ids)];
  const db = getDb();
  for (const id of uniq) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND status NOT IN ('disabled','resigned','terminated') AND COALESCE(is_test_account, 0) = 0 AND (role IN ('admin','super_admin') OR COALESCE(is_c_level, 0) = 1)").get(id);
    if (!u || id === authorId) throw new MemoError("bad_signer");
  }
  return uniq;
}
const isBankAccount = (id: number | null | undefined): boolean => id != null && !!getDb().prepare("SELECT 1 FROM accounta_cash_accounts WHERE id = ? AND type = 'bank' AND active = 1").get(id);

/** Funding memos: the signers chosen must be able to satisfy the approval rule of the SOURCE account for this amount (a plain list of friends is not enough). */
function checkFundingSigners(fromAccountId: number, amount: number, signerIds: number[]): void {
  const rule: Rule = ruleFor(fromAccountId, amount);
  const eligible = new Set(eligibleApprovers(fromAccountId, rule));
  const execs = new Set(executiveIds()), tops = new Set(topExecIds());
  const chosen = signerIds.filter((id) => eligible.has(id));
  const okRule = rule === "two_execs_or_top" ? chosen.some((id) => tops.has(id)) || chosen.filter((id) => execs.has(id)).length >= 2 : rule === "top_only" ? chosen.some((id) => tops.has(id)) : chosen.length >= 1;
  if (!okRule) throw new MemoError("signers_not_authorised", RULE_TH[rule]);
}

function writeBody(memoId: number, input: MemoInput, authorId: number, kind: MemoKind): void {
  const db = getDb();
  const subject = (input.subject ?? "").trim();
  if (!subject || subject.length > 200) throw new MemoError("invalid");
  const signerIds = checkSigners(input.signerIds ?? [], authorId);
  db.prepare("DELETE FROM memo_items WHERE memo_id = ?").run(memoId);
  db.prepare("DELETE FROM memo_signers WHERE memo_id = ?").run(memoId);

  if (kind === "funding") {
    const amount = round2(Number(input.amount));
    if (!(amount > 0) || !Number.isFinite(amount)) throw new MemoError("invalid");
    if (!isBankAccount(input.fromAccountId) || !isBankAccount(input.toAccountId) || input.fromAccountId === input.toAccountId) throw new MemoError("bad_account");
    if (input.weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(input.weekStart)) throw new MemoError("invalid");
    if (signerIds.length) checkFundingSigners(input.fromAccountId as number, amount, signerIds);
    db.prepare(`UPDATE memos SET subject = ?, body = ?, category = '', needed_date = NULL, vendor_id = NULL, vendor_name = '', vat_rate = 0, subtotal = ?, vat_amount = 0, total = ?, from_account_id = ?, to_account_id = ?, pay_account_id = NULL, week_start = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(subject, (input.body ?? "").trim().slice(0, 4000), amount, amount, input.fromAccountId, input.toAccountId, input.weekStart || null, memoId);
  } else {
    const items = cleanItems(input.items);
    const vatRate = input.vatRate === 7 ? 7 : 0;
    const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
    const vatAmount = round2(subtotal * vatRate / 100);
    let vendorName = (input.vendorName ?? "").trim(), vendorId = input.vendorId ?? null;
    if (vendorId != null) {
      const v = db.prepare("SELECT name FROM inventa_suppliers WHERE id = ? AND branch_id = ?").get(vendorId, input.branchId) as { name: string } | undefined;
      if (!v) throw new MemoError("invalid");
      vendorName = v.name;
    }
    if (!String(input.category ?? "").trim()) throw new MemoError("invalid");
    if (input.payAccountId != null && !isBankAccount(input.payAccountId)) throw new MemoError("bad_account");
    db.prepare(`UPDATE memos SET subject = ?, body = ?, category = ?, needed_date = ?, vendor_id = ?, vendor_name = ?, vat_rate = ?, subtotal = ?, vat_amount = ?, total = ?, pay_account_id = ?, from_account_id = NULL, to_account_id = NULL, week_start = NULL, updated_at = datetime('now') WHERE id = ?`)
      .run(subject, (input.body ?? "").trim().slice(0, 4000), input.category.trim(), input.neededDate || null, vendorId, vendorName, vatRate, subtotal, vatAmount, round2(subtotal + vatAmount), input.payAccountId ?? null, memoId);
    const stockOk = db.prepare("SELECT 1 FROM inventa_items WHERE id = ? AND branch_id = ?");
    for (const i of items) if (i.inventa_item_id != null && !stockOk.get(i.inventa_item_id, input.branchId)) throw new MemoError("invalid");   // a stock link must be an item of this branch
    const ins = db.prepare("INSERT INTO memo_items (memo_id, line_no, description, qty, unit, unit_price, amount, inventa_item_id) VALUES (?,?,?,?,?,?,?,?)");
    items.forEach((i, n) => ins.run(memoId, n + 1, i.description, i.qty, i.unit, i.unit_price, i.amount, i.inventa_item_id));
  }
  const sins = db.prepare("INSERT INTO memo_signers (memo_id, user_id, sort_no) VALUES (?,?,?)");
  signerIds.forEach((u, n) => sins.run(memoId, u, n + 1));
}

export function createMemo(input: MemoInput, viewer: Viewer): number {
  if (!canAuthor(viewer, input.branchId)) throw new MemoError("forbidden");
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM branches WHERE id = ?").get(input.branchId)) throw new MemoError("invalid");
  return db.transaction(() => {
    const kind: MemoKind = input.kind === "funding" ? "funding" : "purchase";
    const id = Number(db.prepare("INSERT INTO memos (memo_no, branch_id, author_id, subject, category, memo_kind) VALUES (?,?,?,?,?,?)").run(nextNo(), input.branchId, viewer.userId, (input.subject ?? "").trim() || "-", (input.category ?? "").trim(), kind).lastInsertRowid);
    writeBody(id, input, viewer.userId, kind);
    log(id, viewer.userId, "create");
    return id;
  })();
}

/** Only a draft is edited (the author, or a super_admin). */
export function updateMemo(id: number, input: MemoInput, viewer: Viewer): void {
  const cur = load(id);
  if (cur.authorId !== viewer.userId && viewer.role !== "super_admin") throw new MemoError("forbidden");
  if (cur.status !== "draft") throw new MemoError("bad_status");
  if (input.branchId !== cur.branchId) throw new MemoError("invalid");
  getDb().transaction(() => { writeBody(id, input, cur.authorId, cur.kind); log(id, viewer.userId, "update"); })();
}

export function submitMemo(id: number, viewer: Viewer): MemoRow {
  const cur = load(id);
  if (cur.authorId !== viewer.userId && viewer.role !== "super_admin") throw new MemoError("forbidden");
  if (cur.status !== "draft") throw new MemoError("bad_status");
  const db = getDb();
  if ((cur.kind === "purchase" && !(db.prepare("SELECT COUNT(*) n FROM memo_items WHERE memo_id = ?").get(id) as { n: number }).n) || !(cur.total > 0)) throw new MemoError("no_items");
  if (cur.signerCount === 0) throw new MemoError("no_signers");
  if (cur.kind === "purchase") { const problems = compareProblems("memo", id); if (problems.length) throw new MemoError("compare_required", problems.join(" · ")); }   // rival quotes or a sole-source reason (owner 2026-11-27)
  db.transaction(() => {
    db.prepare("UPDATE memo_signers SET status = 'pending', signed_at = NULL, comment = '', signature_png = NULL WHERE memo_id = ?").run(id);
    db.prepare("UPDATE memos SET status = 'pending', submitted_at = datetime('now'), approved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    log(id, viewer.userId, "submit", `${cur.signerCount} signers`);
  })();
  return load(id);
}

/** A rejected (or pending) memo goes back to a draft so it can be corrected; every signature is cleared. */
export function reopenMemo(id: number, viewer: Viewer): void {
  const cur = load(id);
  if (cur.authorId !== viewer.userId && viewer.role !== "super_admin") throw new MemoError("forbidden");
  if (cur.status !== "rejected" && cur.status !== "pending") throw new MemoError("bad_status");
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE memo_signers SET status = 'pending', signed_at = NULL, comment = '', signature_png = NULL WHERE memo_id = ?").run(id);
    db.prepare("UPDATE memos SET status = 'draft', submitted_at = NULL, approved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
    log(id, viewer.userId, "reopen");
  })();
}

export function cancelMemo(id: number, viewer: Viewer): void {
  const cur = load(id);
  if (cur.authorId !== viewer.userId && viewer.role !== "super_admin") throw new MemoError("forbidden");
  if (!["draft", "pending", "rejected", "approved"].includes(cur.status)) throw new MemoError("bad_status");
  getDb().transaction(() => {
    getDb().prepare("UPDATE memos SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
    log(id, viewer.userId, "cancel");
  })();
}

// ── signatures ──
const PNG_PREFIX = "data:image/png;base64,";
export function getSignature(userId: number): string | null {
  return (getDb().prepare("SELECT image_png FROM user_signatures WHERE user_id = ?").get(userId) as { image_png: string } | undefined)?.image_png ?? null;
}
export function saveSignature(userId: number, dataUrl: string): void {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX) || dataUrl.length > 300_000 || !/^[A-Za-z0-9+/=]+$/.test(dataUrl.slice(PNG_PREFIX.length))) throw new MemoError("bad_signature_image");
  getDb().prepare("INSERT INTO user_signatures (user_id, image_png) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET image_png = excluded.image_png, updated_at = datetime('now')").run(userId, dataUrl);
}
export function deleteSignature(userId: number): void { getDb().prepare("DELETE FROM user_signatures WHERE user_id = ?").run(userId); }

/** A signer agrees: needs a saved signature and the PIN. When the last signer signs, the memo is approved. */
export function signMemo(id: number, userId: number, pin: string): { memo: MemoRow; allSigned: boolean } {
  const cur = load(id);
  const db = getDb();
  const me = db.prepare("SELECT id, status FROM memo_signers WHERE memo_id = ? AND user_id = ?").get(id, userId) as { id: number; status: string } | undefined;
  if (!me) throw new MemoError("not_signer");
  if (cur.status !== "pending") throw new MemoError("bad_status");
  if (me.status !== "pending") throw new MemoError("already_signed");
  const sig = getSignature(userId);
  if (!sig) throw new MemoError("no_signature");
  const p = verifyAdminPin(userId, (pin ?? "").trim());
  if (!p.ok) throw new MemoError(p.reason === "no_pin" ? "no_pin" : "wrong_pin");
  let all = false;
  db.transaction(() => {
    db.prepare("UPDATE memo_signers SET status = 'signed', signed_at = datetime('now'), signature_png = ? WHERE id = ?").run(sig, me.id);
    all = (db.prepare("SELECT COUNT(*) n FROM memo_signers WHERE memo_id = ? AND status <> 'signed'").get(id) as { n: number }).n === 0;
    if (all) {
      db.prepare("UPDATE memos SET status = 'approved', approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
      // an approved funding memo becomes a transfer for finance to make and record
      if (cur.kind === "funding" && cur.fromAccountId && cur.toAccountId) db.prepare("INSERT OR IGNORE INTO fund_transfers (memo_id, from_account_id, to_account_id, week_start, amount) VALUES (?,?,?,?,?)").run(id, cur.fromAccountId, cur.toAccountId, cur.weekStart, cur.total);
    }
    log(id, userId, "sign");
    if (all) log(id, null, "approved", "all signers signed");
  })();
  return { memo: load(id), allSigned: all };
}

/** A signer declines: the memo is rejected at once and the author is told why. */
export function rejectMemo(id: number, userId: number, reason: string): MemoRow {
  const cur = load(id);
  const db = getDb();
  const me = db.prepare("SELECT id, status FROM memo_signers WHERE memo_id = ? AND user_id = ?").get(id, userId) as { id: number; status: string } | undefined;
  if (!me) throw new MemoError("not_signer");
  if (cur.status !== "pending") throw new MemoError("bad_status");
  if (me.status !== "pending") throw new MemoError("already_signed");
  const why = (reason ?? "").trim();
  if (!why) throw new MemoError("reject_reason_required");
  db.transaction(() => {
    db.prepare("UPDATE memo_signers SET status = 'rejected', signed_at = datetime('now'), comment = ? WHERE id = ?").run(why.slice(0, 1000), me.id);
    db.prepare("UPDATE memos SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(id);
    log(id, userId, "reject", why.slice(0, 200));
  })();
  return load(id);
}

// ── PR from an approved memo ──
/** The author opens the PR; the memo's items, vendor, VAT and reason are copied. The PR is sent for approval straight away. */
export function openPrFromMemo(id: number, viewer: Viewer, overBudgetReason?: string): { memo: MemoRow; prId: number } {
  const cur = load(id);
  if (cur.authorId !== viewer.userId && viewer.role !== "super_admin") throw new MemoError("forbidden");
  if (cur.status !== "approved" || cur.kind !== "purchase") throw new MemoError("bad_status");
  const db = getDb();
  const items = db.prepare("SELECT description, qty, unit, unit_price, inventa_item_id FROM memo_items WHERE memo_id = ? ORDER BY line_no").all(id) as MemoItemInput[];
  const input: PrInput = {
    branchId: cur.branchId, category: cur.category, title: cur.subject, reason: `${cur.body}${cur.body ? "\n" : ""}อ้างอิง ${cur.memoNo}`.trim(), neededDate: cur.neededDate,
    vendorId: cur.vendorId, vendorName: cur.vendorName, vatRate: cur.vatRate, overBudgetReason: overBudgetReason ?? "", payAccountId: cur.payAccountId, items
  };
  try {
    return db.transaction(() => {
      const prId = createPr(input, viewer);
      db.prepare("UPDATE purchase_requests SET memo_id = ? WHERE id = ?").run(id, prId);
      copyCompare(id, prId);   // the PR carries the memo's quote comparison
      submitPr(prId, viewer);
      db.prepare("UPDATE memos SET status = 'pr_opened', pr_id = ?, updated_at = datetime('now') WHERE id = ?").run(prId, id);
      log(id, viewer.userId, "open_pr", getPr(prId)?.prNo ?? String(prId));
      return { memo: load(id), prId };
    })();
  } catch (e) {
    if (e instanceof PurchasingError) throw new MemoError("pr_failed", e.code);
    throw e;
  }
}

// ── reading ──
export function listMemos(viewer: Viewer, opts: { status?: MemoStatus[] } = {}): MemoRow[] {
  const args: Array<number | string> = [viewer.userId, viewer.userId];
  // the author, anyone named as a signer, executives (all memos) and a branch admin (their branches)
  const branch = isApprover(viewer) ? "1" : viewer.role === "admin" && viewer.adminBranchIds.length ? `m.branch_id IN (${viewer.adminBranchIds.map(() => "?").join(",")})` : "0";
  if (!isApprover(viewer) && viewer.role === "admin") args.push(...viewer.adminBranchIds);
  const where = [`(m.author_id = ? OR EXISTS (SELECT 1 FROM memo_signers s WHERE s.memo_id = m.id AND s.user_id = ?) OR ${branch})`];
  if (opts.status?.length) { where.push(`m.status IN (${opts.status.map(() => "?").join(",")})`); args.push(...opts.status); }
  return (getDb().prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT 300`).all(...args) as Db[]).map(toRow);
}

/** Memos waiting for this person's signature (for the badge and the "to sign" tab). */
export function awaitingMySignature(userId: number): MemoRow[] {
  return (getDb().prepare(`${SELECT} WHERE m.status = 'pending' AND EXISTS (SELECT 1 FROM memo_signers s WHERE s.memo_id = m.id AND s.user_id = ? AND s.status = 'pending') ORDER BY m.id DESC`).all(userId) as Db[]).map(toRow);
}

export function getMemoDetail(id: number): MemoDetail {
  const m = load(id);
  const db = getDb();
  const items = (db.prepare("SELECT line_no, description, qty, unit, unit_price, amount, inventa_item_id FROM memo_items WHERE memo_id = ? ORDER BY line_no").all(id) as Array<{ line_no: number; description: string; qty: number; unit: string; unit_price: number; amount: number; inventa_item_id: number | null }>)
    .map((r) => ({ lineNo: r.line_no, description: r.description, qty: r.qty, unit: r.unit, unitPrice: r.unit_price, amount: r.amount, inventaItemId: r.inventa_item_id }));
  const signers = (db.prepare(`SELECT s.user_id, s.status, s.signed_at, s.comment, s.signature_png, u.display_name, u.title_prefix FROM memo_signers s JOIN users u ON u.id = s.user_id WHERE s.memo_id = ? ORDER BY s.sort_no`).all(id) as
    Array<{ user_id: number; status: MemoSigner["status"]; signed_at: string | null; comment: string; signature_png: string | null; display_name: string; title_prefix: string | null }>)
    .map((r) => ({ userId: r.user_id, name: `${r.title_prefix ?? ""}${r.display_name}`, status: r.status, signedAt: r.signed_at, comment: r.comment, signature: r.signature_png }));
  const events = (db.prepare("SELECT e.created_at, COALESCE(u.display_name, 'ระบบ') AS actor, e.action, e.detail FROM memo_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.memo_id = ? ORDER BY e.id").all(id) as
    Array<{ created_at: string; actor: string; action: string; detail: string }>).map((r) => ({ at: r.created_at, actor: r.actor, action: r.action, detail: r.detail }));
  return { ...m, items, signers, events };
}
