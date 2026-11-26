// Weekly funding between company accounts (owner 2026-11-26): procurement asks for the week's money (a memo of kind "funding"); once
// signed it is an "awaiting" transfer; finance makes it at the bank and records it here (date + the amount actually sent, with a PIN).
// The recorded amount is what the receiving account (KBANK) has available for purchases, and a PR that goes over it is warned about —
// never blocked. A transfer seen on both bank statements marks it recorded by itself (see bank-recon).
import { getDb, logPersonaAction } from "./db";
import { verifyAdminPin } from "./admin-pin";

export class FundingError extends Error { constructor(public code: "not_found" | "bad_status" | "bad_pin" | "no_pin" | "invalid", msg: string) { super(msg); } }
const round2 = (n: number) => Math.round(n * 100) / 100;

export type Transfer = {
  id: number; memoId: number; memoNo: string; subject: string; fromAccountId: number; fromName: string; toAccountId: number; toName: string; weekStart: string | null;
  amount: number; status: "awaiting" | "transferred" | "cancelled"; transferredOn: string | null; actualAmount: number | null; transferredByName: string | null; note: string; createdAt: string; autoLinked: boolean;
};
const SELECT = `SELECT t.*, m.memo_no, m.subject, fa.name AS from_name, ta.name AS to_name, u.display_name AS by_name
  FROM fund_transfers t JOIN memos m ON m.id = t.memo_id JOIN accounta_cash_accounts fa ON fa.id = t.from_account_id JOIN accounta_cash_accounts ta ON ta.id = t.to_account_id LEFT JOIN users u ON u.id = t.transferred_by`;
type Db = { id: number; memo_id: number; memo_no: string; subject: string; from_account_id: number; from_name: string; to_account_id: number; to_name: string; week_start: string | null; amount: number; status: Transfer["status"];
  transferred_on: string | null; actual_amount: number | null; by_name: string | null; note: string; created_at: string; out_line_id: number | null };
const toRow = (r: Db): Transfer => ({ id: r.id, memoId: r.memo_id, memoNo: r.memo_no, subject: r.subject, fromAccountId: r.from_account_id, fromName: r.from_name, toAccountId: r.to_account_id, toName: r.to_name, weekStart: r.week_start,
  amount: r.amount, status: r.status, transferredOn: r.transferred_on, actualAmount: r.actual_amount, transferredByName: r.by_name, note: r.note, createdAt: r.created_at, autoLinked: r.out_line_id != null });

export function listTransfers(status?: Transfer["status"]): Transfer[] {
  return (getDb().prepare(`${SELECT} ${status ? "WHERE t.status = ?" : ""} ORDER BY t.id DESC LIMIT 300`).all(...(status ? [status] : [])) as Db[]).map(toRow);
}
export const countAwaiting = (): number => (getDb().prepare("SELECT COUNT(*) n FROM fund_transfers WHERE status = 'awaiting'").get() as { n: number }).n;

/** Finance records that the transfer was made. The PIN is the person's own; the amount actually sent may differ from the approved one. */
export function markTransferred(id: number, d: { transferredOn: string; actualAmount?: number | null; note?: string }, userId: number, pin: string): Transfer {
  const p = verifyAdminPin(userId, (pin ?? "").trim());
  if (!p.ok) throw new FundingError(p.reason === "no_pin" ? "no_pin" : "bad_pin", p.reason === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : "PIN ไม่ถูกต้อง");
  const db = getDb();
  const t = db.prepare("SELECT status, amount FROM fund_transfers WHERE id = ?").get(id) as { status: string; amount: number } | undefined;
  if (!t) throw new FundingError("not_found", "ไม่พบรายการโอน");
  if (t.status !== "awaiting") throw new FundingError("bad_status", "รายการนี้บันทึกหรือยกเลิกไปแล้ว");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.transferredOn)) throw new FundingError("invalid", "วันที่ไม่ถูกต้อง");
  const actual = round2(d.actualAmount ?? t.amount);
  if (!(actual > 0) || !Number.isFinite(actual)) throw new FundingError("invalid", "ยอดที่โอนไม่ถูกต้อง");
  db.prepare("UPDATE fund_transfers SET status = 'transferred', transferred_on = ?, actual_amount = ?, transferred_by = ?, note = ? WHERE id = ?").run(d.transferredOn, actual, userId, (d.note ?? "").trim().slice(0, 300), id);
  logPersonaAction(userId, "funding.transferred", id);
  return toRow(db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Db);
}

