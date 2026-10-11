// Org chart (hand-drawn): auto-link to the supervisors set in each profile.
// Run: node --import tsx scripts/test-org-chart-link.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-org-chart-link.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const O = await import("../src/lib/org-chart");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const br = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','B')").run().lastInsertRowid);
  const other = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('o','O')").run().lastInsertRowid);
  const mk = (u: string, sup: number[] = [], branch = br, status = "active") => {
    const id = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES (?,?,?, 'staff', ?)").run(u, "x", u, status).lastInsertRowid);
    db.prepare("INSERT INTO user_branches (user_id,branch_id) VALUES (?,?)").run(id, branch);
    sup.forEach((s, i) => db.prepare("INSERT INTO user_supervisors (user_id,supervisor_user_id,sort_order) VALUES (?,?,?)").run(id, s, i));
    if (sup[0] != null) db.prepare("UPDATE users SET supervisor_user_id = ? WHERE id = ?").run(sup[0], id);
    return id;
  };
  const exec = mk("exec"), head = mk("head", [exec]), head2 = mk("head2", [exec]);
  const w1 = mk("w1", [head]), w2 = mk("w2", [head, head2]), none = mk("none"), stray = mk("stray", [], other);
  const w3 = mk("w3", [stray]);   // supervisor belongs to another branch
  const edges = (node: number) => (db.prepare("SELECT parent_node_id p FROM org_chart_edges WHERE node_id = ? ORDER BY p").all(node) as Array<{ p: number }>).map((r) => r.p);
  const nodeOf = (uid: number) => (db.prepare("SELECT id FROM org_chart_nodes WHERE branch_id = ? AND user_id = ? ORDER BY id").get(br, uid) as { id: number } | undefined)?.id;
  const nodeCount = () => (db.prepare("SELECT COUNT(*) n FROM org_chart_nodes WHERE branch_id = ?").get(br) as { n: number }).n;

  const n1 = O.addOrgPlacement(br, w1, null, { fromProfile: true })!;
  ok("adding w1 with 'follow profile' also puts their boss and the boss's boss on the chart", nodeOf(head) != null && nodeOf(exec) != null && nodeCount() === 3);
  ok("w1 is linked under head, head under exec", edges(n1).join() === String(nodeOf(head)) && edges(nodeOf(head)!).join() === String(nodeOf(exec)));
  ok("the top person (no supervisor) stays at the top", edges(nodeOf(exec)!).length === 0);

  const n2 = O.addOrgPlacement(br, w2, null, { fromProfile: true })!;
  ok("two supervisors in the profile → two links; the already-placed boss is reused (no duplicate box)", edges(n2).length === 2 && nodeOf(head2) != null && nodeCount() === 5 && edges(n2).includes(nodeOf(head)!) && edges(n2).includes(nodeOf(head2)!));

  const n3 = O.addOrgPlacement(br, none, null, { fromProfile: true })!;
  ok("someone without a supervisor simply sits at the top", edges(n3).length === 0);

  const n4 = O.addOrgPlacement(br, w3, null, { fromProfile: true })!;
  ok("a supervisor who is not a member of this branch cannot be put on its chart → no link, no box", edges(n4).length === 0 && nodeOf(stray) == null);

  const manual = O.addOrgPlacement(br, mk("w5", [head]), nodeOf(head2)!)!;
  ok("choosing a boss by hand is respected (profile not applied)", edges(manual).join() === String(nodeOf(head2)));
  ok("'บนสุด' (no parent, no profile) adds a free-standing box", (() => { const id = O.addOrgPlacement(br, mk("w6", [head]), null)!; return edges(id).length === 0; })());

  const before = (db.prepare("SELECT COUNT(*) n FROM org_chart_edges").get() as { n: number }).n;
  const added = O.linkAllProfileSupervisors(br);
  ok("sync button links the boxes that were left unlinked (w5 gets head, w6 gets head)", added === 2 && (db.prepare("SELECT COUNT(*) n FROM org_chart_edges").get() as { n: number }).n === before + 2);
  ok("manual link stays (w5 keeps head2 and also gets head)", edges(manual).length === 2);
  ok("running the sync again adds nothing", O.linkAllProfileSupervisors(br) === 0);

  // cycle safety: a profile loop must not hang or create a cycle
  const a = mk("loopA"), b = mk("loopB", [a]);
  db.prepare("INSERT INTO user_supervisors (user_id,supervisor_user_id,sort_order) VALUES (?,?,0)").run(a, b);
  const na = O.addOrgPlacement(br, a, null, { fromProfile: true })!;
  const nb = nodeOf(b)!;
  ok("a loop in the profiles never produces a cycle on the chart", (edges(na).includes(nb) ? 1 : 0) + (edges(nb).includes(na) ? 1 : 0) <= 1);

  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
