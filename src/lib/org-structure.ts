// Chain of command as ONE linked structure (owner 2026-10-02: "ออกแบบสายบังคับ
// บัญชาทั้งสามส่วนนี้ให้เชื่อมโยงกัน").
//
//   branch_approval_tiers  tier 2 = ผู้บริหาร, tier 1 = หัวหน้างาน   (per branch)
//   users.supervisor_user_id                                        (per person)
//   users.department        ฝ่ายบริการ / ครัว / บริหาร / อื่นๆ         (per person)
//
// A person may report to MORE THAN ONE supervisor (owner 2026-10-04): the list lives in
// user_supervisors; users.supervisor_user_id keeps the first one for older readers.
//
// Rules (applied to EACH supervisor):
//   • a plain employee's supervisor must be a tier-1 member of one of their branches
//   • a tier-1 member's supervisor must be a tier-2 member of one of their branches
//   • a tier-2 member may report to another tier-2 member, or nobody (top)
//   • never yourself, never a cycle
// The org chart is DERIVED from these three sources — nothing is drawn by hand.

import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import type { OrgPlacementBase } from "./org-chart-tree";
import { DEPARTMENT_KEYS, departmentLabel, type ChainRank } from "./org-vocab";

const ACTIVE = "u.status NOT IN ('disabled','resigned','terminated') AND u.is_test_account = 0";

export type ChainPerson = { id: number; display_name: string; title_prefix: string | null; nickname_th: string | null; job_title: string | null; department: string | null; supervisor_user_id: number | null; supervisor_ids: number[]; role: string };

/** A person's supervisors in order (first = primary). Falls back to the single column. */
export function supervisorIdsOf(userId: number): number[] {
  const db = getDb();
  const rows = db.prepare("SELECT supervisor_user_id FROM user_supervisors WHERE user_id = ? ORDER BY sort_order, supervisor_user_id").all(userId) as Array<{ supervisor_user_id: number }>;
  if (rows.length) return rows.map((r) => r.supervisor_user_id);
  const one = (db.prepare("SELECT supervisor_user_id FROM users WHERE id = ?").get(userId) as { supervisor_user_id: number | null } | undefined)?.supervisor_user_id;
  return one != null ? [one] : [];
}

function branchIdsOf(userId: number): number[] {
  return (getDb().prepare("SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id").all(userId) as Array<{ branch_id: number }>).map((r) => r.branch_id);
}
function tierUserIds(branchIds: number[], tier: 1 | 2): Set<number> {
  if (!branchIds.length) return new Set();
  const rows = getDb().prepare(
    `SELECT DISTINCT t.user_id FROM branch_approval_tiers t JOIN users u ON u.id = t.user_id
     WHERE t.tier_level = ? AND t.branch_id IN (${branchIds.map(() => "?").join(",")}) AND ${ACTIVE}`
  ).all(tier, ...branchIds) as Array<{ user_id: number }>;
  return new Set(rows.map((r) => r.user_id));
}
function people(ids: Iterable<number>): ChainPerson[] {
  const list = [...ids];
  if (!list.length) return [];
  const rows = getDb().prepare(
    `SELECT u.id, u.display_name, u.title_prefix, u.nickname_th, u.job_title, u.department, u.supervisor_user_id, u.role
     FROM users u WHERE u.id IN (${list.map(() => "?").join(",")}) AND ${ACTIVE} ORDER BY u.display_name`
  ).all(...list) as Array<Omit<ChainPerson, "supervisor_ids">>;
  return rows.map((r) => ({ ...r, supervisor_ids: supervisorIdsOf(r.id) }));
}

/** Where this person sits in the chain, across the branches they belong to. */
export function chainRankOf(userId: number, branchIds = branchIdsOf(userId)): ChainRank {
  if (tierUserIds(branchIds, 2).has(userId)) return "executive";
  if (tierUserIds(branchIds, 1).has(userId)) return "supervisor";
  return "staff";
}

export type SupervisorOptions = {
  rank: ChainRank;
  options: Array<{ id: number; display_name: string; title_prefix: string | null }>;
  hint: string;                        // why the list is what it is (shown under the select)
  branchIds: number[];
};

/** Who may be chosen as this person's supervisor — the tier above them in
 *  their own branches (owner 2026-10-02: the dropdown lists ONLY tier-1 heads for
 *  staff, ONLY tier-2 executives for a tier-1 head). */
