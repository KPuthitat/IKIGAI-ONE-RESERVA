// Chain-of-command structure proof (owner 2026-10-02): the approval tiers,
// users.supervisor_user_id and users.department are ONE linked structure.
//
// Throwaway DB with one branch, 2 executives, 2 heads, 3 staff. Proves:
//   • supervisorOptionsFor: staff → tier-1 heads only; head → tier-2 only;
//     executive → other executives; no branch → nothing
//   • validateSupervisor: self / not_allowed / cycle / not_found / ok
//   • buildAutoOrgChart: executives on top, heads under their executive, staff
//     under their head; issues for unset / wrong-tier supervisors and no ฝ่าย;
//     department headcount
//
// Run:  node --import tsx scripts/test-org-structure.ts   (or: npm run test:org-structure)

import fs from "node:fs";
import path from "node:path";

const TMP = path.join(process.cwd(), "data", "test-org-structure.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
}
cleanup();
fs.mkdirSync(path.dirname(TMP), { recursive: true });
process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const tiers = await import("../src/lib/approval-tiers");
  const org = await import("../src/lib/org-structure");
  const { buildOrgForest } = await import("../src/lib/org-chart-tree");

  let passed = 0, failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };

  const db = getDb();
  const branch = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('org','ORG-BR')").run().lastInsertRowid);
  const mkUser = (name: string, role: string, dept: string | null) => {
    const id = Number(db.prepare(
      "INSERT INTO users (username,password_hash,display_name,role,status,department) VALUES (?,?,?,?,'active',?)"
    ).run(name.toLowerCase(), "x", name, role, dept).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)").run(id, branch);
    return id;
  };
  const execA = mkUser("ExecA", "admin", "management");
  const execB = mkUser("ExecB", "admin", "management");
  const headS = mkUser("HeadService", "staff", "service");
  const headK = mkUser("HeadKitchen", "staff", "kitchen");
  const s1 = mkUser("Staff1", "staff", "service");
  const s2 = mkUser("Staff2", "staff", "kitchen");
  const s3 = mkUser("Staff3", "staff", null);
  const loner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('loner','x','Loner','staff','active')").run().lastInsertRowid);

  tiers.setBranchTierMembers(branch, 2, [execA, execB]);
  tiers.setBranchTierMembers(branch, 1, [headS, headK]);

  // ── ranks + supervisor options ──
  ok("rank: executive / supervisor / staff", org.chainRankOf(execA) === "executive" && org.chainRankOf(headS) === "supervisor" && org.chainRankOf(s1) === "staff");
  const so1 = org.supervisorOptionsFor(s1);
  ok("staff options = the two tier-1 heads only", so1.rank === "staff" && so1.options.map((o) => o.id).sort().join() === [headS, headK].sort().join());
  const soH = org.supervisorOptionsFor(headS);
  ok("head options = the two tier-2 executives only", soH.rank === "supervisor" && soH.options.map((o) => o.id).sort().join() === [execA, execB].sort().join());
  const soE = org.supervisorOptionsFor(execA);
  ok("executive options = the OTHER executive (never self)", soE.rank === "executive" && soE.options.map((o) => o.id).join() === String(execB));
  const soL = org.supervisorOptionsFor(loner);
  ok("no branch → no options + hint", soL.options.length === 0 && soL.hint.includes("ยังไม่สังกัดสาขา"));

  // ── validation ──
  ok("validate: self refused", org.validateSupervisor(s1, s1) === "self");
  ok("validate: staff → another staff refused (not_allowed)", org.validateSupervisor(s1, s2) === "not_allowed");
  ok("validate: staff → executive refused (must be tier 1)", org.validateSupervisor(s1, execA) === "not_allowed");
  ok("validate: staff → head ok", org.validateSupervisor(s1, headS) === null);
  ok("validate: head → staff refused", org.validateSupervisor(headS, s1) === "not_allowed");
  ok("validate: head → executive ok", org.validateSupervisor(headS, execA) === null);
  ok("validate: unknown id → not_found", org.validateSupervisor(s1, 999999) === "not_found");
  ok("validate: null (top) ok", org.validateSupervisor(execA, null) === null);
  // cycle: execA → execB, then execB → execA must be refused
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(execB, execA);
  ok("validate: cycle refused (execB would report to execA who reports to execB)", org.validateSupervisor(execB, execA) === "cycle");
  db.prepare("UPDATE users SET supervisor_user_id = NULL WHERE id = ?").run(execA);

  // ── derived chart ──
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(execA, headS);
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(execA, headK);
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(headS, s1);
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(headK, s2);
  // s3: supervisor set to an executive (wrong tier) and no department
  db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(execB, s3);
  const chart = org.buildAutoOrgChart(branch);
  const forest = buildOrgForest(chart.placements);
  const rootIds = forest.map((n) => n.nodeId).sort();
  ok("chart roots = both executives + the mis-linked staff (surfaced, not hidden)", rootIds.join() === [execA, execB, s3].sort().join());
  const a = forest.find((n) => n.nodeId === execA)!;
  ok("execA has both heads under them", a.children.map((c) => c.nodeId).sort().join() === [headS, headK].sort().join());
  const hs = a.children.find((c) => c.nodeId === headS)!;
  ok("Staff1 sits under HeadService with ฝ่ายบริการ badge", hs.children.length === 1 && hs.children[0].nodeId === s1 && hs.children[0].department === "ฝ่ายบริการ");
  ok("executives sort first, then heads, then staff", chart.placements.find((p) => p.nodeId === execA)!.sortOrder < chart.placements.find((p) => p.nodeId === headS)!.sortOrder && chart.placements.find((p) => p.nodeId === headS)!.sortOrder < chart.placements.find((p) => p.nodeId === s1)!.sortOrder);
  ok("issues: Staff3 supervisor not a head + no ฝ่าย", chart.issues.some((i) => i.userId === s3 && i.kind === "supervisor_not_head") && chart.issues.some((i) => i.userId === s3 && i.kind === "no_department"));
  ok("issues: nothing flagged for the well-linked people", !chart.issues.some((i) => [execA, headS, headK, s1, s2].includes(i.userId)));
  ok("counts: บริการ 2 · ครัว 2 · บริหาร 2 · ยังไม่ระบุ 1", chart.counts.map((c) => `${c.department}:${c.count}`).join() === "service:2,kitchen:2,management:2,null:1");
  // head without an executive link
  db.prepare("UPDATE users SET supervisor_user_id = NULL WHERE id = ?").run(headK);
  const chart2 = org.buildAutoOrgChart(branch);
  ok("issues: head without an executive is flagged and becomes a root", chart2.issues.some((i) => i.userId === headK && i.kind === "head_without_exec") && buildOrgForest(chart2.placements).some((n) => n.nodeId === headK));
  // tier change invalidates a stored supervisor: HeadService dropped from tier 1 → Staff1's link no longer fits
  tiers.setBranchTierMembers(branch, 1, [headK]);
  ok("after dropping HeadService from tier 1, Staff1's stored supervisor is flagged", org.buildAutoOrgChart(branch).issues.some((i) => i.userId === s1 && i.kind === "supervisor_not_head"));
  ok("…and Staff1 can no longer pick HeadService", org.validateSupervisor(s1, headS) === "not_allowed");

  // ── More than one supervisor (owner 2026-10-04) ──
  tiers.setBranchTierMembers(branch, 1, [headS, headK]);
  org.setSupervisors(s1, [headS, headK]);
  ok("a person can have two supervisors, in order", org.supervisorIdsOf(s1).join() === [headS, headK].join());
  ok("users.supervisor_user_id mirrors the first one", (db.prepare("SELECT supervisor_user_id v FROM users WHERE id=?").get(s1) as { v: number }).v === headS);
  ok("both are valid for a plain employee", org.validateSupervisors(s1, [headS, headK]) === null);
  ok("a non-head in the list is refused", org.validateSupervisors(s1, [headS, execA]) === "not_allowed");
  ok("self in the list is refused", org.validateSupervisors(s1, [s1]) === "self");
  const multi = org.buildAutoOrgChart(branch);
  ok("the chart gives Staff1 BOTH heads as parents", multi.placements.find((p) => p.nodeId === s1)!.parentNodeIds.slice().sort().join() === [headS, headK].slice().sort().join());
  const forestMulti = buildOrgForest(multi.placements);
  const under = (headId: number) => forestMulti.flatMap(function walk(n: typeof forestMulti[number]): number[] { return [n.nodeId, ...n.children.flatMap(walk)]; }).length > 0
    && JSON.stringify(forestMulti).includes(`"nodeId":${s1}`);
  ok("Staff1 appears under each head in the drawn tree", under(headS) && (JSON.stringify(forestMulti).match(new RegExp(`"nodeId":${s1}[,}]`, "g")) ?? []).length >= 2);
  ok("no 'no supervisor' issue for a multi-supervised person", !multi.issues.some((i) => i.userId === s1));
  // cycle through the second supervisor: HeadK reporting to Staff1 would loop (HeadK → Staff1 → HeadK)
  ok("a cycle through ANY supervisor is refused", org.validateSupervisor(headK, s1) !== null);
  org.setSupervisors(s1, []);
  ok("clearing the list clears the column too", org.supervisorIdsOf(s1).length === 0 && (db.prepare("SELECT supervisor_user_id v FROM users WHERE id=?").get(s1) as { v: number | null }).v === null);

  console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
