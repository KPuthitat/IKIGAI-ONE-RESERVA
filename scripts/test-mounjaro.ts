// Access-control proof for the Mounjaro clinical-data gateway.
//
// SQLite has no DB-level RLS, so isolation is enforced in src/lib/mounjaro-db.ts.
// This script seeds an isolated temp DB and proves the guarantees from
// docs/mounjaro-integration-plan.md §14 actually hold in code:
//   • employee sees only their own rows
//   • doctor sees only patients they attend (not another doctor's)
//   • nurse / HR / super_admin get NO raw clinical rows
//   • aggregate stats reachable by HR / super_admin / doctor
//   • PDPA erase hides the portal record; audit rows are written
//
// Run:  node --import tsx scripts/test-mounjaro.ts   (or: npm run test:mounjaro)

import fs from "node:fs";
import path from "node:path";

// Run against an isolated CLONE of the dev DB (it's already fully migrated,
// so we skip the cold-bootstrap migration ordering). getDb() will then add
// the mounjaro tables idempotently on the clone. Set BEFORE importing db.
const SRC = path.join(process.cwd(), "data", "reserva.db");
const TMP = path.join(process.cwd(), "data", "test-mounjaro.db");
function cleanup() {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
cleanup();
if (!fs.existsSync(SRC)) {
  console.log("mounjaro test: skipped (no data/reserva.db to clone)");
  process.exit(0);
}
fs.copyFileSync(SRC, TMP);
for (const ext of ["-wal", "-shm"]) {
  if (fs.existsSync(`${SRC}${ext}`)) fs.copyFileSync(`${SRC}${ext}`, `${TMP}${ext}`);
}
process.env.DATABASE_PATH = TMP;

type MjActor = import("../src/lib/mounjaro-db").MjActor;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const mj = await import("../src/lib/mounjaro-db");

  let passed = 0;
  let failed = 0;
  const ok = (name: string, cond: boolean) => {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ FAIL: ${name}`); }
  };
  const throws = (name: string, fn: () => unknown) => {
    try { fn(); failed++; console.error(`  ✗ FAIL: ${name} (expected throw)`); }
    catch (e) { ok(name, mj.isMounjaroForbidden(e)); }
  };

  const db = getDb();

  const mkUser = (username: string, role: string, extra: Partial<{
    clinical_role: string; license_no: string; is_hr_analytics: number;
  }> = {}): number => {
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, display_name, role, status,
                         clinical_role, license_no, is_hr_analytics)
      VALUES (?, '!x', ?, ?, 'active', ?, ?, ?)
    `).run(username, username, role,
      extra.clinical_role ?? null, extra.license_no ?? null, extra.is_hr_analytics ?? 0);
    return Number(info.lastInsertRowid);
  };

  const empAId  = mkUser("emp_a", "staff");
  const empBId  = mkUser("emp_b", "staff");
  const docD1Id = mkUser("doc_1", "admin", { clinical_role: "doctor", license_no: "DOC-1" });
  const docD2Id = mkUser("doc_2", "admin", { clinical_role: "doctor", license_no: "DOC-2" });
  const nurseId = mkUser("nurse_1", "admin", { clinical_role: "nurse", license_no: "NUR-1" });
  const hrId    = mkUser("hr_1", "admin", { is_hr_analytics: 1 });
  const superId = mkUser("super_1", "super_admin");

  const A: MjActor     = { id: empAId, role: "staff" };
  const B: MjActor     = { id: empBId, role: "staff" };
  const D1: MjActor    = { id: docD1Id, role: "admin", clinical_role: "doctor", license_no: "DOC-1" };
  const D2: MjActor    = { id: docD2Id, role: "admin", clinical_role: "doctor", license_no: "DOC-2" };
  const NURSE: MjActor = { id: nurseId, role: "admin", clinical_role: "nurse", license_no: "NUR-1" };
  const HR: MjActor    = { id: hrId, role: "admin", is_hr_analytics: 1 };
  const SUPER: MjActor = { id: superId, role: "super_admin" };

  mj.enrollSelf(A);
  mj.enrollSelf(B);
  const enrA = mj.getMyEnrollment(A)!;
  const enrB = mj.getMyEnrollment(B)!;
  // D2 attends employee A; D1 attends employee B.
  const patAId = mj.createPatientRecord(D2, enrA.id, {
    hn: "HN-A", baseline: { weight: 90 }, comorbidities: {}, contraindications: {},
    medications: {}, notes: null, start_date: "2026-06-01"
  });
  const patBId = mj.createPatientRecord(D1, enrB.id, {
    hn: "HN-B", baseline: { weight: 80 }, comorbidities: {}, contraindications: {},
    medications: {}, notes: null, start_date: "2026-06-01"
  });

  console.log("\n[1] Employee isolation");
  ok("emp A enrollment is A's", enrA.employee_id === empAId);
  ok("emp A clinical is A's patient", (mj.getMyClinical(A).patient?.id as number) === patAId);
  ok("emp B clinical is B's patient", (mj.getMyClinical(B).patient?.id as number) === patBId);
  ok("emp A never sees B's patient", (mj.getMyClinical(A).patient?.id as number) !== patBId);

  console.log("\n[2] Doctor scope (attending only)");
  const d1List = mj.listMyPatients(D1).map((p) => p.id);
  const d2List = mj.listMyPatients(D2).map((p) => p.id);
  ok("D1 sees patient B (theirs)", d1List.includes(patBId));
  ok("D1 does NOT see patient A (D2's)", !d1List.includes(patAId));
  ok("D2 sees patient A", d2List.includes(patAId));
  ok("D2 does NOT see patient B", !d2List.includes(patBId));
  ok("D1 getPatient(A) → null", mj.getPatientForDoctor(D1, patAId) === null);
  ok("D2 getPatient(A) → row", mj.getPatientForDoctor(D2, patAId) !== null);
  throws("D1 addVisit on A → forbidden", () => mj.addVisit(D1, patAId, { date: "2026-06-08", dose: 5 }));
  ok("D2 addVisit on A → ok", typeof mj.addVisit(D2, patAId, { date: "2026-06-08", dose: 5 }) === "number");

  console.log("\n[3] Nurse / HR / super_admin get NO raw clinical");
  throws("nurse listMyPatients → forbidden", () => mj.listMyPatients(NURSE));
  throws("nurse getPatient → forbidden", () => mj.getPatientForDoctor(NURSE, patAId));
  throws("HR listMyPatients → forbidden", () => mj.listMyPatients(HR));
  throws("super_admin listMyPatients → forbidden", () => mj.listMyPatients(SUPER));

  console.log("\n[4] Aggregate stats");
  ok("HR getProgramStats → ok", mj.getProgramStats(HR).total_enrolled === 2);
  ok("super_admin getProgramStats → ok", mj.getProgramStats(SUPER).active_count === 2);
  ok("D1 getProgramStats → ok", typeof mj.getProgramStats(D1).total_enrolled === "number");

  console.log("\n[5] License unlock gate");
  ok("D1 correct license → true", mj.verifyClinicalLicense(D1, "DOC-1"));
  ok("D1 wrong license → false", !mj.verifyClinicalLicense(D1, "NOPE"));
  ok("nurse license → false", !mj.verifyClinicalLicense(NURSE, "NUR-1"));

  console.log("\n[6] PDPA erasure (soft) + audit");
  mj.eraseMyData(A);
  ok("emp A enrollment hidden after erase", mj.getMyEnrollment(A) === null);
  ok("medical record retained", !!db.prepare("SELECT id FROM mounjaro_patients WHERE id = ?").get(patAId));
  const auditCount = (db.prepare("SELECT COUNT(*) n FROM mounjaro_audit_log").get() as { n: number }).n;
  ok("audit rows were written", auditCount > 0);

  console.log("\n[7] Safety alert rules");
  const al = await import("../src/lib/mounjaro-alerts");
  type AlertInput = import("../src/lib/mounjaro-alerts").AlertInput;
  const base: AlertInput = {
    baselineHr: 70, baselineWeight: 100, lastWeight: 90, currentDose: 5,
    hr: 72, abdomen: 0, vomit: 0, tachy: 0, hypoCount: 0,
    adherence: "full", decision: "maintain", hasContraindication: false,
    onInsulinOrSu: false, weeksAtCurrentDose: 2, visitCount: 1
  };
  const mk = (o: Partial<AlertInput>): AlertInput => ({ ...base, ...o });
  const has = (inp: Partial<AlertInput>, code: string) =>
    al.computeAlerts(mk(inp)).some((a) => a.code === code);
  const lvl = (inp: Partial<AlertInput>, code: string) =>
    al.computeAlerts(mk(inp)).find((a) => a.code === code)?.level;

  ok("clean input → no alerts", al.computeAlerts(base).length === 0);
  ok("contraindication → DANGER", lvl({ hasContraindication: true }, "contraindication") === "danger");
  ok("HR +16 → DANGER hr_jump", lvl({ hr: 86 }, "hr_jump") === "danger");
  ok("abdomen ≥2 → DANGER pancreatitis", lvl({ abdomen: 2 }, "abdominal_pain") === "danger");
  ok("HR +12 → WARNING hr_rising", lvl({ hr: 82 }, "hr_rising") === "warning");
  ok("HR +12 not danger", !has({ hr: 82 }, "hr_jump"));
  ok("vomit ≥2 → WARNING", lvl({ vomit: 2 }, "vomiting") === "warning");
  ok("tachy ≥2 → WARNING", lvl({ tachy: 2 }, "tachycardia") === "warning");
  ok("hypo + insulin/SU → WARNING", has({ hypoCount: 1, onInsulinOrSu: true }, "hypoglycemia"));
  ok("hypo WITHOUT insulin/SU → none", !has({ hypoCount: 1, onInsulinOrSu: false }, "hypoglycemia"));
  ok("adherence held → WARNING", has({ adherence: "held" }, "adherence"));
  ok("maintain+dose5+>8wk → titrate_up", has({ decision: "maintain", currentDose: 5, weeksAtCurrentDose: 10 }, "titrate_up"));
  ok("dose15 never titrate_up", !has({ decision: "maintain", currentDose: 15, weeksAtCurrentDose: 20 }, "titrate_up"));
  ok("dose10+3visits+<5%loss → low_response",
    has({ currentDose: 10, visitCount: 3, baselineWeight: 100, lastWeight: 97 }, "low_response"));
  ok("good loss → no low_response",
    !has({ currentDose: 10, visitCount: 3, baselineWeight: 100, lastWeight: 88 }, "low_response"));

  console.log(`\nmounjaro access-control: ${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
