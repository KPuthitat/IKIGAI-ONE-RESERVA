// Pure org-chart tree helpers (no DB) — shared by the server lib
// (src/lib/org-chart.ts), the admin client, and the fixture test so the tree /
// cycle behaviour can never diverge between them.

export type OrgPlacementBase = {
  nodeId: number; userId: number; displayName: string; titlePrefix: string | null; nickname: string | null;
  jobTitle: string | null; role: string; department: string | null; sortOrder: number; parentNodeIds: number[];
};
export type OrgTreeNode = OrgPlacementBase & { children: OrgTreeNode[]; key: string; mgrCount: number };

// parent → [child node ids], counting only parents that are on the chart.
function childrenMap(placements: OrgPlacementBase[], byId: Map<number, OrgPlacementBase>): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const p of placements) {
    for (const par of p.parentNodeIds) {
      if (byId.has(par) && par !== p.nodeId) {
        if (!m.has(par)) m.set(par, []);
        m.get(par)!.push(p.nodeId);
      }
    }
  }
  return m;
}

/** Build the forest. A placement under two managers appears under BOTH, but its
 *  SUBTREE is expanded only once (later appearances render as leaves) so a dense
 *  matrix can't duplicate subtrees exponentially. Path-guarded and leftover-safe:
 *  a placement stuck in a pure cycle is still surfaced as a root so none vanish. */
export function buildOrgForest(placements: OrgPlacementBase[]): OrgTreeNode[] {
  const byId = new Map<number, OrgPlacementBase>(placements.map((p) => [p.nodeId, p]));
  const childrenOf = childrenMap(placements, byId);
  const mgrCount = (id: number) => byId.get(id)!.parentNodeIds.filter((par) => byId.has(par) && par !== id).length;
  const sortIds = (ids: number[]) => [...ids].sort((a, b) => {
    const pa = byId.get(a)!, pb = byId.get(b)!;
    return pa.sortOrder - pb.sortOrder || pa.displayName.localeCompare(pb.displayName);
  });
  const expanded = new Set<number>();   // children already emitted once
  const render = (id: number, path: Set<number>, key: string): OrgTreeNode => {
    const p = byId.get(id)!;
    let children: OrgTreeNode[] = [];
    if (!expanded.has(id)) {
      expanded.add(id);
      children = sortIds(childrenOf.get(id) ?? [])
        .filter((c) => !path.has(c))
        .map((c) => render(c, new Set(path).add(c), `${key}-${c}`));
    }
    return { ...p, children, key, mgrCount: mgrCount(id) };
  };
  const ordered = [...placements].sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const seen = new Set<number>();
  const collect = (n: OrgTreeNode) => { seen.add(n.nodeId); n.children.forEach(collect); };
  const trees: OrgTreeNode[] = [];
  const emit = (id: number) => { const t = render(id, new Set([id]), `${id}`); collect(t); trees.push(t); };
  for (const r of ordered) if (mgrCount(r.nodeId) === 0) emit(r.nodeId);
  for (const p of ordered) if (!seen.has(p.nodeId)) emit(p.nodeId);
  return trees;
}

/** Node ids reachable downward from `nodeId` (its reports, transitively). */
export function descendantsOf(placements: OrgPlacementBase[], nodeId: number): Set<number> {
  const byId = new Map<number, OrgPlacementBase>(placements.map((p) => [p.nodeId, p]));
  const childrenOf = childrenMap(placements, byId);
  const out = new Set<number>();
  const stack = [...(childrenOf.get(nodeId) ?? [])];
  while (stack.length) {
    const c = stack.pop()!;
    if (out.has(c)) continue;
    out.add(c);
    stack.push(...(childrenOf.get(c) ?? []));
  }
  return out;
}

/** Would adding edge (nodeId → parentNodeId) create a cycle? True if
 *  parentNodeId is nodeId itself or a descendant of nodeId in `edges`. */
export function wouldCreateCycle(
  edges: Array<{ nodeId: number; parentNodeId: number }>, nodeId: number, parentNodeId: number
): boolean {
  if (nodeId === parentNodeId) return true;
  const childrenOf = new Map<number, number[]>();
  for (const e of edges) {
    if (!childrenOf.has(e.parentNodeId)) childrenOf.set(e.parentNodeId, []);
    childrenOf.get(e.parentNodeId)!.push(e.nodeId);
  }
  const stack = [...(childrenOf.get(nodeId) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === parentNodeId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(childrenOf.get(cur) ?? []));
  }
  return false;
}