export function cancelTransfer(id: number, userId: number): void {
  const r = getDb().prepare("UPDATE fund_transfers SET status = 'cancelled' WHERE id = ? AND status = 'awaiting'").run(id);
  if (!r.changes) throw new FundingError("bad_status", "ยกเลิกไม่ได้ (บันทึกโอนแล้วหรือไม่พบรายการ)");
  logPersonaAction(userId, "funding.cancelled", id);
}

/** Money the account has received through funding, less what approved PRs paid from it have claimed. */
export type FundSummary = { tracked: boolean; received: number; committed: number; remaining: number };
export function fundSummary(accountId: number, excludePrId?: number): FundSummary {
  const db = getDb();
  const rec = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(actual_amount, amount)), 0) AS s FROM fund_transfers WHERE to_account_id = ? AND status = 'transferred'").get(accountId) as { n: number; s: number };
  const any = (db.prepare("SELECT COUNT(*) n FROM fund_transfers WHERE to_account_id = ? AND status <> 'cancelled'").get(accountId) as { n: number }).n;
  const com = db.prepare("SELECT COALESCE(SUM(total), 0) s FROM purchase_requests WHERE pay_account_id = ? AND status IN ('approved','ordered','received','closed') AND id <> ?").get(accountId, excludePrId ?? 0) as { s: number };
  return { tracked: any > 0, received: round2(rec.s), committed: round2(com.s), remaining: round2(rec.s - com.s) };
}
/** For a PR: is it paid from an account that is funded by transfers, and does it go beyond what was transferred? (a warning, never a block) */
export function fundWarning(pr: { id: number; payAccountId: number | null; total: number }): (FundSummary & { over: boolean; shortBy: number }) | null {
  if (pr.payAccountId == null) return null;
  const f = fundSummary(pr.payAccountId, pr.id);
  if (!f.tracked) return null;
  const over = round2(pr.total) > f.remaining + 0.004;
  return { ...f, over, shortBy: over ? round2(pr.total - f.remaining) : 0 };
}

/** Called by the bank reconciliation when two statement lines are matched as one transfer: if it is the awaited funding transfer, record it. */
export function autoMarkFromBank(out: { id: number; account_id: number; tx_date: string; debit: number }, inn: { id: number; account_id: number; credit: number }, actorId: number): number | null {
  const db = getDb();
  const t = db.prepare("SELECT id FROM fund_transfers WHERE status = 'awaiting' AND from_account_id = ? AND to_account_id = ? AND ABS(amount - ?) < 0.005 ORDER BY id LIMIT 1").get(out.account_id, inn.account_id, out.debit) as { id: number } | undefined;
  if (!t) return null;
  db.prepare("UPDATE fund_transfers SET status = 'transferred', transferred_on = ?, actual_amount = ?, transferred_by = ?, out_line_id = ?, in_line_id = ?, note = 'บันทึกจากการกระทบยอดธนาคาร' WHERE id = ?").run(out.tx_date, out.debit, actorId, out.id, inn.id, t.id);
  logPersonaAction(actorId, "funding.transferred_by_bank", t.id);
  return t.id;
}
/** Un-matching the bank lines puts an auto-recorded transfer back to awaiting. */
export function undoAutoMark(lineId: number): void {
  getDb().prepare("UPDATE fund_transfers SET status = 'awaiting', transferred_on = NULL, actual_amount = NULL, transferred_by = NULL, out_line_id = NULL, in_line_id = NULL, note = '' WHERE (out_line_id = ? OR in_line_id = ?) AND status = 'transferred'").run(lineId, lineId);
}
