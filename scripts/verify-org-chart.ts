// Fixture: org-chart tree building + cycle prevention (owner 2026-08-24).
// buildOrgTree turns flat org_chart_nodes rows into a forest by reports_to,
// promoting orphans (manager not on the chart) to roots; wouldCreateCycle
// blocks a manager assignment that would loop the tree.
// Run:  node --import tsx scripts/verify-org-chart.ts
import { buildOrgTree, wouldCreateCycle, type OrgMember } from "../src/lib/org-chart";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const mk = (userId: number, reportsToUserId: number | null, sortOrder = 100): OrgMember => ({
  userId, reportsToUserId, sortOrder,
  displayName: `U${userId}`, titlePrefix: null, nickname: null, jobTitle: null, role: "staff", department: null
});

// ── buildOrgTree ────────────────────────────────────────────────────
// A(root) → B → D ; A → C. One root, B before C by sort.
const members = [mk(1, null, 10), mk(2, 1, 10), mk(3, 1, 20), mk(4, 2, 10)];
const roots = buildOrgTree(members);
assert(roots.length === 1 && roots[0].userId === 1, `single root = A (got ${roots.map((r) => r.userId)})`);
assert(roots[0].children.map((c) => c.userId).join(",") === "2,3", `A's reports = B,C in sort order`);
const b = roots[0].children.find((c) => c.userId === 2)!;
assert(b.children.length === 1 && b.children[0].userId === 4, `B's report = D`);

// Orphan: manager 999 not on chart → promoted to root, not dropped.
const orphanRoots = buildOrgTree([mk(1, null), mk(5, 999)]);
assert(orphanRoots.some((r) => r.userId === 5), `orphan (manager off-chart) promoted to root`);
assert(orphanRoots.length === 2, `no member is lost (2 roots)`);

// ── wouldCreateCycle ────────────────────────────────────────────────
// Chain A ← B ← C (C reports B reports A).
const chain = [mk(1, null), mk(2, 1), mk(3, 2)];
assert(wouldCreateCycle(chain, 1, 1) === true, `self-manager is a cycle`);
assert(wouldCreateCycle(chain, 1, 3) === true, `A→manager C loops (C is under A)`);
assert(wouldCreateCycle(chain, 2, 3) === true, `B→manager C loops (C is under B)`);
assert(wouldCreateCycle(chain, 3, 1) === false, `C→manager A is fine (A is above C)`);
assert(wouldCreateCycle(chain, 1, 2) === true, `A→manager B loops (B is under A)`);

// Defensive: a persisted data cycle must NOT hang buildOrgTree (it promotes
// looping nodes to roots instead of recursing forever).
const cyclic = [mk(1, 2), mk(2, 1), mk(3, 1)];   // 1↔2 loop, 3 under 1
const cyclicRoots = buildOrgTree(cyclic);
assert(cyclicRoots.length >= 1, `cyclic data still yields roots (no hang)`);
assert(cyclicRoots.every((r) => r.children.every((c) => c.userId !== r.userId)),
  `no node is its own descendant after cycle-break`);

console.log("\nALL ORG-CHART FIXTURES PASSED");
