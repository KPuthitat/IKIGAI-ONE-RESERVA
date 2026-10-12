// IR: deleting an incident (owner 2026-10-11) — branch-scoped, takes the named people with it.
// Run: node --import tsx scripts/test-ir-delete.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-ir-delete.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const IR = await import("../src/lib/ir-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const a = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('a','A')").run().lastInsertRowid);
  const b = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('b','B')").run().lastInsertRowid);
  const mk = (branchId: number) => IR.createReport({ branchId, reporterUserId: null, isAnonymous: true, occurredAt: "2026-10-07T22:18:00.000Z", category: "general.other", incidentType: "complaint", severity: 2, description: "ร้องเรียนลูกค้า", people: [{ name: "ลูกค้า", role: "affected" }] });
  const r1 = mk(a), r2 = mk(b);
  ok("two reports exist, one person each", (db.prepare("SELECT COUNT(*) n FROM ir_report_people").get() as { n: number }).n === 2);
  ok("another branch's report cannot be deleted from this branch", IR.deleteReport(r2.id, a) === null && !!IR.getReport(r2.id, b));
  const gone = IR.deleteReport(r1.id, a);
  ok("deleting returns what was removed (code, status, severity) for the audit log", !!gone && gone.status === "new" && gone.severity === 2 && (gone.code ?? "").startsWith("IR-"));
  ok("the report and the people named in it are gone", IR.getReport(r1.id, a) === null && (db.prepare("SELECT COUNT(*) n FROM ir_report_people WHERE report_id = ?").get(r1.id) as { n: number }).n === 0);
  ok("the other branch's report and person are untouched", !!IR.getReport(r2.id, b) && (db.prepare("SELECT COUNT(*) n FROM ir_report_people").get() as { n: number }).n === 1);
  ok("deleting twice is a no-op (null)", IR.deleteReport(r1.id, a) === null);
  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
