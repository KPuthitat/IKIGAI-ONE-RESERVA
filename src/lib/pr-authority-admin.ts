// Editing the approval authority (owner only): tiers per account, the account's own approvers, who is the top executive.
import { getDb, logPersonaAction } from "./db";
import { accountApproverIds, executiveIds, tiersFor, type Rule, type Tier } from "./pr-authority";

export class AuthorityError extends Error { constructor(public code: "invalid" | "not_found", msg: string) { super(msg); } }
const RULES = new Set(["one_exec", "two_execs_or_top", "top_only"]);

export function authoritySnapshot() {
  const db = getDb();
  const accounts = (db.prepare("SELECT id, name, bank_name, account_no, purpose FROM accounta_cash_accounts WHERE type = 'bank' AND active = 1 ORDER BY sort_order, name").all() as Array<{ id: number; name: string; bank_name: string | null; account_no: string | null; purpose: string | null }>)
    .map((a) => ({ id: a.id, name: a.name, last4: a.account_no ? a.account_no.replace(/\D/g, "").slice(-4) || null : null, purpose: a.purpose,
      ownTiers: ownTiers(a.id), approverIds: accountApproverIds(a.id), effective: tiersFor(a.id) }));
  const people = (db.prepare(`SELECT id, display_name, title_prefix, role, COALESCE(is_c_level,0) AS c, COALESCE(is_top_exec,0) AS top FROM users
      WHERE status NOT IN ('disabled','resigned','terminated') AND COALESCE(is_test_account,0) = 0 AND (role IN ('admin','super_admin') OR COALESCE(is_c_level,0) = 1 OR COALESCE(is_top_exec,0) = 1) ORDER BY top DESC, c DESC, display_name`).all() as
    Array<{ id: number; display_name: string; title_prefix: string | null; role: string; c: number; top: number }>)
    .map((u) => ({ id: u.id, name: `${u.title_prefix ?? ""}${u.display_name}`, role: u.role, cLevel: u.c === 1, top: u.top === 1 }));
  return { accounts, globalTiers: ownTiers(null), defaultTiers: tiersFor(null), people, executiveIds: executiveIds() };
}
function ownTiers(accountId: number | null): Tier[] {
  const rows = getDb().prepare(`SELECT id, account_id, up_to, rule, sort_no FROM pr_approval_tiers WHERE ${accountId == null ? "account_id IS NULL" : "account_id = ?"} ORDER BY COALESCE(up_to, 1e18), id`).all(...(accountId == null ? [] : [accountId])) as Array<{ id: number; account_id: number | null; up_to: number | null; rule: Rule; sort_no: number }>;
  return rows.map((r) => ({ id: r.id, accountId: r.account_id, upTo: r.up_to, rule: r.rule, sortNo: r.sort_no }));
}

/** Replace the tiers of one account (or the company-wide ones). Limits must rise; the last tier has no limit. An empty list removes them (back to the default). */
export function setTiers(accountId: number | null, tiers: Array<{ upTo: number | null; rule: string }>, userId: number): void {
  const db = getDb();
  if (accountId != null && !db.prepare("SELECT 1 FROM accounta_cash_accounts WHERE id = ? AND type = 'bank'").get(accountId)) throw new AuthorityError("not_found", "ไม่พบบัญชี");
  if (tiers.length > 8) throw new AuthorityError("invalid", "ตั้งได้ไม่เกิน 8 ขั้น");
  tiers.forEach((t, i) => {
    if (!RULES.has(t.rule)) throw new AuthorityError("invalid", "เกณฑ์ไม่ถูกต้อง");
    const last = i === tiers.length - 1;
    if (last ? t.upTo != null : !(typeof t.upTo === "number" && t.upTo > 0 && Number.isFinite(t.upTo))) throw new AuthorityError("invalid", last ? "ขั้นสุดท้ายต้องไม่จำกัดยอด" : "ทุกขั้นก่อนขั้นสุดท้ายต้องระบุยอดสูงสุดเป็นตัวเลขมากกว่า 0");
    if (i > 0 && !(t.upTo == null || (tiers[i - 1].upTo != null && t.upTo > (tiers[i - 1].upTo as number)))) throw new AuthorityError("invalid", "ยอดของแต่ละขั้นต้องเพิ่มขึ้นตามลำดับ");
  });
  db.transaction(() => {
    db.prepare(`DELETE FROM pr_approval_tiers WHERE ${accountId == null ? "account_id IS NULL" : "account_id = ?"}`).run(...(accountId == null ? [] : [accountId]));
    const ins = db.prepare("INSERT INTO pr_approval_tiers (account_id, up_to, rule, sort_no) VALUES (?,?,?,?)");
    tiers.forEach((t, i) => ins.run(accountId, t.upTo, t.rule, i + 1));
  })();
  logPersonaAction(userId, accountId == null ? "authority.tiers.global" : "authority.tiers.account", accountId ?? 0);
}

export function setAccountApprovers(accountId: number, userIds: number[], userId: number): void {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM accounta_cash_accounts WHERE id = ? AND type = 'bank'").get(accountId)) throw new AuthorityError("not_found", "ไม่พบบัญชี");
  const ok = new Set(executiveIds());
  const ids = [...new Set(userIds)];
  if (ids.some((id) => !ok.has(id))) throw new AuthorityError("invalid", "ผู้อนุมัติประจำบัญชีต้องเป็นผู้บริหาร");
  db.transaction(() => {
    db.prepare("DELETE FROM account_approvers WHERE account_id = ?").run(accountId);
    const ins = db.prepare("INSERT INTO account_approvers (account_id, user_id) VALUES (?,?)");
    ids.forEach((id) => ins.run(accountId, id));
  })();
  logPersonaAction(userId, "authority.approvers", accountId);
}

export function setTopExec(targetId: number, value: boolean, userId: number): void {
  const r = getDb().prepare("UPDATE users SET is_top_exec = ? WHERE id = ?").run(value ? 1 : 0, targetId);
  if (!r.changes) throw new AuthorityError("not_found", "ไม่พบผู้ใช้");
  logPersonaAction(userId, value ? "authority.top_exec.on" : "authority.top_exec.off", targetId);
}
