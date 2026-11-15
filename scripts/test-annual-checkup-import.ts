// Import of the annual check-up planning workbook (phase 3): parsing, matching by code + name, preview, idempotent commit.
// Builds its workbooks in memory (the real file holds staff names and is not committed).
//
// Run:  node --import tsx scripts/test-annual-checkup-import.ts   (or: npm run test:annual-checkup-import)
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const TMP = path.join(process.cwd(), "data", "test-annual-checkup-import.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const X = await import("../src/lib/annual-checkup-xlsx");
  const I = await import("../src/lib/annual-checkup-import");
  const G = await import("../src/lib/annual-checkup-db");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const refused = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return e instanceof I.ImportRefused ? e.code : e instanceof Error ? e.message : String(e); } };

  // ── fixtures: companies, staff, the clinic recorder ──
  const coClinic = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท อิคิไก เมดิเฮลท์ จำกัด')").run().lastInsertRowid);
  const coWell = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท อิคิไก เวลล์เทรด จำกัด')").run().lastInsertRowid);
  const mkUser = (code: string | null, prefix: string | null, name: string, status = "active") =>
    Number(db.prepare("INSERT INTO users (username, password_hash, display_name, title_prefix, employee_code, role, status) VALUES (?,?,?,?,?, 'staff', ?)")
      .run(`u${Math.random()}`, "x", name, prefix, code, status).lastInsertRowid);
  const u1 = mkUser("IKG-001", "นางสาว", "พรนภา กันธุ"), u3 = mkUser("IKG-003", "นาย", "กาสี สีหราช");
  const u2 = mkUser("IKG-002", "นาย", "ธนดล พิพิธกุล"), u2old = mkUser("IKG-002", "นางสาว", "ทรรศนีย์พร ถิ่นหลักร้อย");   // the duplicated code (IKG-W46 in real life)
  mkUser("IKG-004", "นาย", "สมชาย ใจดี");                                                                               // name will not match the file
  mkUser("IKG-005", "นางสาว", "ออกแล้ว นามสมมติ", "resigned");
  mkUser("IKG-006", "นาย", "ซ้ำ ซ้อน"); mkUser("IKG-006", "นาย", "ซ้ำ ซ้อน");                                          // ambiguous
  mkUser("IKG-007", "นาย", "ชื่อ ตรงกัน");                                                                              // same name, different code than the file says
  const clinic = (db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number }).id;
  const rec = Number(db.prepare("INSERT INTO users (username,password_hash,display_name,role,status,health_result_recorder) VALUES ('rec','x','rec','staff','active',1)").run().lastInsertRowid);
  db.prepare("INSERT INTO user_branches (user_id, branch_id, is_admin) VALUES (?,?,0)").run(rec, clinic);
  const admin = mkUser("IKG-ADM", null, "แอดมิน นำเข้า");

  const tests = db.prepare("SELECT id, code, name_th FROM annual_checkup_tests ORDER BY sort_no").all() as Array<{ id: number; code: string; name_th: string }>;
  const T = (code: string) => tests.find((t) => t.code === code)!;

  // ── workbook builder ──
  type Row = { code: string; name: string; payer: string; marks?: Record<string, string>; lung?: boolean };
  const BASIC = ["PHYSICAL", "CXR", "CBC", "URINE", "BUN", "CREAT", "SGOT", "SGPT", "CHOL", "TG", "HDL", "LDL", "GLUCOSE", "URIC"];
  const book = (rows: Row[], o: { totals?: boolean; extraHeader?: string; details?: Array<[string, string, string, string]>; badMark?: boolean } = {}) => {
    const header = ["ลำดับ", "รหัสพนักงาน", "ชื่อ-นามสกุล", "บริษัทที่รับค่าใช้จ่าย", "ตรวจปอดเพิ่ม", ...tests.map((t) => t.name_th), ...(o.extraHeader ? [o.extraHeader] : []), "จำนวนรายการ", "รายการตรวจเพิ่มจากพื้นฐาน และรายการที่งด"];
    const body = rows.map((r, i) => {
      const marks = tests.map((t) => r.marks?.[t.code] ?? (BASIC.includes(t.code) ? "✓" : ""));
      return [String(i + 1), r.code, r.name, r.payer, r.lung ? "ตรวจ" : "", ...marks, ...(o.extraHeader ? [""] : []), String(marks.filter((m) => m === "✓").length), ""];
    });
    if (o.badMark) body[0][6] = "??";
    const totals = ["", "", "รวมจำนวนคนที่ตรวจแต่ละรายการ", "", "", ...tests.map((t) => String(rows.filter((r) => (r.marks?.[t.code] ?? (BASIC.includes(t.code) ? "✓" : "")) === "✓").length)), ...(o.extraHeader ? [""] : []), "", ""];
    const aoa = [["รายการตรวจสุขภาพรายบุคคล"], ["หมายเหตุ"], [], header, ...body, ...(o.totals === false ? [] : [totals]), [], ["", "", "จำนวนคนต่อรายการ แยกตามบริษัท (ตารางสรุป)"], ["", "", "บริษัทที่รับค่าใช้จ่าย"]];
    const prog = [["โปรแกรมตรวจตามบริษัท"], ["หมายเหตุ"], [], ["บริษัท", ...tests.map((t) => t.name_th)],
      ["บริษัท อิคิไก เมดิเฮลท์ จำกัด", ...tests.map((t) => (BASIC.includes(t.code) ? "✓" : ""))],
      ["บริษัท ทรานซิสเตอร์ ริช จำกัด", ...tests.map((t) => (BASIC.includes(t.code) ? "✓" : t.code === "SPIRO" ? "เฉพาะคนที่ระบุ" : ""))]];
    const details = [["รายชื่อ"], ["หมายเหตุ"], ["วิธีใช้"], [], ["ลำดับ", "รหัสพนักงาน", "คำนำหน้า", "ชื่อ", "นามสกุล"], ...(o.details ?? []).map((d, i) => [String(i + 1), ...d])];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "รายการตรวจรายบุคคล");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(details), "รายชื่อตรวจสุขภาพ");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["สรุป"], ["ไม่ใช้"]]), "สรุป");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prog), "โปรแกรมตามบริษัท");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  };
  const CLINIC = "บริษัท อิคิไก เมดิเฮลท์ จำกัด", OUT = "บริษัท ทรานซิสเตอร์ ริช จำกัด";
  const clean: Row[] = [
    { code: "IKG-001", name: "นางสาว พรนภา กันธุ", payer: CLINIC, marks: { HBSAG: "✓" } },
    { code: "IKG-002", name: "นาย ธนดล พิพิธกุล", payer: CLINIC, marks: { HAV: "งด", STOOL: "แล็บนอก" } },
    { code: "IKG-003", name: "นาย กาสี สีหราช", payer: OUT, lung: true, marks: { SPIRO: "✓" } },
    { code: "", name: "รอเพิ่มรายชื่อ คนที่ 1", payer: OUT },
    { code: "", name: "รอเพิ่มรายชื่อ คนที่ 2", payer: OUT }
  ];
  const parse = (rows: Row[], o: Parameters<typeof book>[1] = {}) => X.parseCheckupWorkbook(book(rows, o));
  const NEW = { name: "ตรวจสุขภาพประจำปี 2569", yearBe: 2569 };

  // ── parser ──
  const p0 = parse(clean);
  ok("parser reads 5 rows: 3 staff + 2 placeholders, 20 test columns, no file issues", p0.people.length === 5 && p0.people.filter((p) => p.kind === "placeholder").length === 2 && p0.testHeaders.length === 20 && p0.issues.length === 0);
  ok("parser reads ✓ / งด / แล็บนอก and the lung flag", p0.people[1].marks[T("HAV").name_th] === "waived" && p0.people[1].marks[T("STOOL").name_th] === "external_lab" && p0.people[0].marks[T("CXR").name_th] === "ordered" && p0.people[2].lungExtra);
  ok("parser reads the totals row and stops there (summary tables below are ignored)", p0.fileTotals?.[T("CXR").name_th] === 5 && p0.people.length === 5);
  ok("parser reads the programme per company, incl. 'เฉพาะคนที่ระบุ'", p0.programmes.length === 2 && p0.programmes[1].tests[T("SPIRO").name_th] === "selected" && p0.programmes[0].tests[T("CXR").name_th] === "all");
  ok("an unknown mark in a cell is a file issue", parse(clean, { badMark: true }).issues.some((i) => /ไม่รู้จัก/.test(i.message)));
  ok("garbage that is not a workbook is a file issue, not a crash", X.parseCheckupWorkbook(Buffer.from("not an xlsx")).issues.length > 0 || X.parseCheckupWorkbook(Buffer.from("not an xlsx")).people.length === 0);

  // ── plan on a new round ──
  ok("a new round needs a name", refused(() => I.buildImportPlan(db, p0, {})) === "round_invalid");
  const plan1 = I.buildImportPlan(db, p0, NEW);
  const m = (code: string) => plan1.people.find((p) => p.code === code)!.match;
  ok("plan: code + name match → matched", m("IKG-001").state === "matched" && (m("IKG-001") as { userId: number }).userId === u1 && (m("IKG-003") as { userId: number }).userId === u3);
  ok("plan: a code held by two people is resolved by NAME and warns (the IKG-W46 case)", (() => { const x = m("IKG-002"); return x.state === "matched" && x.userId === u2 && x.userId !== u2old && x.warnings.some((w) => /ซ้ำในระบบ/.test(w)); })());
  ok("plan: placeholders become externals numbered 1 and 2", plan1.people.filter((p) => p.match.state === "placeholder").map((p) => (p.match as { sortNo: number }).sortNo).join() === "1,2");
  ok("plan: nothing needs fixing, nothing is stored yet", plan1.needsFix === 0 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_orders").get() as { n: number }).n === 0 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_rounds").get() as { n: number }).n === 0);
  ok("plan: payers — our company is linked, the outside company is kept as free text", (() => {
    const a = plan1.payers.find((p) => p.name === CLINIC)!, b = plan1.payers.find((p) => p.name === OUT)!;
    return a.companyId === coClinic && !a.external && b.companyId === null && b.external && plan1.warnings.some((w) => w.includes(OUT));
  })());
  ok("plan: order counts = every ✓ / งด / แล็บนอก of the 5 rows (5×14 basic + HBsAg + stool + SPIRO − 1 swapped)", plan1.orders.add === 5 * 14 + 1 + 1 + 1 + 1 && plan1.orders.change + plan1.orders.same + plan1.orders.remove + plan1.orders.conflict === 0);
  ok("plan: per-test counts reconcile with the file's own totals row (no warning)", plan1.perTest.length === 20 && !plan1.warnings.some((w) => /แถวรวมของไฟล์/.test(w)));

  // ── never import on a guess ──
  const messy: Row[] = [
    ...clean,
    { code: "IKG-004", name: "นาย สมศักดิ์ ใจดี", payer: CLINIC },      // code exists, name differs
    { code: "IKG-005", name: "นางสาว ออกแล้ว นามสมมติ", payer: CLINIC },  // resigned
    { code: "IKG-006", name: "นาย ซ้ำ ซ้อน", payer: CLINIC },            // two people, same code and name
    { code: "IKG-099", name: "นาย ไม่มี ในระบบ", payer: CLINIC },         // not in the system
    { code: "IKG-777", name: "นาย ชื่อ ตรงกัน", payer: CLINIC },          // not found by code, but a person with this name exists
    { code: "IKG-001", name: "นางสาว พรนภา กันธุ", payer: CLINIC }        // the same person twice
  ];
  const pm = I.buildImportPlan(db, parse(messy), NEW);
  const reason = (code: string, nth = 0) => { const f = pm.people.filter((p) => p.code === code); const x = f[nth]?.match; return x?.state === "needs_fix" ? x.reason : x?.state ?? "?"; };
  ok("plan: wrong name → name_mismatch; resigned → inactive; two matches → ambiguous; unknown → not_found; repeat → duplicate_row",
    reason("IKG-004") === "name_mismatch" && reason("IKG-005") === "inactive" && reason("IKG-006") === "ambiguous" && reason("IKG-099") === "not_found" && reason("IKG-001", 1) === "duplicate_row");
  ok("plan: a not-found row names the person who has that name (hint), but is not matched", (() => { const x = pm.people.find((p) => p.code === "IKG-777")!.match; return x.state === "needs_fix" && /IKG-007/.test(x.message); })());
  ok("plan: 6 rows need fixing", pm.needsFix === 6);
  ok("commit is refused while rows need fixing, and writes nothing", refused(() => I.commitImport(db, parse(messy), NEW, admin, { planHash: pm.hash, skipUnresolved: false })) === "needs_fix"
    && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_rounds").get() as { n: number }).n === 0);

  // ── file problems block the import ──
  const pBad = I.buildImportPlan(db, parse(clean, { extraHeader: "รายการที่ไม่มีในแคตตาล็อก" }), NEW);
  ok("an unknown test column is a file issue and blocks commit", pBad.fileIssues.some((i) => /ไม่มีในแคตตาล็อก/.test(i)) && refused(() => I.commitImport(db, parse(clean, { extraHeader: "รายการที่ไม่มีในแคตตาล็อก" }), NEW, admin, { planHash: pBad.hash, skipUnresolved: true })) === "file_issues");
  ok("two placeholders with the same number are a file issue", I.buildImportPlan(db, parse([...clean, { code: "", name: "รอเพิ่มรายชื่อ คนที่ 1", payer: OUT }]), NEW).fileIssues.some((i) => /ซ้ำกัน/.test(i)));
  ok("totals row that disagrees with the ✓ cells is a warning", (() => { const w = parse(clean); w.fileTotals![T("CXR").name_th] = 99; return I.buildImportPlan(db, w, NEW).warnings.some((x) => /แถวรวมของไฟล์/.test(x)); })());
  ok("a name that differs from the staff-details sheet is a warning on the row", (() => { const x = I.buildImportPlan(db, parse(clean, { details: [["IKG-001", "นางสาว", "พรนภา", "กันทา"]] }), NEW); const r = x.people.find((p) => p.code === "IKG-001")!.match; return r.state === "matched" && r.warnings.some((w) => /แผ่นรายชื่อ/.test(w)); })());

  // ── commit: clean rows only when the user chooses to skip the rest ──
  const rollback = (fn: () => void) => { try { db.transaction(() => { fn(); throw new Error("rollback"); })(); } catch { /* expected */ } };
  ok("commit with 'skip rows to fix' imports only the understood rows", (() => {
    const r = I.commitImport(db, parse(messy), NEW, admin, { planHash: pm.hash, skipUnresolved: true });
    return r.created && r.skippedRows === 6 && r.ordersAdded === plan1.orders.add && r.externalsAdded === 2;
  })());
  const round = (db.prepare("SELECT id FROM annual_checkup_rounds").get() as { id: number }).id;
  ok("round, payers (company link / outside company), programmes and their tests were written", (() => {
    const payers = db.prepare("SELECT name_th, company_id, is_external FROM annual_checkup_payers WHERE round_id = ? ORDER BY name_th").all(round) as Array<{ name_th: string; company_id: number | null; is_external: number }>;
    const prog = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_programs WHERE round_id = ?").get(round) as { n: number }).n;
    const sel = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_program_tests WHERE scope = 'selected'").get() as { n: number }).n;
    return payers.length === 2 && payers.find((p) => p.name_th === CLINIC)?.company_id === coClinic && payers.find((p) => p.name_th === OUT)?.is_external === 1 && prog === 2 && sel === 1;
  })());
  ok("statuses stored as in the file: ordered / waived / external_lab; people with no account are placeholder externals", (() => {
    const st = (user: number, code: string) => (db.prepare("SELECT status FROM annual_checkup_orders WHERE round_id = ? AND user_id = ? AND test_id = ?").get(round, user, T(code).id) as { status: string } | undefined)?.status;
    const ext = db.prepare("SELECT COUNT(*) n FROM annual_checkup_externals WHERE round_id = ? AND is_placeholder = 1 AND full_name IS NULL").get(round) as { n: number };
    return st(u2, "HAV") === "waived" && st(u2, "STOOL") === "external_lab" && st(u1, "CXR") === "ordered" && st(u1, "HAV") === undefined && ext.n === 2;
  })());
  ok("rows that needed fixing created nothing (no order for the wrong-name / resigned / unknown people)", (db.prepare("SELECT COUNT(DISTINCT user_id) n FROM annual_checkup_orders WHERE round_id = ?").get(round) as { n: number }).n === 3);
  ok("the import stores no medical reason (the file has none) — the clinical table stays empty", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_order_clinical").get() as { n: number }).n === 0);
  ok("the import is logged", (db.prepare("SELECT COUNT(*) n FROM persona_activity_log WHERE action = 'annual_checkup.import'").get() as { n: number }).n === 1);

  // ── idempotent ──
  const again = I.buildImportPlan(db, parse(clean), { roundId: round });
  ok("importing the same file again changes nothing: all same, nothing to add / change / remove", again.orders.add === 0 && again.orders.change === 0 && again.orders.remove === 0 && again.orders.same === plan1.orders.add && again.round.mode === "existing");
  ok("committing it again writes nothing new", (() => {
    const before = (db.prepare("SELECT COUNT(*) n FROM annual_checkup_orders").get() as { n: number }).n;
    const r = I.commitImport(db, parse(clean), { roundId: round }, admin, { planHash: again.hash, skipUnresolved: false });
    return !r.created && r.ordersAdded === 0 && r.ordersChanged === 0 && r.ordersRemoved === 0 && r.externalsAdded === 0 && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_orders").get() as { n: number }).n === before
      && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_payers WHERE round_id = ?").get(round) as { n: number }).n === 2;
  })());
  ok("the same input always gives the same plan hash", I.buildImportPlan(db, parse(clean), { roundId: round }).hash === again.hash);

  // ── changes between imports ──
  const changed = clean.map((r) => (r.code === "IKG-001" ? { ...r, marks: { HBSAG: "✓", CXR: "งด" } } : r));
  const pc = I.buildImportPlan(db, parse(changed), { roundId: round });
  ok("a changed cell shows as a change (✓ → งด), nothing else", pc.orders.change === 1 && pc.orders.add === 0 && pc.orders.remove === 0);
  ok("a stale preview is refused (the plan changed since it was shown)", refused(() => I.commitImport(db, parse(changed), { roundId: round }, admin, { planHash: again.hash, skipUnresolved: false })) === "plan_changed");
  I.commitImport(db, parse(changed), { roundId: round }, admin, { planHash: pc.hash, skipUnresolved: false });
  ok("the change was applied", (db.prepare("SELECT status FROM annual_checkup_orders WHERE round_id = ? AND user_id = ? AND test_id = ?").get(round, u1, T("CXR").id) as { status: string }).status === "waived");
  const fewer = changed.map((r) => (r.code === "IKG-003" ? { ...r, marks: { SPIRO: "" } } : r));
  const pf = I.buildImportPlan(db, parse(fewer), { roundId: round });
  ok("a test dropped from a person's row is a removal", pf.orders.remove === 1);
  const withoutU3 = changed.filter((r) => r.code !== "IKG-003");
  ok("a person dropped from the file loses their orders (all rows understood)", I.buildImportPlan(db, parse(withoutU3), { roundId: round }).orders.remove === (db.prepare("SELECT COUNT(*) n FROM annual_checkup_orders WHERE user_id = ?").get(u3) as { n: number }).n);
  ok("…but not while some row still needs fixing (a typo must not wipe someone)", (() => {
    const p = I.buildImportPlan(db, parse([...withoutU3, { code: "IKG-099", name: "นาย ไม่มี ในระบบ", payer: CLINIC }]), { roundId: round });
    return p.orders.remove === 0 && p.warnings.some((w) => /ยังไม่ลบ/.test(w));
  })());

  // ── results / clinical data are never touched ──
  const oCxr2 = (db.prepare("SELECT id FROM annual_checkup_orders WHERE round_id = ? AND user_id = ? AND test_id = ?").get(round, u1, T("CBC").id) as { id: number }).id;
  G.recordResult({ id: rec }, oCxr2, { valueText: "ปกติ" });
  const oLock = (db.prepare("SELECT id FROM annual_checkup_orders WHERE round_id = ? AND user_id = ? AND test_id = ?").get(round, u2, T("HAV").id) as { id: number }).id;
  G.setOrderClinical({ id: rec }, oLock, { waiveReason: "งดตามคำสั่งแพทย์" });
  ok("the gateway lists orders that carry a result or clinical data (ids only)", (() => { const s = G.lockedOrderIds(round); return s.has(oCxr2) && s.has(oLock) && s.size === 2; })());
  const risky = changed.map((r) => (r.code === "IKG-001" ? { ...r, marks: { HBSAG: "✓", CXR: "งด", CBC: "งด" } } : r.code === "IKG-002" ? { ...r, marks: { STOOL: "แล็บนอก" } } : r));
  const pr = I.buildImportPlan(db, parse(risky), { roundId: round });
  ok("changing / removing an order that has a result or clinical data is a CONFLICT, not a change", pr.orders.conflict === 2 && pr.orders.change === 0 && pr.orders.remove === 0 && pr.conflicts.length === 2);
  ok("…and committing it leaves those orders exactly as they were", (() => {
    I.commitImport(db, parse(risky), { roundId: round }, admin, { planHash: pr.hash, skipUnresolved: false });
    const a = db.prepare("SELECT status FROM annual_checkup_orders WHERE id = ?").get(oCxr2) as { status: string };
    const b = db.prepare("SELECT status FROM annual_checkup_orders WHERE id = ?").get(oLock) as { status: string };
    return a.status === "ordered" && b.status === "waived" && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results").get() as { n: number }).n === 1;
  })());

  console.log(failed === 0 ? "\n✓ ALL PASS" : `\n✗ ${failed} FAILED`);
  void rollback; void coWell;
  cleanup(); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
