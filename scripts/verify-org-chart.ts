// Fixture: org-chart v2 — placements + multi-parent (owner 2026-08-24).
// A placement can sit under more than one parent (appears under each), the same
// person can be placed more than once, and cycles are blocked / render-safe.
// Run:  node --import tsx scripts/verify-org-chart.ts
import { buildOrgForest, wouldCreateCycle, type OrgPlacementBase as OrgPlacement, type OrgTreeNode } from "../src/lib/org-chart-tree";

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("✗ " + msg); process.exit(1); }
  console.log("✓ " + msg);
}

const mk = (nodeId: number, userId: number, parentNodeIds: number[], sortOrder = 100): OrgPlacement => ({
  nodeId, userId, parentNodeIds, sortOrder,
  displayName: `U${userId}`, titlePrefix: null, nickname: null, jobTitle: null, role: "staff", department: null
});
const flatten = (forest: OrgTreeNode[]): number[] => forest.flatMap((n) => [n.nodeId, ...flatten(n.children)]);

// ── basic tree ──────────────────────────────────────────────────────
const t = buildOrgForest([mk(1, 1, []), mk(2, 2, [1], 10), mk(3, 3, [1], 20)]);
assert(t.length === 1 && t[0].nodeId === 1, `one root (node 1)`);
assert(t[0].children.map((c) => c.nodeId).join(",") === "2,3", `node 1 has children 2,3 in order`);

// ── multi-parent: node under two managers appears under BOTH ─────────
const dual = buildOrgForest([mk(1, 1, []), mk(2, 2, [1]), mk(3, 3, [1, 2])]);
const occur = flatten(dual).filter((id) => id === 3).length;
assert(occur === 2, `node 3 (two parents) is rendered under both (got ${occur})`);

// ── expand-once: a multi-parent node's SUBTREE isn't duplicated ─────
// node 4 under {1,2} (appears twice as a leaf); its child 5 expands only once.
const matrix = buildOrgForest([mk(1, 1, []), mk(2, 2, []), mk(4, 4, [1, 2]), mk(5, 5, [4])]);
assert(flatten(matrix).filter((id) => id === 4).length === 2, `dual-parent node 4 shown under both`);
assert(flatten(matrix).filter((id) => id === 5).length === 1, `its child 5 expanded only once (no subtree blowup)`);

// ── same person placed twice = two nodes, both kept ─────────────────
const twice = buildOrgForest([mk(1, 7, []), mk(2, 7, [1])]);   // user 7 placed as node1 and node2
assert(flatten(twice).length === 2, `same person placed twice yields two nodes`);

// ── root when all parents are off-chart ─────────────────────────────
const orphan = buildOrgForest([mk(1, 1, []), mk(5, 5, [999])]);
assert(orphan.some((r) => r.nodeId === 5) && orphan.length === 2, `off-chart parent → promoted to root`);

// ── wouldCreateCycle over node edges ────────────────────────────────
const edges = [{ nodeId: 2, parentNodeId: 1 }, { nodeId: 3, parentNodeId: 2 }]; // 1 → 2 → 3
assert(wouldCreateCycle(edges, 1, 1) === true, `self is a cycle`);
assert(wouldCreateCycle(edges, 1, 3) === true, `1→parent 3 loops (3 is under 1)`);
assert(wouldCreateCycle(edges, 3, 1) === false, `3→parent 1 is fine`);

// ── data cycle must not hang render ─────────────────────────────────
const cyc = buildOrgForest([mk(1, 1, [2]), mk(2, 2, [1]), mk(3, 3, [1])]);
assert(flatten(cyc).length >= 1, `cyclic data still renders (no hang)`);

console.log("\nALL ORG-CHART FIXTURES PASSED");
