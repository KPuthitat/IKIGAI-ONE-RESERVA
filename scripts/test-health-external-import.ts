// External examinees, phase 2: planning-workbook import with groups ก (matched staff) / ข (outside company, opt-in) / ค (our own company, skipped).
// Run: node --import tsx scripts/test-health-external-import.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-external-import.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const I = await import("../src/lib/annual-checkup-import");
  const X = await import("../src/lib/annual-checkup-xlsx");
  const XLSX = await import("xlsx");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };

  const CLINIC = "บริษัท อิคิไก เมดิเฮลท์ จำกัด", OUT = "บริษัท ทรานซิสเตอร์ ริช จำกัด";
  db.prepare("INSERT INTO companies (name_th) VALUES (?)").run(CLINIC);
  const u1 = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,title_prefix,employee_code,role,status) VALUES ('s1','x','พรนภา กันธุ','นางสาว','IKG-001','staff','active')").run().lastInsertRowid);
  const admin = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status) VALUES ('own','x','own','super_admin','active')").run().lastInsertRowid);
  const tests = db.prepare("SELECT id, code, name_th FROM annual_checkup_tests WHERE active = 1 ORDER BY sort_no").all() as Array<{ id: number; code: string; name_th: string }>;
  const BASIC = ["CBC", "GLUCOSE", "CREAT"];

  type Row = { code: string; name: string; payer: string; dob?: string };
  const book = (rows: Row[]) => {
    const header = ["ลำดับ", "รหัสพนักงาน", "ชื่อ-นามสกุล", "บริษัทที่รับค่าใช้จ่าย", "วันเกิด", "ตรวจปอดเพิ่ม", ...tests.map((t) => t.name_th), "จำนวนรายการ"];
    const body = rows.map((r) => ["", r.code, r.name, r.payer, r.dob ?? "", "", ...tests.map((t) => (BASIC.includes(t.code) ? "✓" : "")), String(BASIC.length)]);
    const prog = [["โปรแกรม"], [], ["บริษัท", ...tests.map((t) => t.name_th)], [CLINIC, ...tests.map((t) => (BASIC.includes(t.code) ? "✓" : ""))], [OUT, ...tests.map((t) => (BASIC.includes(t.code) ? "✓" : ""))]];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"], [], header, ...body]), "รายการตรวจรายบุคคล");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prog), "โปรแกรมตามบริษัท");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  };
  const rows: Row[] = [
    { code: "IKG-001", name: "นางสาว พรนภา กันธุ", payer: CLINIC },
    { code: "", name: "นาย สมชาย ใจดี", payer: OUT, dob: "02/03/2528" },
    { code: "", name: "นางสาว สมหญิง ใจเย็น", payer: OUT },
    { code: "TSR69-0009", name: "นาย สมปอง รักดี", payer: OUT },
    { code: "", name: "นาย คนในกลุ่ม ไม่มีรหัส", payer: CLINIC }
  ];
  const parsed = () => X.parseCheckupWorkbook(book(rows));
  const NEW = { name: "ตรวจสุขภาพประจำปี 2569", yearBe: 2569 };

  ok("parser: named rows without a code are kept apart, dates read (Buddhist year → CE)", parsed().named.length === 3 && parsed().named[0].dob === "1985-03-02" && X.parseDob("2/3/1985") === "1985-03-02" && X.parseDob("garbage") === null);

  const p0 = I.buildImportPlan(db, parsed(), NEW);
  const g = (k: string) => p0.people.filter((p) => p.group === k).length;
  ok("preview: group ก 1, group ข 3 (2 no code + 1 unknown code at an outside company), group ค 1", g("a") === 1 && g("b") === 3 && g("c") === 1);
  ok("preview: nothing is selected by default, and group ค says why it is skipped", p0.people.filter((p) => p.group === "b").every((p) => p.match.state === "external_candidate" && !p.match.selected) && p0.people.find((p) => p.group === "c")!.match.state === "skipped");
  ok("preview: group ข rows are not 'needs fix' and the file has no issues", p0.needsFix === 0 && p0.fileIssues.length === 0);
  const r0 = I.commitImport(db, parsed(), NEW, admin, { planHash: p0.hash, skipUnresolved: false });
  const ext = () => (db.prepare("SELECT COUNT(*) n FROM annual_checkup_externals WHERE round_id = ?").get(r0.roundId) as { n: number }).n;
  ok("without ticking, no outside examinee is created (only the staff member's orders)", ext() === 0 && r0.namedAdded === 0 && r0.ordersAdded === BASIC.length);

  // existing staff result must stay untouched
  const ord = db.prepare("SELECT id FROM annual_checkup_orders WHERE round_id = ? AND user_id = ? LIMIT 1").get(r0.roundId, u1) as { id: number };
  const G = await import("../src/lib/annual-checkup-db");
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  const coId = (db.prepare("SELECT id FROM companies LIMIT 1").get() as { id: number }).id;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(coId, have.id);
  const clinicB = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(coId).lastInsertRowid);
  const rec = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,clinical_role) VALUES ('r','x','r','staff','active','nurse')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(rec, clinicB);
  G.grantCapability({ id: admin }, rec, "recorder", "test");
  G.recordResult({ id: rec }, ord.id, { valueNum: 95 });
  const snap = JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results ORDER BY id").all());

  const IN = { roundId: r0.roundId, externals: { payers: [OUT], rows: [] as number[] } };
  const p1 = I.buildImportPlan(db, parsed(), IN);
  ok("ticking the company changes the plan hash and marks the 3 as selected", p1.hash !== I.buildImportPlan(db, parsed(), { roundId: r0.roundId }).hash && p1.people.filter((p) => p.match.state === "external_candidate" && p.match.selected).length === 3);
  ok("a plan from a different selection cannot be committed (plan_changed)", (() => { try { I.commitImport(db, parsed(), IN, admin, { planHash: p0.hash, skipUnresolved: false }); return false; } catch (e) { return e instanceof I.ImportRefused && e.code === "plan_changed"; } })());
  const r1 = I.commitImport(db, parsed(), IN, admin, { planHash: p1.hash, skipUnresolved: false });
  ok("after ticking: 3 outside examinees created with the company's orders, none is a user", r1.namedAdded === 3 && ext() === 3 && r1.ordersAdded === 3 * BASIC.length && (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n === 3);
  ok("exam codes follow the company prefix (TSR69-0001..0003)", (db.prepare("SELECT group_concat(exam_code) c FROM (SELECT exam_code FROM annual_checkup_exam_codes WHERE round_id = ? ORDER BY exam_code)").get(r0.roundId) as { c: string }).c === "TSR69-0001,TSR69-0002,TSR69-0003");
  ok("the unknown code is kept as the sponsor's employee code, DOB is stored", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_external_details WHERE sponsor_employee_code = 'TSR69-0009'").get() as { n: number }).n === 1 && (db.prepare("SELECT dob FROM annual_checkup_externals WHERE full_name LIKE '%สมชาย%'").get() as { dob: string }).dob === "1985-03-02");
  ok("the existing result is untouched", JSON.stringify(db.prepare("SELECT * FROM annual_checkup_results ORDER BY id").all()) === snap);

  const p2 = I.buildImportPlan(db, parsed(), IN);
  const r2 = I.commitImport(db, parsed(), IN, admin, { planHash: p2.hash, skipUnresolved: false });
  ok("importing the same file again changes nothing (idempotent)", r2.namedAdded === 0 && r2.namedFound === 3 && r2.ordersAdded === 0 && r2.ordersRemoved === 0 && ext() === 3 && p2.people.filter((p) => p.match.state === "external_candidate" && p.match.exists).length === 3);

  // ticking single rows works too
  const rows2 = [...rows, { code: "", name: "นาย แถวเดียว เลือกเอง", payer: OUT }];
  const sheetRow = X.parseCheckupWorkbook(book(rows2)).named.find((n) => n.name.includes("แถวเดียว"))!.sheetRow;
  const IN2 = { roundId: r0.roundId, externals: { payers: [] as string[], rows: [sheetRow] } };
  const p3 = I.buildImportPlan(db, X.parseCheckupWorkbook(book(rows2)), IN2);
  const r3 = I.commitImport(db, X.parseCheckupWorkbook(book(rows2)), IN2, admin, { planHash: p3.hash, skipUnresolved: false });
  ok("ticking one row adds just that person; the 3 already imported are kept", r3.namedAdded === 1 && ext() === 4);
  ok("a duplicate name in the same file is a file issue", I.buildImportPlan(db, X.parseCheckupWorkbook(book([...rows, rows[1]])), IN).fileIssues.some((m) => /ซ้ำ/.test(m)));
  ok("the staff list in PERSONA is unchanged: no outside examinee has a user row", (db.prepare("SELECT COUNT(*) n FROM users WHERE display_name LIKE '%สมชาย%' OR display_name LIKE '%สมหญิง%'").get() as { n: number }).n === 0);

  cleanup();
  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log("\nall external import checks passed");
})();