export function supervisorOptionsFor(userId: number): SupervisorOptions {
  const branchIds = branchIdsOf(userId);
  const rank = chainRankOf(userId, branchIds);
  const pool = rank === "staff" ? tierUserIds(branchIds, 1) : tierUserIds(branchIds, 2);
  pool.delete(userId);
  const options = people(pool).map((p) => ({ id: p.id, display_name: p.display_name, title_prefix: p.title_prefix }));
  const hint = !branchIds.length
    ? "พนักงานยังไม่สังกัดสาขา — ตั้งสาขาก่อนจึงเลือกผู้บังคับบัญชาได้"
    : rank === "staff"
      ? (options.length ? "เลือกได้เฉพาะหัวหน้างาน (ชั้นที่ 1) ของสาขาที่สังกัด — ตั้งที่เมนู สายบังคับบัญชา"
                        : "สาขาที่สังกัดยังไม่ได้ตั้งหัวหน้างาน (ชั้นที่ 1) — ตั้งที่เมนู สายบังคับบัญชา ก่อน")
      : rank === "supervisor"
        ? (options.length ? "คนนี้เป็นหัวหน้างาน (ชั้นที่ 1) — ผู้บังคับบัญชาต้องเป็นผู้บริหาร (ชั้นที่ 2) เท่านั้น"
                          : "คนนี้เป็นหัวหน้างาน (ชั้นที่ 1) แต่สาขายังไม่ได้ตั้งผู้บริหาร (ชั้นที่ 2)")
        : "คนนี้เป็นผู้บริหาร (ชั้นที่ 2) — เลือกผู้บริหารคนอื่น หรือเว้นว่าง (บนสุด)";
  return { rank, options, hint, branchIds };
}

export type SupervisorError = "self" | "not_allowed" | "cycle" | "not_found";

