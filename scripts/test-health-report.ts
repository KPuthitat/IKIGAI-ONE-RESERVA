// Health report foundations: catalogue seed (idempotent, edits kept), reference by sex+age, flags, critical values,
// implausible entries, BMI, hearing and lung-function wording. Run: node --import tsx scripts/test-health-report.ts
import fs from "node:fs";
import path from "node:path";
const TMP = path.join(process.cwd(), "data", "test-health-report.db");
function cleanup() { for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } } }
cleanup(); fs.mkdirSync(path.dirname(TMP), { recursive: true }); process.env.DATABASE_PATH = TMP;

(async () => {
  const { getDb } = await import("../src/lib/db");
  const { ITEMS, SECTIONS, EXTRA_TESTS } = await import("../src/lib/health-report/catalog");
  const { ensureHealthReportSchema } = await import("../src/lib/health-report/schema");
  const I = await import("../src/lib/health-report/interpret");
  const db = getDb();
  let failed = 0;
  const ok = (n: string, c: boolean) => { if (c) console.log(`  ✓ ${n}`); else { failed++; console.error(`  ✗ FAIL: ${n}`); } };
  const item = (code: string) => { const x = ITEMS.find((i) => i.code === code); if (!x) throw new Error(`no item ${code}`); return x; };
  const flag = (code: string, v: number | string, sex: "M" | "F" | null = "M", age: number | null = 35) => I.flagResult(item(code), v, sex, age);
  const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

  // ── catalogue ──
  ok("item codes are unique", new Set(ITEMS.map((i) => i.code)).size === ITEMS.length);
  ok("every item belongs to a known section", ITEMS.every((i) => SECTIONS.some((s) => s.key === i.section)));
  const sec = (k: string) => ITEMS.filter((i) => i.section === k).length;
  ok("the booklet's counts: CBC 16, urine 19, chemistry 19, hearing 14, vision 13, lung 12, physical exam 10", sec("cbc") === 16 && sec("ua") === 19 && sec("chem") === 19 && sec("audio") === 14 && sec("vision") === 13 && sec("pft") === 12 && ITEMS.filter((i) => i.code.startsWith("EX_")).length === 10);
  ok("HIV is never printed in the booklet, the drug screen is restricted", item("ANTI_HIV").hidden === true && item("ANTI_HIV").restricted === true && item("DRUG_AMPH").restricted === true);

  // ── seed ──
  ok("the seed filled the items table", count("SELECT COUNT(*) n FROM annual_checkup_items") === ITEMS.length);
  ok("reference ranges were seeded (HDL has a male and a female row)", count("SELECT COUNT(*) n FROM annual_checkup_item_refs r JOIN annual_checkup_items i ON i.id = r.item_id WHERE i.code = 'HDL'") === 2);
  ok("the extra tests were added and the 20 existing ones are untouched", EXTRA_TESTS.every(([c]) => count("SELECT COUNT(*) n FROM annual_checkup_tests WHERE code = ?", c) === 1) && count("SELECT COUNT(*) n FROM annual_checkup_tests WHERE code IN ('CBC','URINE','GLUCOSE','SPIRO','AUDIO')") === 5);
  db.prepare("UPDATE annual_checkup_item_refs SET high = 99 WHERE item_id = (SELECT id FROM annual_checkup_items WHERE code = 'BUN')").run();
  db.prepare("UPDATE annual_checkup_items SET desc_th = 'แก้ไขแล้ว' WHERE code = 'WBC'").run();
  ensureHealthReportSchema(db); ensureHealthReportSchema(db);
  ok("running the migration again adds nothing and keeps the owner's edits", count("SELECT COUNT(*) n FROM annual_checkup_items") === ITEMS.length
    && count("SELECT COUNT(*) n FROM annual_checkup_item_refs r JOIN annual_checkup_items i ON i.id = r.item_id WHERE i.code = 'BUN' AND r.high = 99") === 1
    && count("SELECT COUNT(*) n FROM annual_checkup_items WHERE code = 'WBC' AND desc_th = 'แก้ไขแล้ว'") === 1);

  // ── reference by sex and age ──
  ok("HDL: male 38 low, male 42 normal, female 45 low, female 50 normal (≥ 50)", flag("HDL", 38) === "low" && flag("HDL", 42) === "normal" && flag("HDL", 45, "F") === "low" && flag("HDL", 50, "F") === "normal");
  ok("Hb by sex: 13 is low for a man and normal for a woman", flag("HB", 13, "M") === "low" && flag("HB", 13, "F") === "normal");
  ok("creatinine: 1.2 normal for a man, high for a woman", flag("CREAT", 1.2, "M") === "normal" && flag("CREAT", 1.2, "F") === "high");
  ok("ESR depends on age: man 16 is high at 49 and normal at 50", flag("ESR", 16, "M", 49) === "high" && flag("ESR", 16, "M", 50) === "normal");
  ok("ESR: woman 21 high at 40, normal at 55", flag("ESR", 21, "F", 40) === "high" && flag("ESR", 21, "F", 55) === "normal");
  ok("glucose 70–99 inclusive", flag("FBS", 69) === "low" && flag("FBS", 70) === "normal" && flag("FBS", 99) === "normal" && flag("FBS", 100) === "high");
  ok("'< 200' excludes 200 itself (cholesterol)", flag("CHOL", 199) === "normal" && flag("CHOL", 200) === "high");
  ok("eGFR '≥ 90' includes 90", flag("EGFR", 90) === "normal" && flag("EGFR", 89) === "low");
  ok("a person without a known sex gets no sex-specific verdict beyond the 'all' rows", I.pickRef(item("HB").refs, null, 30) === null && flag("WBC", 5, null, null) === "normal");
  ok("pick-list: Positive HBsAg abnormal, Positive Anti-HBs informative only, physical exam 'ผิดปกติ' abnormal", flag("HBSAG", "Positive") === "abnormal" && flag("ANTI_HBS", "Positive") === "info" && flag("EX_HEART", "ผิดปกติ") === "abnormal" && flag("EX_HEART", "ปกติ") === "normal");
  ok("an empty value has no flag", flag("FBS", "") === null);
  ok("the flag words are Thai: สูง / ต่ำ", I.FLAG_TH.high === "สูง" && I.FLAG_TH.low === "ต่ำ");
  ok("age on the exam date", I.ageOn("1990-11-25", "2026-11-24") === 35 && I.ageOn("1990-11-25", "2026-11-25") === 36 && I.ageOn(null, "2026-11-25") === null);

  // ── critical and implausible ──
  ok("liver enzymes beyond 5× the upper limit are critical (ALT 56 → 280 is not, 281 is)", !I.isCritical(item("ALT"), 280, "M", 35) && I.isCritical(item("ALT"), 281, "M", 35) && I.isCritical(item("AST"), 201, "F", 40) && !I.isCritical(item("AST"), 200, "F", 40));
  ok("the multiple is a setting", I.isCritical(item("ALT"), 120, "M", 35, { ...I.DEFAULT_THRESHOLDS, enzymeMultiple: 2 }));
  ok("a very low glucose is critical", I.isCritical(item("FBS"), 45, "M", 35) && !I.isCritical(item("FBS"), 80, "M", 35));
  ok("glucose 1590 is implausible, 95 is not", I.implausible(item("FBS"), 1590) && !I.implausible(item("FBS"), 95));
  ok("every number item has a plausible range", ITEMS.filter((i) => i.kind === "number" && !i.computed).every((i) => !!i.plausible));

  // ── reference text ──
  ok("reference label: range, one-sided, by sex", I.refLabel(item("WBC")) === "4.5 – 11" || I.refLabel(item("WBC")) === "4.5 – 11.0");
  ok("reference label: '< 200' and 'Male : ≥ 40'", I.refLabel(item("CHOL")) === "< 200" && I.refLabel(item("HDL")) === "Male : ≥ 40\nFemale : ≥ 50");
  ok("the printed text wins when the booklet has one", I.refLabel(item("UA_COLOR")) === "Yellow");

  // ── computed values ──
  ok("BMI 70 kg / 175 cm = 22.9 → normal weight; 85 kg / 170 cm = 29.4 → obese 1", I.bmi(70, 175) === 22.9 && I.bmiCategory(22.9) === "น้ำหนักปกติ" && I.bmi(85, 170) === 29.4 && I.bmiCategory(29.4) === "อ้วนระดับ 1");
  ok("BMI needs both numbers", I.bmi(null, 170) === null && I.bmi(70, 0) === null);
  ok("globulin = total protein − albumin; indirect bilirubin = total − direct", I.globulin(7.4, 4.5) === 2.9 && I.indirectBilirubin(1.0, 0.3) === 0.7);

  // ── hearing ──
  const norm = { 500: 10, 1000: 15, 2000: 20, 3000: 25, 4000: 20, 6000: 15, 8000: 10 };
  const all = { 500: 30, 1000: 35, 2000: 40, 3000: 45, 4000: 50, 6000: 55, 8000: 60 };
  ok("hearing: 25 dB is still normal, both ears on one line", I.interpretHearing(norm, norm) === "การได้ยินของหูขวาปกติ / การได้ยินของหูซ้ายปกติ");
  ok("hearing: 26 dB is reduced at that frequency", I.interpretHearing({ ...norm, 3000: 26 }, norm) === "การได้ยินของหูขวาลดลงที่ความถี่ 3000 เฮิรตซ์ / การได้ยินของหูซ้ายปกติ");
  ok("hearing: several frequencies are listed in order", I.interpretHearing(norm, { ...norm, 4000: 40, 6000: 45, 8000: 50 }) === "การได้ยินของหูขวาปกติ / การได้ยินของหูซ้ายลดลงที่ความถี่ 4000, 6000, 8000 เฮิรตซ์");
  ok("hearing: all seven frequencies over 25 → 'ลดลงทุกความถี่'", I.interpretHearing(all, all) === "การได้ยินของหูขวาลดลงทุกความถี่ / การได้ยินของหูซ้ายลดลงทุกความถี่");
  ok("hearing: an ear not tested is left out; nothing tested → null", I.interpretHearing(norm, {}) === "การได้ยินของหูขวาปกติ" && I.interpretHearing({}, {}) === null);

  // ── lung function ──
  const sp = (age: number, ratio: number, fvc: number, fev1: number) => I.interpretSpirometry({ age, ratio, fvcPct: fvc, fev1Pct: fev1 }).kind;
  ok("lung: ratio limit is 75 under 50 y and 70 from 50 y", sp(40, 75, 95, 95) === "borderline" && sp(40, 76, 95, 95) === "normal" && sp(50, 70, 95, 95) === "borderline" && sp(50, 71, 95, 95) === "normal" && sp(49, 72, 95, 95) === "borderline" && sp(55, 72, 95, 95) === "normal");
  ok("lung: FVC / FEV1 are abnormal at 80 % predicted or lower", sp(40, 85, 80, 90) === "restrictive" && sp(40, 85, 81, 81) === "normal" && sp(40, 85, 90, 80) === "restrictive");
  ok("lung: only the ratio low = borderline group (not obstructive)", sp(30, 70, 90, 90) === "borderline");
  ok("lung: ratio + FEV1 low = obstructive; ratio + FVC low = mixed", sp(30, 60, 90, 70) === "obstructive" && sp(30, 60, 70, 70) === "mixed");
  ok("lung: missing data is 'incomplete', and FEF 25-75 plays no part", I.interpretSpirometry({ age: 30, ratio: null, fvcPct: 90, fev1Pct: 90 }).kind === "incomplete");

  cleanup();
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log("\nAll health report tests passed");
})();
