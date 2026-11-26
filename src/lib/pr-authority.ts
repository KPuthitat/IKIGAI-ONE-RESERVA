// Who may approve a PR, and how many approvals it needs (owner 2026-11-26, round 2).
//
// A PR is paid from one company account. The rule depends on the PR's total and is read from tiers kept per account (or company-wide for
// accounts without their own tiers); with no tiers at all the rule is "two executives, or the top executive alone".
//   one_exec          one approver: the account's own approvers when it has any (e.g. the procurement-side executive for KBANK), else any executive
//   two_execs_or_top  two different executives, or one top executive
//   top_only          one top executive
// Executives = users flagged C-level, plus super admins. Top executives = users flagged "ผู้บริหารสูงสุด"; if nobody is flagged yet, super
// admins stand in (so the system never locks up before the owner sets the flag).
import { getDb } from "./db";

export type Rule = "one_exec" | "two_execs_or_top" | "top_only";
export const RULE_TH: Record<Rule, string> = { one_exec: "ผู้บริหาร 1 คน", two_execs_or_top: "ผู้บริหาร 2 คน หรือผู้บริหารสูงสุด 1 คน", top_only: "ผู้บริหารสูงสุดเท่านั้น" };
export type Tier = { id: number | null; accountId: number | null; upTo: number | null; rule: Rule; sortNo: number };

const ACTIVE = "status NOT IN ('disabled','resigned','terminated') AND COALESCE(is_test_account, 0) = 0";
const round2 = (n: number) => Math.round(n * 100) / 100;

export function executiveIds(): number[] {
  return (getDb().prepare(`SELECT id FROM users WHERE (COALESCE(is_c_level, 0) = 1 OR role = 'super_admin' OR COALESCE(is_top_exec, 0) = 1) AND ${ACTIVE}`).all() as Array<{ id: number }>).map((r) => r.id);
}
export function topExecIds(): number[] {
  const db = getDb();
  const flagged = (db.prepare(`SELECT id FROM users WHERE COALESCE(is_top_exec, 0) = 1 AND ${ACTIVE}`).all() as Array<{ id: number }>).map((r) => r.id);
  if (flagged.length) return flagged;
  return (db.prepare(`SELECT id FROM users WHERE role = 'super_admin' AND ${ACTIVE}`).all() as Array<{ id: number }>).map((r) => r.id);
}
export const accountApproverIds = (accountId: number): number[] =>
  (getDb().prepare("SELECT a.user_id FROM account_approvers a JOIN users u ON u.id = a.user_id WHERE a.account_id = ? AND u.status NOT IN ('disabled','resigned','terminated') AND COALESCE(u.is_test_account, 0) = 0").all(accountId) as Array<{ user_id: number }>).map((r) => r.user_id);

/** The tiers that apply to a PR paid from `accountId`: the account's own, else the company-wide ones, else the default. Sorted by limit (no limit last). */
export function tiersFor(accountId: number | null): Tier[] {
  const db = getDb();
  const read = (acc: number | null) => (db.prepare(`SELECT id, account_id, up_to, rule, sort_no FROM pr_approval_tiers WHERE ${acc == null ? "account_id IS NULL" : "account_id = ?"}`).all(...(acc == null ? [] : [acc])) as Array<{ id: number; account_id: number | null; up_to: number | null; rule: Rule; sort_no: number }>)
    .map((r) => ({ id: r.id, accountId: r.account_id, upTo: r.up_to, rule: r.rule, sortNo: r.sort_no }));
  let t: Tier[] = accountId != null ? read(accountId) : [];
  if (!t.length) t = read(null);
  if (!t.length) t = [{ id: null, accountId: null, upTo: null, rule: "two_execs_or_top", sortNo: 0 }];
  return t.sort((a, b) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity));
}
export function ruleFor(accountId: number | null, total: number): Rule {
  const tiers = tiersFor(accountId);
  return (tiers.find((t) => t.upTo == null || round2(total) <= t.upTo) ?? tiers[tiers.length - 1]).rule;
}

/** Who may press "approve" on a PR under this rule. */
export function eligibleApprovers(accountId: number | null, rule: Rule): number[] {
  if (rule === "top_only") return topExecIds();
  if (rule === "one_exec" && accountId != null) { const own = accountApproverIds(accountId); if (own.length) return own; }
  return [...new Set([...executiveIds(), ...topExecIds()])];
}
export const canApprove = (userId: number, accountId: number | null, rule: Rule): boolean => eligibleApprovers(accountId, rule).includes(userId);

export type ApprovalState = {
  rule: Rule; ruleText: string; approved: boolean; approvals: Array<{ userId: number; name: string; decision: "approve" | "reject"; note: string; at: string; top: boolean }>;
  approveCount: number; remainingText: string; eligible: Array<{ id: number; name: string }>;
};
const nameOf = (id: number) => { const u = getDb().prepare("SELECT display_name, title_prefix FROM users WHERE id = ?").get(id) as { display_name: string; title_prefix: string | null } | undefined; return u ? `${u.title_prefix ?? ""}${u.display_name}` : `#${id}`; };

/** Where a submitted PR stands against its rule. */
export function approvalState(prId: number): ApprovalState {
  const db = getDb();
  const pr = db.prepare("SELECT pay_account_id, total FROM purchase_requests WHERE id = ?").get(prId) as { pay_account_id: number | null; total: number } | undefined;
  const rule = ruleFor(pr?.pay_account_id ?? null, pr?.total ?? 0);
  const tops = new Set(topExecIds());
  const rows = db.prepare("SELECT user_id, decision, note, decided_at FROM pr_approvals WHERE pr_id = ? ORDER BY id").all(prId) as Array<{ user_id: number; decision: "approve" | "reject"; note: string; decided_at: string }>;
  const approvals = rows.map((r) => ({ userId: r.user_id, name: nameOf(r.user_id), decision: r.decision, note: r.note, at: r.decided_at, top: tops.has(r.user_id) }));
  const ok = approvals.filter((a) => a.decision === "approve");
  const approved = rule === "top_only" ? ok.some((a) => a.top) : rule === "one_exec" ? ok.length >= 1 : ok.some((a) => a.top) || ok.length >= 2;
  const remainingText = approved ? "ครบตามเกณฑ์" : rule === "two_execs_or_top" ? (ok.length === 0 ? "รอผู้บริหาร 2 คน หรือผู้บริหารสูงสุด 1 คน" : "รอผู้บริหารอีก 1 คน หรือผู้บริหารสูงสุด") : rule === "top_only" ? "รอผู้บริหารสูงสุด" : "รอผู้บริหารที่มีสิทธิ์อนุมัติ 1 คน";
  const eligible = eligibleApprovers(pr?.pay_account_id ?? null, rule).filter((id) => !rows.some((r) => r.user_id === id)).map((id) => ({ id, name: nameOf(id) }));
  return { rule, ruleText: RULE_TH[rule], approved, approvals, approveCount: ok.length, remainingText, eligible };
}
