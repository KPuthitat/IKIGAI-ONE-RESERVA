// External examinees — the owner's acceptance criteria, simulated at the real scale (34 staff + 9 outside people, 30 existing values).
// The real Excel / ReportBackup files are not in the repository, so this builds files of the described shape. Run: node --import tsx scripts/test-health-external-accept.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-external-accept.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const I = await import("../src/lib/annual-checkup-import");
  const X = await import("../src/lib/annual-checkup-xlsx");
  const L = await import("../src/lib/health-report/lab-import");
  const S = await import("../src/lib/health-report/store");
  const XLSX = await import("xlsx");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const CO = "บริษัท อิคิไก เมดิเฮลท์ จำกัด", TSR = "บริษัท ทรานซิสเตอร์ ริช จำกัด", POA = "บริษัท ไพร์ม วัน อาร์คิเทคท์ จำกัด";
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES (?)").run(CO).lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const owner = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('own','x','own','super_admin','active')").run().lastInsertRowid);
  const rec = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,clinical_role) VALUES ('rec','x','rec','staff','active','nurse')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(rec, clinic);
  G.grantCapability({ id: owner }, rec, "recorder", "t");
  const R = { id: rec };

  // 34 staff, codes IKG-001..034
  const staff: Array<{ id: number; code: string; name: string }> = [];
  for (let i = 1; i <= 34; i++) {
    const code = `IKG-${String(i).padStart(3, "0")}`, name = `พนักงาน${i} ทดสอบ${i}`;
    staff.push({ id: Number(db.prepare("INSERT INTO users (username,password_hash,display_name,title_prefix,employee_code,role,status,gender,dob) VALUES (?,?,?,?,?, 'staff','active','male','1985-01-01')").run(`s${i}`, "x", name, "นาย", code).lastInsertRowid), code, name });
  }
  const items = S.loadItems(db);
  const CHEM = ["FBS", "CHOL", "TG", "BUN", "CREAT", "URIC", "AST", "ALT"];
  const chemTests = [...new Set(CHEM.map((c) => items.find((i) => i.code === c)!.test))];
  const tests = db.prepare("SELECT code, name_th FROM annual_checkup_tests WHERE active = 1 ORDER BY sort_no").all() as Array<{ code: string; name_th: string }>;

  // the planning file: 34 staff + 7 TSR + 2 POA, outside people without codes
  const ext: Array<[string, string]> = [...Array.from({ length: 7 }, (_, i) => [TSR, `นาย ภายนอกทีเอสอาร์${i + 1} สกุล${i + 1}`] as [string, string]), ...Array.from({ length: 2 }, (_, i) => [POA, `นางสาว ภายนอกพีโอเอ${i + 1} สกุลพี${i + 1}`] as [string, string])];
  const header = ["ลำดับ", "รหัสพนักงาน", "ชื่อ-นามสกุล", "บริษัทที่รับค่าใช้จ่าย", "ตรวจปอดเพิ่ม", ...tests.map((t) => t.name_th), "จำนวนรายการ"];
  const mark = (t: { code: string }) => (chemTests.includes(t.code) ? "✓" : "");
  const body = [...staff.map((s) => ["", s.code, `นาย ${s.name}`, CO, "", ...tests.map(mark), "8"]), ...ext.map(([p, n]) => ["", "", n, p, "", ...tests.map(mark), "8"])];
  const prog = [["โปรแกรม"], [], ["บริษัท", ...tests.map((t) => t.name_th)], ...[CO, TSR, POA].map((p) => [p, ...tests.map(mark)])];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"], [], header, ...body]), "รายการตรวจรายบุคคล");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prog), "โปรแกรมตามบริษัท");
  const file = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const parsed = () => X.parseCheckupWorkbook(file);
  const NEW = { name: "ตรวจสุขภาพประจำปี 2569", yearBe: 2569 };

  // round 1 first imported with staff only (as in production today): the 9 are not ticked
  const p0 = I.buildImportPlan(db, parsed(), NEW);
  ok("(1) preview: group ข = 9 rows (7 + 2), group ค = 0, staff matched = 34, nothing needs fixing", p0.people.filter((p) => p.group === "b").length === 9 && p0.people.filter((p) => p.group === "c").length === 0 && p0.people.filter((p) => p.group === "a").length === 34 && p0.needsFix === 0);
  const r0 = I.commitImport(db, parsed(), NEW, owner, { planHash: p0.hash, skipUnresolved: false });
  const people = () => (G.getRoundOverview(R, r0.roundId).subjects.length);
  ok("before ticking, round 1 has the 34 staff only", people() === 34);

  // 30 staff already have chemistry results (must never change)
  const orderOf = (uid: number, test: string) => (db.prepare("SELECT o.id FROM annual_checkup_orders o JOIN annual_checkup_tests t ON t.id = o.test_id WHERE o.round_id = ? AND o.user_id = ? AND t.code = ?").get(r0.roundId, uid, test) as { id: number }).id;
  for (const s of staff.slice(0, 30)) for (const t of chemTests) { const it = S.itemsOfTest(items, t); G.recordResult(R, orderOf(s.id, t), S.valuesToInput(it, Object.fromEntries(it.filter((x) => CHEM.includes(x.code)).map((x) => [x.code, 100])))); }
  const snap = JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results ORDER BY id").all());

  // the owner ticks both outside companies and imports again
  const IN = { roundId: r0.roundId, externals: { payers: [TSR, POA], rows: [] as number[] } };
  const p1 = I.buildImportPlan(db, parsed(), IN);
  const r1 = I.commitImport(db, parsed(), IN, owner, { planHash: p1.hash, skipUnresolved: false });
  ok("(2) after the import round 1 has 43 people (34 staff + 9 outside)", people() === 43 && r1.namedAdded === 9 && G.getRoundOverview(R, r0.roundId).subjects.filter((s) => s.kind === "external").length === 9);
  ok("    the 30 existing results are untouched by the second import", JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results ORDER BY id").all()) === snap);

  // ReportBackup: 9 people × 8 values, plus the 30 staff appear again with the SAME values (shown as unchanged)
  const codes = db.prepare("SELECT exam_code, external_id FROM annual_checkup_exam_codes WHERE round_id = ? AND external_id IS NOT NULL ORDER BY exam_code").all(r0.roundId) as Array<{ exam_code: string; external_id: number }>;
  ok("    all 9 outside people have an exam code with their company's prefix", codes.length === 9 && codes.filter((c) => c.exam_code.startsWith("TSR69-")).length === 7 && codes.filter((c) => c.exam_code.startsWith("POA69-")).length === 2);
  const lines: string[] = ["ReportBackup"];
  for (const c of codes) lines.push(`Sample ID=${c.exam_code}-G`, "GLU 95", `Sample ID=${c.exam_code}-R`, "CHOL 190", "TRI 110", "BUN 12", "CRE 0.9", "URIC 5.5", "AST 22", "ALT 20");
  const text = lines.join("\n");
  const lp = L.parseReportBackup(text, items);
  const plan = L.buildLabPlan(db, R, r0.roundId, lp, items);
  ok("(3) lab preview: 9 people ready, 72 new values, nothing unmatched", plan.counts.ready === 9 && plan.counts.newCells === 72 && plan.counts.blocked === 0);
  const res = L.commitLabPlan(db, R, r0.roundId, lp, items, { planHash: plan.hash, overwrite: false, registerByName: false, confirmImplausible: false });
  const ov = G.getRoundOverview(R, r0.roundId);
  ok("    every chemistry test shows 39 of 43 recorded", res.cellsSaved === 72 && chemTests.every((t) => { const r = ov.tests.find((x) => x.code === t)!; return r.recorded === 39 && r.required === 43; }));
  ok("    the 30 staff results are still exactly as before", JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results WHERE order_id IN (SELECT o.id FROM annual_checkup_orders o WHERE o.user_id IS NOT NULL) ORDER BY id").all()) === JSON.stringify(JSON.parse(snap)));

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall acceptance simulations passed");
})();
