// Health report PR 2: entering item values (store ↔ gateway). Run: node --import tsx scripts/test-health-entry.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-entry.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const G = await import("../src/lib/annual-checkup-db");
  const S = await import("../src/lib/health-report/store");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const err = (fn: () => unknown): string => { try { fn(); return ""; } catch (e) { return G.isAnnualCheckupForbidden(e) || G.isAnnualCheckupInvalid(e) ? (e as { code: string }).code : String(e); } };

  const co = Number(db.prepare("INSERT INTO companies (name_th) VALUES ('บริษัท ทดสอบ')").run().lastInsertRowid);
  const have = db.prepare("SELECT id FROM branches WHERE slug = 'at-home-clinic'").get() as { id: number } | undefined;
  if (have) db.prepare("UPDATE branches SET company_id = ? WHERE id = ?").run(co, have.id);
  const clinic = have?.id ?? Number(db.prepare("INSERT INTO branches (slug,name,company_id) VALUES ('at-home-clinic','AT HOME CLINIC',?)").run(co).lastInsertRowid);
  const mk = (u: string, role: string, extra: Record<string, unknown> = {}) => {
    const cols = ["username", "password_hash", "display_name", "role", "status", ...Object.keys(extra)];
    return Number(db.prepare(`INSERT INTO users (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(u, "x", u, role, "active", ...Object.values(extra)).lastInsertRowid);
  };
  const rec = mk("rec", "staff"); db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(rec, clinic);
  const owner = mk("owner", "super_admin");
  G.grantCapability({ id: owner }, rec, "recorder", "test");
  const emp = mk("emp", "staff", { dob: "1990-06-15", gender: "male" });
  const round = Number(db.prepare("INSERT INTO annual_checkup_rounds (name, year_be, status) VALUES ('รอบทดสอบ', 2569, 'open')").run().lastInsertRowid);
  const payer = Number(db.prepare("INSERT INTO annual_checkup_payers (round_id, name_th) VALUES (?, 'ผู้จ่าย')").run(round).lastInsertRowid);
  const order = (code: string) => Number(db.prepare("INSERT INTO annual_checkup_orders (round_id, user_id, payer_id, test_id) VALUES (?,?,?,(SELECT id FROM annual_checkup_tests WHERE code = ?))").run(round, emp, payer, code).lastInsertRowid);
  const oCbc = order("CBC"), oGlu = order("GLUCOSE"), oPhys = order("PHYSICAL"), oHav = order("HAV");
  const actor = { id: rec };
  const items = S.loadItems(db);
  const of = (c: string) => S.itemsOfTest(items, c);

  ok("the catalogue loads from the database with its reference rows", items.length > 100 && items.find((i) => i.code === "HDL")!.refs!.length === 2);
  ok("a test's items, computed ones excluded from typing", of("CBC").length === 16 && S.enterable(of("PHYSICAL")).every((i) => !i.computed) && of("PHYSICAL").some((i) => i.code === "BMI"));
  ok("employee date of birth reaches the age calculation", G.getSubjectDob(actor, { userId: emp }) === "1990-06-15");

  // single-item test: stored like the old screens
  ok("validation: a number is fine, text in a number field is not, an unknown code is not", S.validateValues(of("GLUCOSE"), { FBS: 95 }).length === 0 && S.validateValues(of("GLUCOSE"), { FBS: "abc" }).some((i) => i.problem === "not_a_number") && S.validateValues(of("GLUCOSE"), { NOPE: 1 }).some((i) => i.problem === "unknown_item"));
  ok("validation: glucose 1590 is implausible (asks to confirm), 95 is not", S.validateValues(of("GLUCOSE"), { FBS: 1590 })[0]?.problem === "implausible" && S.validateValues(of("GLUCOSE"), { FBS: 95 }).length === 0);
  ok("validation: a pick-list accepts only its choices", S.validateValues(of("PHYSICAL"), { EX_HEART: "ปกติ" }).length === 0 && S.validateValues(of("PHYSICAL"), { EX_HEART: "อื่นๆ" })[0]?.problem === "not_a_choice");
  ok("validation: BMI is computed, so typing it is refused", S.validateValues(of("PHYSICAL"), { BMI: 22 })[0]?.problem === "unknown_item");
  const gi = S.valuesToInput(of("GLUCOSE"), { FBS: 95 });
  ok("one-item test → value_num", gi.valueNum === 95 && gi.valueText === null && gi.valueJson === null);
  G.recordResult(actor, oGlu, gi);
  const hi = S.valuesToInput(of("HAV"), { HAV_IGM: "Negative", HAV_IGG: "Positive" });
  ok("a three-item test → value_json", hi.valueJson !== null && hi.valueNum === null);

  // panel: stored as JSON, empty values dropped, read back identically
  const cbcIn = S.valuesToInput(of("CBC"), { WBC: 6.5, NEUT: 55, HB: 14.2, RBC_MORPH: "Normal", PLT: "", LYMPH: null });
  ok("panel → value_json with only the filled items", JSON.parse(cbcIn.valueJson!).WBC === 6.5 && !("PLT" in JSON.parse(cbcIn.valueJson!)) && !("LYMPH" in JSON.parse(cbcIn.valueJson!)));
  G.recordResult(actor, oCbc, cbcIn);
  const sub = G.getSubjectClinical(actor, round, { userId: emp });
  const row = (code: string) => sub.results.find((r) => r.code === code)!;
  const back = S.valuesFromResult(of("CBC"), { value_num: null, value_text: null, value_json: row("CBC").value_json as string });
  ok("the panel reads back as typed", back.WBC === 6.5 && back.NEUT === 55 && back.HB === 14.2 && back.RBC_MORPH === "Normal" && back.PLT === undefined);
  ok("the single value reads back as typed", S.valuesFromResult(of("GLUCOSE"), { value_num: row("GLUCOSE").value_num as number, value_text: null, value_json: null }).FBS === 95);
  ok("saving again overwrites the draft (still one result row)", (() => { G.recordResult(actor, oCbc, S.valuesToInput(of("CBC"), { WBC: 7.1 })); return (db.prepare("SELECT COUNT(*) n FROM annual_checkup_results WHERE order_id = ?").get(oCbc) as { n: number }).n === 1; })());
  ok("clearing every field stores an empty draft rather than failing", err(() => G.recordResult(actor, oCbc, S.valuesToInput(of("CBC"), { WBC: "" }))) === "");

  // permissions are still the gateway's
  const stranger = mk("stranger", "staff");
  ok("someone who is not a recorder cannot save (the gateway refuses)", err(() => G.recordResult({ id: stranger }, oPhys, S.valuesToInput(of("PHYSICAL"), { EX_HEAD: "ปกติ" }))) !== "");
  const doc = mk("doc", "staff", { clinical_role: "doctor", license_no: "ว.12345" }); db.prepare("INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)").run(doc, clinic);
  G.grantCapability({ id: owner }, doc, "approver", "test");
  G.verifyResult({ id: doc }, (db.prepare("SELECT id FROM annual_checkup_results WHERE order_id = ?").get(oGlu) as { id: number }).id, { licenseUnlocked: true });
  ok("a result that is no longer a draft cannot be overwritten from the entry screen", err(() => G.recordResult(actor, oGlu, S.valuesToInput(of("GLUCOSE"), { FBS: 100 }))) !== "");

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health entry tests passed");
})();