/** Enforce the tier rule + no cycles before adding ONE supervisor to a person. */
export function validateSupervisor(userId: number, supervisorId: number | null): SupervisorError | null {
  if (supervisorId == null) return null;
  if (supervisorId === userId) return "self";
  const db = getDb();
  const sup = db.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${ACTIVE}`).get(supervisorId);
  if (!sup) return "not_found";
  const { options } = supervisorOptionsFor(userId);
  if (!options.some((o) => o.id === supervisorId)) return "not_allowed";
  // Walk up from the proposed supervisor through ALL of each person's supervisors;
  // reaching userId again = cycle.
  const seen = new Set<number>();
  const stack: number[] = [supervisorId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === userId) return "cycle";
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of supervisorIdsOf(cur)) stack.push(nxt);
  }
  return null;
}

/** Validate a whole list (each entry by the tier + cycle rules, no duplicates). First
 *  error wins. */
export function validateSupervisors(userId: number, supervisorIds: number[]): SupervisorError | null {
  const uniq = [...new Set(supervisorIds)];
  for (const id of uniq) {
    const err = validateSupervisor(userId, id);
    if (err) return err;
  }
  return null;
}

/** Store a person's supervisors (replace the list); users.supervisor_user_id mirrors the first. */
export function setSupervisors(userId: number, supervisorIds: number[]): void {
  const db = getDb();
  const uniq = [...new Set(supervisorIds.filter((id) => id !== userId))];
  db.transaction(() => {
    db.prepare("DELETE FROM user_supervisors WHERE user_id = ?").run(userId);
    const ins = db.prepare("INSERT INTO user_supervisors (user_id, supervisor_user_id, sort_order) VALUES (?, ?, ?)");
    uniq.forEach((sid, i) => ins.run(userId, sid, i));
    db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(uniq[0] ?? null, userId);
  })();
}

export const SUPERVISOR_ERROR_TH: Record<SupervisorError, string> = {
  self: "ตั้งตัวเองเป็นผู้บังคับบัญชาไม่ได้",
  not_allowed: "ผู้บังคับบัญชาต้องเป็นคนในชั้นที่สูงกว่าของสาขาที่สังกัด (พนักงาน → หัวหน้างาน, หัวหน้างาน → ผู้บริหาร) — ตั้งชั้นที่เมนู สายบังคับบัญชา",
  cycle: "ตั้งไม่ได้ — จะเกิดวงจร (คนนี้อยู่ใต้สายของพนักงานคนนี้อยู่แล้ว)",
  not_found: "ไม่พบผู้บังคับบัญชาที่เลือก"
};

// ── Derived org chart ──────────────────────────────────────────────────────

export type OrgIssue = { userId: number; name: string; kind: "no_supervisor" | "supervisor_not_head" | "head_without_exec" | "no_department"; text: string };
export type AutoOrgChart = {
  placements: OrgPlacementBase[];       // nodeId = userId; parentNodeIds = every supervisor on this chart
  issues: OrgIssue[];
  counts: Array<{ department: string | null; label: string; count: number }>;
  tier1: number[]; tier2: number[];
};

/** Build a branch's chart from the tiers + each person's supervisor and ฝ่าย. */
export function buildAutoOrgChart(branchId: number): AutoOrgChart {
  const db = getDb();
  const t2 = tierUserIds([branchId], 2), t1 = tierUserIds([branchId], 1);
  const memberIds = (db.prepare(
    `SELECT DISTINCT u.id FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND ${ACTIVE} AND u.role IN ('staff','admin','super_admin')`
  ).all(branchId) as Array<{ id: number }>).map((r) => r.id);
  const ids = new Set<number>([...memberIds, ...t1, ...t2]);
  const persons = people(ids);
  const onChart = new Set(persons.map((p) => p.id));
  // Display rank = this branch's tiers (where the box sits on THIS chart).
  const rankOf = (id: number): ChainRank => (t2.has(id) ? "executive" : t1.has(id) ? "supervisor" : "staff");
  const sortOrder = (id: number) => (rankOf(id) === "executive" ? 0 : rankOf(id) === "supervisor" ? 10 : 20);
  // Link validity = the SAME rule the employee page enforces (the union of the
  // person's own branches), so a multi-branch person whose supervisor is a head
  // in their other branch is never flagged here but allowed there.
  const unionRank = new Map<number, ChainRank>();
  const rankAcross = (id: number): ChainRank => {
    if (!unionRank.has(id)) unionRank.set(id, chainRankOf(id));
    return unionRank.get(id)!;
  };
  const issues: OrgIssue[] = [];
  const placements: OrgPlacementBase[] = persons.map((p) => {
    const rank = rankAcross(p.id);
    const name = nameWithPrefix(p.title_prefix, p.display_name);
    // Every supervisor that sits on this chart and fits the tier rule becomes a parent
    // (a person may report to several, owner 2026-10-04).
    const parents: number[] = [];
    let wrongTier = false;
    for (const sup of p.supervisor_ids) {
      if (!onChart.has(sup)) continue;
      const supRank = rankAcross(sup);
      const ok = rank === "staff" ? supRank === "supervisor" : rank === "supervisor" ? supRank === "executive" : supRank === "executive";
      if (ok) parents.push(sup); else wrongTier = true;
    }
    if (wrongTier && parents.length === 0) {
      issues.push({ userId: p.id, name, kind: rank === "supervisor" ? "head_without_exec" : "supervisor_not_head",
        text: rank === "supervisor" ? `${name} เป็นหัวหน้างาน แต่ผู้บังคับบัญชาที่ตั้งไว้ไม่ใช่ผู้บริหาร (ชั้นที่ 2)` : `${name} ผู้บังคับบัญชาที่ตั้งไว้ไม่ได้อยู่ในชั้นหัวหน้างาน (ชั้นที่ 1) ของสาขานี้` });
    } else if (parents.length === 0 && rank !== "executive") {
      issues.push({ userId: p.id, name, kind: rank === "supervisor" ? "head_without_exec" : "no_supervisor",
        text: rank === "supervisor" ? `${name} เป็นหัวหน้างาน แต่ยังไม่ได้ระบุผู้บริหารที่ขึ้นตรง` : `${name} ยังไม่ได้ระบุผู้บังคับบัญชา` });
    }
    if (!p.department) issues.push({ userId: p.id, name, kind: "no_department", text: `${name} ยังไม่ได้ระบุฝ่าย` });
    return {
      nodeId: p.id, userId: p.id, displayName: p.display_name, titlePrefix: p.title_prefix, nickname: p.nickname_th,
      jobTitle: p.job_title, role: p.role, department: departmentLabel(p.department), sortOrder: sortOrder(p.id),
      parentNodeIds: parents
    };
  });
  // Department headcount (members of this branch only, not borrowed executives).
  const countMap = new Map<string | null, number>();
  for (const p of persons) if (memberIds.includes(p.id)) countMap.set(p.department, (countMap.get(p.department) ?? 0) + 1);
  const counts = [...DEPARTMENT_KEYS, null].filter((k) => countMap.has(k))
    .map((k) => ({ department: k, label: k ? departmentLabel(k)! : "ยังไม่ระบุฝ่าย", count: countMap.get(k)! }));
  return { placements, issues, counts, tier1: [...t1], tier2: [...t2] };
}
