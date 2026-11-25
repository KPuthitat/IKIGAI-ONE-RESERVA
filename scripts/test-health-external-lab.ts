// External examinees, phase 3: analyser file (ReportBackup) keyed by tube code TSR69-0004-R / -G, applied to outside examinees,
// existing staff values untouched. Run: node --import tsx scripts/test-health-external-lab.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-external-lab.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const L = await import("../src/lib/health-report/lab-import");
  const S = await import("../src/lib/health-report/store");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const mk = (u: string, extra: Record<string, unknown> = {}, role = "staff") => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    return Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
  };
  const owner = mk("owner", {}, "super_admin"), nurse = mk("nurse", { clinical_role: "nurse" });
  db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(nurse, clinic);
  G.grantCapability({ id: owner }, nurse, "recorder", "test");
  const N = { id: nurse };
  const staff = mk("พนักงาน หนึ่ง", { employee_code: "IKG-1", gender: "male", dob: "1980-01-01" });

  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบ', 2569, 'open')").run().lastInsertRowid);
  const own = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ของเรา')").run(round).lastInsertRowid);
  const out = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th, is_external) VALUES (?, 'บริษัท ทรานซิสเตอร์ ริช จำกัด', 1)").run(round).lastInsertRowid);
  const items = S.loadItems(db);
  const itemOf = (c: string) => items.find((i) => i.code === c)!;
  const wanted = ["FBS", "CHOL", "TG", "BUN", "CREAT", "URIC", "AST", "ALT"];
  const testCodes = [...new Set(wanted.map((c) => itemOf(c).test))];
  const prog = Number(db.prepare("INSERT INTO annual_checkup_programs (round_id, payer_id, name) VALUES (?,?,'p')").run(round, out).lastInsertRowid);
  for (const t of testCodes) db.prepare("INSERT INTO annual_checkup_program_tests (program_id, test_id, scope) VALUES (?, (SELECT id FROM annual_checkup_tests WHERE code = ?), 'all')").run(prog, t);
  for (const t of testCodes) db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(round, staff, own, t);
  db.prepare("INSERT INTO annual_checkup_exam_codes (round_id, user_id, exam_code, created_by) VALUES (?,?,?,?)").run(round, staff, "TSR69-0001", owner);

  const a = G.addExternalPerson(N, round, out, { title: "นาย", firstName: "สมชาย", lastName: "ใจดี" });
  const b = G.addExternalPerson(N, round, out, { title: "นางสาว", firstName: "สมหญิง", lastName: "ใจเย็น" });
  ok("a code already used in the round is skipped: outside examinees get the next free number", a.examCode !== null && b.examCode !== null && a.examCode !== b.examCode);
  const codeA = a.examCode as string, codeB = b.examCode as string;

  // existing staff value (must stay)
  const stOrder = (db.prepare("SELECT o.id FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.user_id = ? AND t.code = ?").get(staff, itemOf("FBS").test) as { id: number }).id;
  G.recordResult(N, stOrder, { valueNum: 88 });
  const snap = JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results ORDER BY id").all());

  const file = [
    "ReportBackup", "Date=2025-11-23",
    `Sample ID=${codeA}-G  Patient ID=นาย สมชาย ใจดี`, "GLU 92.0 mg/dL",
    `Sample ID=${codeA}-R`, "Patient ID=นาย สมชาย ใจดี", "CHOL 201", "TRI,150", "BUN=12.5", "CRE 1.1", "URIC 6.2", "AST 24", "ALT 31", "HDL 55",
    `Sample ID=${codeB}-G`, "GLU 105", `Sample ID=${codeB}-R`, "CHOL 180", "TRI 90", "BUN 10", "CRE 0.8", "URIC 4.1", "AST 20", "ALT 18", "GLU 99",
    `Sample ID=ZZZ69-0099-R`, "CHOL 150"
  ].join("\n");
  const parsed = L.parseReportBackup(file, items);
  ok("parser: 3 sample codes (tube suffix cut), analyser codes mapped (GLU→FBS, TRI→TG, CRE→CREAT), HDL left unmapped", parsed.rows.length === 3 && parsed.columns.find((c) => c.header === "TRI")!.itemCode === "TG" && parsed.columns.find((c) => c.header === "CRE")!.itemCode === "CREAT" && parsed.columns.find((c) => c.header === "HDL")!.itemCode === null);
  ok("a GLU value on an R tube is not imported and is reported", parsed.issues.some((m) => /GLU/.test(m) && /R/.test(m)));

  const plan = L.buildLabPlan(db, N, round, parsed, items);
  ok("unregistered code is held back, never guessed", plan.rows.find((r) => r.code === "ZZZ69-0099")!.status === "unregistered");
  const rowA = plan.rows.find((r) => r.code === codeA)!, rowB = plan.rows.find((r) => r.code === codeB)!;
  ok("both outside examinees are ready, 8 new values for A, 8 for B (GLU from the G tube)", rowA.status === "ready" && rowA.cells.filter((c) => c.state === "new").length === 8 && rowB.cells.filter((c) => c.state === "new").length === 8 && rowB.cells.find((c) => c.itemCode === "FBS")!.value === 105);
  ok("HDL (no mapping) is not applied anywhere", !plan.rows.some((r) => r.cells.some((c) => c.header === "HDL")));
  const res = L.commitLabPlan(db, N, round, parsed, items, { planHash: plan.hash, overwrite: false, registerByName: false, confirmImplausible: false });
  ok("commit saved 16 values for the 2 outside examinees", res.cellsSaved === 16 && res.rows === 2);
  ok("each chemistry test now shows 2 of 3 people recorded (1 staff + 2 outside)", (() => { const ov = G.getRoundOverview(N, round); return ov.tests.every((t) => t.required === 3 && t.recorded >= 2); })());
  ok("the existing staff result is untouched", JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results WHERE order_id = ?").all(stOrder)) === JSON.stringify(JSON.parse(snap).filter((r: { order_id: number }) => r.order_id === stOrder)));

  // second run: nothing new; a differing value for the staff person is a conflict that is NOT written without overwrite
  const file2 = `Sample ID=TSR69-0001-G\nGLU 120\n` + file;
  const parsed2 = L.parseReportBackup(file2, items);
  const plan2 = L.buildLabPlan(db, N, round, parsed2, items);
  ok("re-run: outside values are 'same', the staff value shows as a conflict and is not overwritten", plan2.counts.newCells === 0 && plan2.rows.find((r) => r.code === "TSR69-0001")!.cells[0].state === "conflict");
  const res2 = L.commitLabPlan(db, N, round, parsed2, items, { planHash: plan2.hash, overwrite: false, registerByName: false, confirmImplausible: false });
  ok("nothing was written by the re-run", res2.cellsSaved === 0 && JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results WHERE order_id = ?").all(stOrder)) === JSON.stringify(JSON.parse(snap).filter((r: { order_id: number }) => r.order_id === stOrder)));
  ok("a name that does not match the code is stopped", (() => { const p = L.parseReportBackup(`Sample ID=${codeA}-R Patient ID=นาย คนอื่น นามสมมติ\nCHOL 100`, items); return L.buildLabPlan(db, N, round, p, items).rows[0].status === "name_mismatch"; })());
  ok("not a ReportBackup file → a clear issue", L.parseReportBackup("hello", items).issues.length === 1);

  // overview kinds for the list filter
  const ov = G.getRoundOverview(N, round);
  ok("overview marks outside examinees (kind external, with their company)", ov.subjects.filter((s) => s.kind === "external").length === 2 && ov.subjects.filter((s) => s.kind === "external").every((s) => s.payer === "บริษัท ทรานซิสเตอร์ ริช จำกัด"));

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall external lab checks passed");
})();
