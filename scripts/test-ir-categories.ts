// IR: clinic categories hidden outside clinic branches; "sent to LINE" marker.
// Run: node --import tsx scripts/test-ir-categories.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-ir-categories.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const IR = await import("../src/lib/ir-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const names = (g: ReturnType<typeof IR.irCategoryGroupsFor>) => g.map((x) => x.group);

  ok("a clinic branch sees all three groups", names(IR.irCategoryGroupsFor(true)).join() === "คลินิก,ร้านอาหาร,ทั่วไป");
  ok("a restaurant branch does NOT see the clinic group", names(IR.irCategoryGroupsFor(false)).join() === "ร้านอาหาร,ทั่วไป");
  ok("…and no clinic category key is offered", !IR.irCategoryGroupsFor(false).some((g) => g.items.some((i) => i.key.startsWith("clinic."))));
  const kept = IR.irCategoryGroupsFor(false, ["clinic.medication"]);
  ok("an old report already filed under a clinic category still shows that one item (not a blank select)", kept.find((g) => g.group === "คลินิก")?.items.map((i) => i.key).join() === "clinic.medication");
  ok("the restaurant and general groups are untouched by that", kept.length === 3 && IR.irCategoryGroupsFor(false).find((g) => g.group === "ทั่วไป")?.items.length === 5);

  const clinic = Number(db.prepare("INSERT INTO branches (slug,name,df_enabled) VALUES ('c','คลินิก',1)").run().lastInsertRowid);
  const resto = Number(db.prepare("INSERT INTO branches (slug,name) VALUES ('r','ร้าน')").run().lastInsertRowid);
  ok("branch type comes from the doctor-fee flag", IR.irBranchIsClinic(clinic) === true && IR.irBranchIsClinic(resto) === false && IR.irBranchIsClinic(9999) === false);

  const r = IR.createReport({ branchId: resto, reporterUserId: null, isAnonymous: true, occurredAt: "2026-10-10T08:49:00.000Z", category: "resto.complaint", incidentType: "complaint", severity: 4, description: "x" });
  ok("a new report has not been sent to LINE yet", IR.getReport(r.id, resto)?.line_sent_at === null);
  const at = IR.markLineSent(r.id);
  ok("after a successful push the time is stored (the button then reads 'send again')", IR.getReport(r.id, resto)?.line_sent_at === at && !!at);
  console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
  cleanup(); process.exit(failed ? 1 : 0);
})();
