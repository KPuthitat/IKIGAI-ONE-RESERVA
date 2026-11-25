// Health report PR 3: examination codes and the laboratory Excel import. Run: node --import tsx scripts/test-health-import.ts
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
const TMP = path.join(process.cwd(), "data", "test-health-import.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const S = await import("../src/lib/health-report/store");
  const L = await import("../src/lib/health-report/lab-import");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return (e as { code?: string }).code ?? String(e); } };

  // ── fixtures ──
  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const mk = (u: string, name: string, extra: Record<string, unknown> = {}, role = "staff") => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    return Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", name, role, "active", ...Object.values(extra)).lastInsertRowid);
  };
  const rec = mk("rec", "เจ้าหน้าที่", {}); db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(rec, clinic);
  const owner = mk("owner", "เจ้าของ", {}, "super_admin");
  G.grantCapability({ id: owner }, rec, "recorder", "test");
  const doc = mk("doc", "หมอ", { clinical_role: "doctor", license_no: "ว.1" }); db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(doc, clinic);
  G.grantCapability({ id: owner }, doc, "approver", "test");
  const a = mk("a", "สมชาย ใจดี", { title_prefix: "นาย", employee_code: "IKG-W46", dob: "1990-06-15", gender: "male" });
  const b = mk("b", "สมหญิง รักดี", { title_prefix: "นางสาว", employee_code: "IKG-W47", dob: "1975-01-02", gender: "female" });
  const c = mk("c", "ไม่มีรหัส ทดสอบ", { employee_code: "IKG-W48", dob: "1985-03-03", gender: "male" });
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบทดสอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ผู้จ่าย')").run(round).lastInsertRowid);
  const order = (u: number, code: string, status = "ordered") => Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id, status) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?),?)").run(round, u, payer, code, status).lastInsertRowid);
  const aCbc = order(a, "CBC"), aGlu = order(a, "GLUCOSE"), bCbc = order(b, "CBC"), bGlu = order(b, "GLUCOSE"); order(c, "CBC"); order(c, "GLUCOSE");
  order(a, "URINE", "waived");
  const actor = { id: rec };
  const items = S.loadItems(db);
  const xlsx = (rows: unknown[][]) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "ผลแล็บ"); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer; };

  // ── codes ──
  ok("exam code: spaces, case and the tube suffix are cut", L.normExamCode(" ahc69-0001 ") === "AHC69-0001" && L.normExamCode("AHC69-0001-R") === "AHC69-0001" && L.normExamCode("TSR69-0004-A") === "TSR69-0004" && L.normExamCode("AHC69-0001") === "AHC69-0001");
  ok("name key ignores the title and spaces", L.nameKey("นาย สมชาย  ใจดี") === L.nameKey("สมชาย ใจดี") && L.nameKey("Mr. John Doe") === "johndoe");
  const dry = L.registerExamCodes(db, rec, round, "AHC69-0001 IKG-W46", true);
  ok("a dry run answers but writes nothing", dry[0].result === "registered" && (db.prepare("SELECT COUNT(*) n FROM annual_checkup_exam_codes").get() as { n: number }).n === 0);
  const reg = L.registerExamCodes(db, rec, round, ["AHC69-0001\tIKG-W46", "AHC69-0002 นางสาว สมหญิง รักดี", "AHC69-0003 ไม่มีใคร", "XX AHC", "AHC69-0001 IKG-W48", "AHC69-0009 IKG-W46"].join("\n"));
  const res = (i: number) => reg[i]?.result;
  ok("by employee code, and by full name", res(0) === "registered" && res(1) === "registered");
  ok("unknown person, bad code, code already used, person already has another code are each refused", res(2) === "not_found" && res(3) === "bad_code" && res(4) === "code_taken" && res(5) === "person_has_other_code");
  ok("registering the same pair again is harmless", L.registerExamCodes(db, rec, round, "AHC69-0001 IKG-W46")[0].result === "same");

  // ── reading the file ──
  const header = ["รหัสผู้รับการตรวจ", "ชื่อ-นามสกุล", "WBC", "Hb (g/dL)", "FBS", "Anti-HBs", "R500", "ไม่รู้จักคอลัมน์"];
  const parsed = L.parseLabWorkbook(xlsx([["รายงานผลแล็บ"], header, ["AHC69-0001-R", "นาย สมชาย ใจดี", "6.5", "14.2", "95", "Positive", "10", "x"], ["AHC69-0002", "สมหญิง รักดี", "8", "11", "1590", "pos", "", ""], ["AHC69-0003", "ใครสักคน", "7", "", "", "", "", ""]]), items);
  ok("the header row is found below a title row and the sheet is read", parsed.issues.length === 0 && parsed.rows.length === 3 && parsed.rows[0].sheetRow === 3);
  const col = (h: string) => parsed.columns.find((x) => x.header === h);
  ok("columns map to catalogue items by name, alias or code", col("WBC")?.itemCode === "WBC" && col("Hb (g/dL)")?.itemCode === "HB" && col("FBS")?.itemCode === "FBS" && col("Anti-HBs")?.itemCode === "ANTI_HBS" && col("R500")?.itemCode === "AUD_R_500");
  ok("an unknown column is reported, not guessed", col("ไม่รู้จักคอลัมน์")?.why === "unknown" && col("ไม่รู้จักคอลัมน์")?.itemCode === null);
  ok("a file with no code column is refused with a reason", L.parseLabWorkbook(xlsx([["a", "b"], [1, 2]]), items).issues.length === 1);
  const it = (code: string) => items.find((i) => i.code === code)!;
  ok("cells: numbers, '<5' is bad, pick-list synonyms", L.parseCell(it("WBC"), "6.5").value === 6.5 && L.parseCell(it("WBC"), "<5").problem === "bad_number" && L.parseCell(it("ANTI_HBS"), "pos").value === "Positive" && L.parseCell(it("HBSAG"), "NEG").value === "Negative" && L.parseCell(it("EX_HEAD"), "normal").value === "ปกติ" && L.parseCell(it("HBSAG"), "maybe").problem === "bad_choice");

  // ── plan ──
  const plan = L.buildLabPlan(db, actor, round, parsed, items);
  const row = (n: number) => plan.rows.find((r) => r.sheetRow === n)!;
  ok("a matched row is ready, the tube suffix was cut", row(3).status === "ready" && row(3).person === "นายสมชาย ใจดี");
  ok("the name is checked a second time: a row whose name does not fit its code is stopped", (() => {
    const p = L.buildLabPlan(db, actor, round, L.parseLabWorkbook(xlsx([header, ["AHC69-0001", "คนอื่น คนละชื่อ", "6"]]), items), items);
    return p.rows[0].status === "name_mismatch" && /คนอื่น คนละชื่อ/.test(p.rows[0].message!) && /สมชาย/.test(p.rows[0].message!) && p.rows[0].cells.length === 0;
  })());
  ok("an unregistered code is stopped, and a unique name match is offered", row(5).status === "unregistered" && row(5).suggestion === null);
  ok("a code that is not registered but whose name matches one person is offered (not applied)", (() => {
    const p = L.buildLabPlan(db, actor, round, L.parseLabWorkbook(xlsx([header, ["AHC69-0003", "ไม่มีรหัส ทดสอบ", "7"]]), items), items);
    return p.rows[0].status === "unregistered" && p.rows[0].suggestion?.label === "ไม่มีรหัส ทดสอบ";
  })());
  ok("with 'register by name' the same row becomes ready", L.buildLabPlan(db, actor, round, L.parseLabWorkbook(xlsx([header, ["AHC69-0003", "ไม่มีรหัส ทดสอบ", "7"]]), items), items, { registerByName: true }).rows[0].status === "ready");
  const cell = (r: number, code: string) => row(r).cells.find((x) => x.itemCode === code)!;
  ok("new values are 'new'; glucose 1590 is implausible; WBC 8 for a woman is normal", cell(3, "WBC").state === "new" && cell(4, "FBS").implausible === true && cell(4, "WBC").flag === "normal");
  ok("flags use the person's sex: Hb 11 is low for a woman", cell(4, "HB").flag === "low");
  ok("Anti-HBs is not part of her orders → not in the programme; audiometry too", cell(3, "ANTI_HBS").state === "not_ordered" && cell(3, "AUD_R_500").state === "not_ordered");
  ok("nothing was written by the preview", (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results").get() as { n: number }).n === 0);

  // ── commit ──
  ok("a stale plan is refused", err(() => L.commitLabPlan(db, actor, round, parsed, items, { planHash: "stale", overwrite: false, registerByName: false, confirmImplausible: false })) === "plan_changed");
  const r1 = L.commitLabPlan(db, actor, round, parsed, items, { planHash: plan.hash, overwrite: false, registerByName: false, confirmImplausible: false });
  const val = (ord: number, tc: string, code: string) => { const rr = G.getOrderValues(actor, ord); return S.valuesFromResult(S.itemsOfTest(items, tc), rr)[code]; };
  ok("values were saved through the gateway as drafts", r1.rows === 2 && val(aCbc, "CBC", "WBC") === 6.5 && val(aCbc, "CBC", "HB") === 14.2 && val(aGlu, "GLUCOSE", "FBS") === 95 && G.getOrderValues(actor, aCbc).status === "draft");
  ok("implausible glucose 1590 was NOT saved without confirmation; her other values were", val(bGlu, "GLUCOSE", "FBS") == null && val(bCbc, "CBC", "WBC") === 8 && val(bCbc, "CBC", "HB") === 11);
  const plan2 = L.buildLabPlan(db, actor, round, parsed, items);
  ok("importing the same file again: only the unconfirmed implausible value is still new; nothing else changes (idempotent)", plan2.counts.newCells === 1 && plan2.counts.conflicts === 0 && plan2.counts.sameCells >= 4);

  // conflicts + overwrite
  const changed = L.parseLabWorkbook(xlsx([header, ["AHC69-0001", "สมชาย ใจดี", "7.0", "", "", "", "", ""]]), items);
  const p3 = L.buildLabPlan(db, actor, round, changed, items);
  ok("a different value shows old and new side by side as a conflict", p3.rows[0].cells[0].state === "conflict" && p3.rows[0].cells[0].existing === 6.5 && p3.rows[0].cells[0].value === 7);
  L.commitLabPlan(db, actor, round, changed, items, { planHash: p3.hash, overwrite: false, registerByName: false, confirmImplausible: false });
  ok("without 'overwrite' the old value stays, and the other items of the panel are untouched", val(aCbc, "CBC", "WBC") === 6.5 && val(aCbc, "CBC", "HB") === 14.2);
  L.commitLabPlan(db, actor, round, changed, items, { planHash: p3.hash, overwrite: true, registerByName: false, confirmImplausible: false });
  ok("with 'overwrite' the value changes and the rest of the panel is kept", val(aCbc, "CBC", "WBC") === 7 && val(aCbc, "CBC", "HB") === 14.2);
  const r4 = L.commitLabPlan(db, actor, round, parsed, items, { planHash: L.buildLabPlan(db, actor, round, parsed, items).hash, overwrite: false, registerByName: false, confirmImplausible: true });
  ok("with the confirmation the implausible value is saved", val(bGlu, "GLUCOSE", "FBS") === 1590 && r4.cellsSaved >= 1);

  // locks + permissions
  G.verifyResult({ id: doc }, (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(aGlu) as { id: number }).id, { licenseUnlocked: true });
  const lockedFile = L.parseLabWorkbook(xlsx([header, ["AHC69-0001", "สมชาย ใจดี", "", "", "120", "", "", ""]]), items);
  ok("a verified result is shown as locked and never overwritten", L.buildLabPlan(db, actor, round, lockedFile, items).rows[0].cells[0].state === "locked");
  const stranger = mk("stranger", "คนนอก");
  ok("someone who is not a recorder cannot commit (the gateway refuses, nothing is half-written)", err(() => L.commitLabPlan(db, { id: stranger }, round, changed, items, { planHash: L.buildLabPlan(db, { id: stranger }, round, changed, items).hash, overwrite: true, registerByName: false, confirmImplausible: false })) !== "");

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health import tests passed");
})();
