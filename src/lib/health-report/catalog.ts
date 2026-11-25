// Health check-up report catalogue (owner 2026-11-25) — every reportable item of the "AHC x OMH Health" booklet
// (docs/design/health-report-template.pdf): its section, bilingual name, unit, reference ranges by sex and age, the
// choices of a pick-list result, and a plausible range used to ask "are you sure?" on a typo (e.g. glucose 1590).
// Reference values are copied from the template; anything small-print or ambiguous carries `check: true` and is listed in
// docs/health-report-reference-ranges.md for the doctor to confirm. Seeded into annual_checkup_items / _item_refs once;
// after that the database copy (editable in the settings screen) is the truth, so this file never overwrites an edit.

export type Sex = "M" | "F" | "A";
export type Ref = { sex: Sex; ageMin?: number; ageMax?: number; low?: number; high?: number; lowIncl?: boolean; highIncl?: boolean };
export type ItemKind = "number" | "choice" | "text" | "file";
export type Item = {
  code: string; test: string; section: string; en: string; th: string; unit?: string; kind: ItemKind;
  choices?: string[]; normal?: string[] | "any";     // pick-list: which choices count as normal ("any" = informative only, never flagged)
  refs?: Ref[]; refText?: string;                    // numeric ranges, and/or the template's printed reference text
  plausible?: [number, number]; decimals?: number;
  computed?: "bmi" | "globulin" | "indirect_bili";
  hidden?: boolean;                                  // never printed in the booklet (HIV: a separate document under the person's consent)
  restricted?: boolean;                              // readable only by the doctor and the person (drug screen)
  check?: boolean;                                   // value or wording to be confirmed by the doctor
};

export const SECTIONS: Array<{ key: string; th: string; en: string; sort: number }> = [
  { key: "general", th: "ข้อมูลส่วนบุคคลและตรวจร่างกาย", en: "General information and physical examination", sort: 10 },
  { key: "cbc", th: "ผลการตรวจความสมบูรณ์ของเม็ดเลือด", en: "Complete blood count : CBC", sort: 20 },
  { key: "ua", th: "ผลการตรวจความสมบูรณ์ของปัสสาวะ", en: "Urine analysis : UA", sort: 30 },
  { key: "chem", th: "ผลการตรวจทางชีวเคมีในเลือด", en: "Blood chemistry examination", sort: 40 },
  { key: "audio", th: "ตรวจสมรรถภาพการได้ยิน", en: "Audiometry screening", sort: 50 },
  { key: "vision", th: "ตรวจสายตาอาชีวอนามัย", en: "Occupational health vision test", sort: 60 },
  { key: "pft", th: "ตรวจสมรรถภาพปอด", en: "Pulmonary function test", sort: 70 },
  { key: "cxr", th: "ผลการตรวจทางรังสีวิทยา (เอกซเรย์ทรวงอก)", en: "Radiologic examination (Chest x-ray)", sort: 80 },
  { key: "ecg", th: "ผลการตรวจคลื่นไฟฟ้าหัวใจ", en: "Electrocardiogram (ECG)", sort: 90 },
  { key: "other", th: "รายการตรวจทางห้องปฏิบัติการอื่นๆ", en: "Other laboratory examination", sort: 100 },
  { key: "stool", th: "ตรวจอุจจาระ", en: "Stool examination", sort: 110 },
  { key: "cervical", th: "ตรวจคัดกรองมะเร็งปากมดลูก", en: "Cervical cancer screening", sort: 120 },
  { key: "drug", th: "ตรวจสารเสพติดในปัสสาวะ", en: "Urine drug screen", sort: 130 }
];

const r = (low?: number, high?: number, o: Partial<Ref> = {}): Ref => ({ sex: "A", low, high, ...o });
const M = (low?: number, high?: number, o: Partial<Ref> = {}): Ref => r(low, high, { sex: "M", ...o });
const F = (low?: number, high?: number, o: Partial<Ref> = {}): Ref => r(low, high, { sex: "F", ...o });
const lt = (high: number): Ref => r(undefined, high, { highIncl: false });          // "< 200"
const ge = (low: number): Ref => r(low, undefined, { lowIncl: true });              // "≥ 90"
const NEG = ["Negative", "Trace", "1+", "2+", "3+", "4+"];
const PN = ["Negative", "Positive"];
const NORMAL_ABN = ["ปกติ", "ผิดปกติ"];

const n = (code: string, test: string, section: string, en: string, th: string, unit: string, refs: Ref[], plausible: [number, number], extra: Partial<Item> = {}): Item =>
  ({ code, test, section, en, th, unit, kind: "number", refs, plausible, ...extra });
const c = (code: string, test: string, section: string, en: string, th: string, choices: string[], normal: string[] | "any", extra: Partial<Item> = {}): Item =>
  ({ code, test, section, en, th, kind: "choice", choices, normal, ...extra });
const t = (code: string, test: string, section: string, en: string, th: string, extra: Partial<Item> = {}): Item =>
  ({ code, test, section, en, th, kind: "text", ...extra });

const EXAM = [
  ["HEAD", "Head", "ศีรษะ"], ["ENT", "Ear Nose Throat", "ตา หู คอ จมูก"], ["ORAL", "Oral cavity and teeth", "ช่องปาก และฟัน"],
  ["CHEST", "Chest", "ปอด และทรวงอก"], ["HEART", "Heart", "หัวใจ และหลอดเลือด"], ["ABDOMEN", "Abdomen", "ช่องท้อง"],
  ["MSK", "Musculoskeletal", "กล้ามเนื้อ และข้อต่อ"], ["NERVOUS", "Nervous system", "ระบบประสาท"], ["SKIN", "Skin", "ผิวหนัง"], ["LYMPH", "Lymph nodes", "ต่อมน้ำเหลือง"]
] as const;
const FREQ = [500, 1000, 2000, 3000, 4000, 6000, 8000];
const VISION: Array<[string, string, string]> = [
  ["BINOC", "Binocular vision", "การมองด้วยสองตา"], ["FAR_BOTH", "Far vision - Both", "การมองภาพระยะไกล (สองตา)"], ["FAR_R", "Far vision - Right", "การมองภาพระยะไกล (ตาขวา)"],
  ["FAR_L", "Far vision - Left", "การมองภาพระยะไกล (ตาซ้าย)"], ["STEREO", "Stereo depth", "การมองภาพสามมิติ"], ["COLOR", "Color discrimination", "การมองจำแนกสี"],
  ["FAR_VPH", "Far vertical phoria", "ความสมดุลกล้ามเนื้อตาระยะไกลแนวตั้ง"], ["FAR_LPH", "Far lateral phoria", "ความสมดุลกล้ามเนื้อตาระยะไกลแนวนอน"],
  ["NEAR_BOTH", "Near vision - Both", "การมองภาพระยะใกล้ (สองตา)"], ["NEAR_R", "Near vision - Right", "การมองภาพระยะใกล้ (ตาขวา)"], ["NEAR_L", "Near vision - Left", "การมองภาพระยะใกล้ (ตาซ้าย)"],
  ["NEAR_LPH", "Near lateral phoria", "ความสมดุลกล้ามเนื้อตาระยะใกล้แนวนอน"], ["VFIELD", "Visual field", "ลานสายตา"]
];
const PFT: Array<[string, string, string, [number, number], [number, number]]> = [
  ["FVC", "Forced Vital Capacity : FVC", "ปริมาตรอากาศสูงสุดที่ได้จากการหายใจออกอย่างเร็วและแรงที่สุด จากตำแหน่งหายใจเข้าเต็มที่", [0.3, 9], [0.3, 9]],
  ["FEV1", "Forced expiratory volume in 1 second : FEV1", "ปริมาตรอากาศสูงสุดใน 1 วินาทีแรก ที่ได้จากการหายใจออกอย่างเร็วและแรงที่สุด จากตำแหน่งหายใจเข้าเต็มที่", [0.2, 8], [0.2, 8]],
  ["FEV1FVC", "Forced expiratory volume in 1 second / Forced vital capacity : FEV1/FVC", "ค่าที่ได้จากการนำ FEV1 หารด้วย FVC แล้วคูณด้วย 100", [20, 100], [20, 100]],
  ["FEF", "Forced expiratory flow at 25-75 % : FEF 25-75", "ค่าเฉลี่ยของอัตราการไหลของอากาศที่คำนวณในระหว่างช่วงปริมาณ 25–75 % ของ FVC (ช่วงกลางของ FVC)", [0.1, 10], [0.1, 10]]
];

export const ITEMS: Item[] = [
  // ── general (history + vitals + physical examination) ──
  n("WEIGHT", "PHYSICAL", "general", "Weight", "น้ำหนัก", "กก.", [], [2, 400], { decimals: 1 }),
  n("HEIGHT", "PHYSICAL", "general", "Height", "ส่วนสูง", "ซม.", [], [40, 250], { decimals: 1 }),
  n("BMI", "PHYSICAL", "general", "Body Mass Index : BMI", "ดัชนีมวลกาย", "กก./ตร.ม.", [], [8, 90], { decimals: 1, computed: "bmi" }),
  n("BP_SYS", "PHYSICAL", "general", "Blood pressure (systolic)", "ความดันโลหิตตัวบน", "mmHg", [], [50, 300]),
  n("BP_DIA", "PHYSICAL", "general", "Blood pressure (diastolic)", "ความดันโลหิตตัวล่าง", "mmHg", [], [20, 200]),
  n("PULSE", "PHYSICAL", "general", "Pulse", "ชีพจร", "ครั้งต่อนาที", [], [20, 250]),
  c("BLOOD_GROUP", "PHYSICAL", "general", "ABO/Rh Group", "หมู่โลหิต", ["A Rh+", "B Rh+", "O Rh+", "AB Rh+", "A Rh-", "B Rh-", "O Rh-", "AB Rh-"], "any"),
  c("SMOKING", "PHYSICAL", "general", "History of smoking", "ประวัติสูบบุหรี่", ["ไม่มี", "มี", "เลิกแล้ว"], "any"),
  c("ALCOHOL", "PHYSICAL", "general", "History of alcohol drinking", "ประวัติดื่มสุรา", ["ไม่มี", "มี", "เลิกแล้ว"], "any"),
  c("ALLERGY", "PHYSICAL", "general", "History of food / drug allergy", "ประวัติแพ้ยา/อาหาร", ["ไม่มี", "มี"], "any"),
  t("UNDERLYING", "PHYSICAL", "general", "History of underlying disease", "ประวัติโรคประจำตัว"),
  ...EXAM.map(([k, en, th]) => c(`EX_${k}`, "PHYSICAL", "general", en, th, NORMAL_ABN, ["ปกติ"], { refText: "Normal (ปกติ)" })),

  // ── CBC ──
  n("WBC", "CBC", "cbc", "WBC Count", "จำนวนเม็ดเลือดขาว", "x 10³ cell/mm³", [r(4.5, 11.0)], [0.1, 500], { decimals: 2 }),
  n("NEUT", "CBC", "cbc", "Neutrophil", "จำนวนเม็ดเลือดขาว ชนิดนิวโทรฟิล", "%", [r(40, 80)], [0, 100]),
  n("LYMPH", "CBC", "cbc", "Lymphocyte", "จำนวนเม็ดเลือดขาว ชนิดลิมโฟไซต์", "%", [r(20, 40)], [0, 100]),
  n("MONO", "CBC", "cbc", "Monocyte", "จำนวนเม็ดเลือดขาว ชนิดโมโนไซต์", "%", [r(2, 10)], [0, 100]),
  n("EOS", "CBC", "cbc", "Eosinophil", "จำนวนเม็ดเลือดขาว ชนิดอีโอซิโนฟิล", "%", [r(1, 6)], [0, 100]),
  n("BASO", "CBC", "cbc", "Basophil", "จำนวนเม็ดเลือดขาว ชนิดเบโซฟิล", "%", [r(0, 2)], [0, 100], { check: true }),   // template prints "< 1 – 2"
  n("RBC", "CBC", "cbc", "RBC Count", "จำนวนเม็ดเลือดแดง", "x 10⁶ cell/µL", [M(4.5, 5.9), F(4.5, 5.1)], [0.5, 12], { decimals: 2 }),
  n("HB", "CBC", "cbc", "Hb (Hemoglobin)", "ความเข้มข้นของโปรตีนฮีโมโกลบินในเลือด", "g/dL", [M(13.5, 17.5), F(12.0, 15.5)], [2, 25], { decimals: 1 }),
  n("HCT", "CBC", "cbc", "Hct (Hematocrit)", "ค่าปริมาณความเข้มข้นของเม็ดเลือดแดง", "%", [M(38.8, 50.0), F(34.9, 44.5)], [8, 75], { decimals: 1 }),
  n("MCV", "CBC", "cbc", "MCV", "ปริมาตรของเม็ดเลือดแดงโดยเฉลี่ย", "fL", [r(80, 96)], [40, 150], { decimals: 1 }),
  n("MCH", "CBC", "cbc", "MCH", "ค่าเฉลี่ยฮีโมโกลบินในเม็ดเลือดแดง", "pg", [r(27.5, 33.2)], [10, 60], { decimals: 1 }),
  n("MCHC", "CBC", "cbc", "MCHC", "ค่าความเข้มข้นเฉลี่ยของฮีโมโกลบินในเม็ดเลือดแดง", "g/dL", [r(33.4, 35.5)], [20, 45], { decimals: 1 }),
  n("RDW", "CBC", "cbc", "RDW", "ค่าความแปรปรวนของขนาดเม็ดเลือดแดง", "%", [r(11.6, 14.6)], [5, 40], { decimals: 1 }),
  n("PLT", "CBC", "cbc", "Platelet count", "การตรวจนับจำนวนเกล็ดเลือด", "x 10³ cell/mm³", [r(150, 450)], [1, 2000]),
  c("RBC_MORPH", "CBC", "cbc", "RBC Morphology", "รูปร่างของเม็ดเลือดแดง", ["Normal", "Abnormal"], ["Normal"]),
  n("ESR", "CBC", "cbc", "ESR", "อัตราการตกตะกอนของเม็ดเลือดแดง", "mm/hr", [
    M(undefined, 15, { ageMax: 49, highIncl: false }), F(undefined, 20, { ageMax: 49, highIncl: false }),
    M(undefined, 20, { ageMin: 50, highIncl: false }), F(undefined, 30, { ageMin: 50, highIncl: false })
  ], [0, 150], { check: true }),   // template: "Age < 50 : Male <15 / Female <20 · Age > 50 : Male <20 / Female <30" (age exactly 50 is read as the older band)

  // ── urine analysis ──
  t("UA_COLOR", "URINE", "ua", "Color", "สีของปัสสาวะ", { refText: "Yellow" }),
  t("UA_APPEAR", "URINE", "ua", "Appearance", "ลักษณะของปัสสาวะ", { refText: "Clear" }),
  n("UA_SG", "URINE", "ua", "Specific gravity", "ความถ่วงจำเพาะ หรือความเข้มข้นของปัสสาวะ", "", [r(1.003, 1.035)], [1.0, 1.06], { decimals: 3 }),
  n("UA_PH", "URINE", "ua", "pH", "ความเป็นกรด-ด่างของปัสสาวะ", "", [r(4.5, 8.0)], [3, 10], { decimals: 1 }),
  c("UA_URO", "URINE", "ua", "Urobilinogen", "การตรวจหาสารยูโรบิลิโนเจนในปัสสาวะ", ["Normal", "Increased"], ["Normal"]),
  c("UA_BIL", "URINE", "ua", "Bilirubin", "การตรวจหาสารบิลิรูบินในปัสสาวะ", NEG, ["Negative"]),
  c("UA_NIT", "URINE", "ua", "Nitrite", "การตรวจหาสารไนไตรท์ในปัสสาวะ", ["Negative", "Positive"], ["Negative"]),
  c("UA_LE", "URINE", "ua", "Leukocyte esterase", "การตรวจหาเม็ดเลือดขาวในปัสสาวะ", NEG, ["Negative"]),
  c("UA_ERY", "URINE", "ua", "Erythrocyte", "การตรวจหาเม็ดเลือดแดงในปัสสาวะ", NEG, ["Negative"]),
  c("UA_PRO", "URINE", "ua", "Protein", "การตรวจหาโปรตีนในปัสสาวะ", NEG, ["Negative"]),
  c("UA_GLU", "URINE", "ua", "Glucose", "การตรวจหาน้ำตาลในปัสสาวะ", NEG, ["Negative"]),
  c("UA_KET", "URINE", "ua", "Ketone", "การตรวจหาสารคีโตนในปัสสาวะ", NEG, ["Negative"]),
  n("UA_RBC", "URINE", "ua", "Red blood cell", "การส่องตรวจดูเม็ดเลือดแดงด้วยกล้องจุลทรรศน์", "cells/HPF", [r(0, 2)], [0, 1000]),
  n("UA_WBC", "URINE", "ua", "White blood cell", "การส่องตรวจดูเม็ดเลือดขาวด้วยกล้องจุลทรรศน์", "cells/HPF", [r(0, 5)], [0, 1000]),
  n("UA_EPI", "URINE", "ua", "Epithelium cell", "การส่องตรวจดูเซลล์เยื่อบุด้วยกล้องจุลทรรศน์", "cells/HPF", [r(15, 20)], [0, 1000], { check: true }),   // template prints 15 – 20 (usual lab range is 0 – 5)
  t("UA_CAST", "URINE", "ua", "Cast", "การส่องตรวจดูตะกอนจากท่อไตด้วยกล้องจุลทรรศน์", { check: true }),
  t("UA_CRYSTAL", "URINE", "ua", "Crystal", "การส่องตรวจดูผลึกสารเคมีด้วยกล้องจุลทรรศน์"),
  t("UA_MUCOUS", "URINE", "ua", "Mucous", "การส่องตรวจดูเมือกด้วยกล้องจุลทรรศน์"),
  c("UA_BACT", "URINE", "ua", "Bacteria/Yeast/Parasite", "การส่องตรวจดูเชื้อก่อโรคด้วยกล้องจุลทรรศน์", ["Not found", "Found"], ["Not found"], { refText: "Not found" }),

  // ── blood chemistry ──
  n("FBS", "GLUCOSE", "chem", "Fasting blood sugar", "ระดับน้ำตาลกลูโคสในเลือดหลังอดอาหาร", "mg/dL", [r(70, 99)], [20, 800]),
  n("HBA1C", "HBA1C", "chem", "Hemoglobin A1C", "ระดับน้ำตาลสะสมในเลือดเฉลี่ยในช่วง 2-3 เดือน", "%", [r(4.0, 5.6)], [3, 20], { decimals: 1 }),
  n("CHOL", "CHOL", "chem", "Total cholesterol", "ปริมาณคอเลสเตอรอลทั้งหมดในเลือด", "mg/dL", [lt(200)], [40, 1000]),
  n("TG", "TG", "chem", "Triglyceride", "ปริมาณไขมันไตรกลีเซอไรด์ในเลือด", "mg/dL", [lt(150)], [10, 5000]),
  n("HDL", "HDL", "chem", "HDL-cholesterol", "ปริมาณไขมัน เอชดีแอล คอเลสเตอรอลในเลือด", "mg/dL", [M(40, undefined, { lowIncl: true }), F(50, undefined, { lowIncl: true })], [5, 200]),
  n("LDL", "LDL", "chem", "LDL-cholesterol", "ปริมาณไขมัน แอลดีแอล คอเลสเตอรอลในเลือด", "mg/dL", [lt(100)], [10, 700]),
  n("BUN", "BUN", "chem", "Blood urea nitrogen", "ค่าการทำงานของไต Blood urea nitrogen", "mg/dL", [r(7, 20)], [1, 250]),
  n("CREAT", "CREAT", "chem", "Creatinine", "ค่าการทำงานของไต Creatinine", "mg/dL", [M(0.7, 1.3), F(0.6, 1.1)], [0.1, 30], { decimals: 2 }),
  n("EGFR", "CREAT", "chem", "eGFR", "ค่าการทำงานของไต / อัตราการกรองของไต", "mL/min/1.73 m²", [ge(90)], [1, 200]),
  n("URIC", "URIC", "chem", "Uric acid", "ระดับกรดยูริคในเลือด", "mg/dL", [M(3.4, 7.0), F(2.4, 6.0)], [0.5, 25], { decimals: 1 }),
  n("AST", "SGOT", "chem", "AST/SGOT", "ค่าการทำงานของตับ AST/SGOT", "U/L", [r(8, 40)], [1, 10000]),
  n("ALT", "SGPT", "chem", "ALT/SGPT", "ค่าการทำงานของตับ ALT/SGPT", "U/L", [r(7, 56)], [1, 10000]),
  n("ALP", "ALP", "chem", "ALK/ALP", "ค่าการทำงานของตับ ALK/ALP", "U/L", [r(40, 130)], [5, 3000]),
  n("TP", "TP", "chem", "Total protein", "ระดับโปรตีนรวมในเลือด", "g/dL", [r(6.0, 8.3)], [2, 15], { decimals: 1 }),
  n("ALB", "ALB", "chem", "Albumin", "ระดับโปรตีนอัลบูมินในเลือด", "g/dL", [r(3.5, 5.0)], [0.5, 8], { decimals: 1 }),
  n("GLOB", "ALB", "chem", "Globulin", "ระดับโปรตีนโกลบูลินในเลือด", "g/dL", [r(2.0, 3.5)], [0.1, 10], { decimals: 1, computed: "globulin" }),
  n("TBIL", "TBIL", "chem", "Total bilirubin", "ระดับบิลิรูบินรวมในเลือด", "mg/dL", [r(0.1, 1.2)], [0.05, 50], { decimals: 1 }),
  n("DBIL", "TBIL", "chem", "Direct bilirubin", "ระดับบิลิรูบิน Direct bilirubin", "mg/dL", [r(0.0, 0.3)], [0, 40], { decimals: 1 }),
  n("IBIL", "TBIL", "chem", "Indirect bilirubin", "ระดับบิลิรูบิน Indirect bilirubin", "mg/dL", [r(0.2, 0.8)], [0, 40], { decimals: 1, computed: "indirect_bili" }),

  // ── audiometry: dB hearing level per ear and frequency, normal ≤ 25 dB ──
  ...(["R", "L"] as const).flatMap((ear) => FREQ.map((f) => n(`AUD_${ear}_${f}`, "AUDIO", "audio", `Frequency ${f.toLocaleString("en-US")} Hertz (Hz) · ${ear === "R" ? "Rt (หูขวา)" : "Lt (หูซ้าย)"}`, `ระดับการได้ยิน - ความถี่ ${f.toLocaleString("en-US")} เฮิรตซ์`, "dB", [r(undefined, 25, { highIncl: true })], [-10, 120]))),

  // ── occupational vision ──
  ...VISION.map(([k, en, th]) => c(`EYE_${k}`, "EYE", "vision", en, th, NORMAL_ABN, ["ปกติ"], { refText: "Normal (ปกติ)" })),

  // ── pulmonary function: measured / predicted / % predicted ──
  ...PFT.flatMap(([k, en, th, mp, pp]) => [
    n(`${k}_MEAS`, "SPIRO", "pft", `${en} · Measure`, `${th} · ค่าที่ได้`, k === "FEV1FVC" ? "%" : "L", [], mp, { decimals: 2 }),
    n(`${k}_PRED`, "SPIRO", "pft", `${en} · Predicted`, `${th} · ค่าคาดคะเน`, k === "FEV1FVC" ? "%" : "L", [], pp, { decimals: 2 }),
    n(`${k}_PCT`, "SPIRO", "pft", `${en} · % Predicted`, `${th} · ร้อยละของค่าคาดคะเน`, "%", k === "FVC" || k === "FEV1" ? [r(80, undefined, { lowIncl: false })] : [], [5, 250], { decimals: 1 })
  ]),

  // ── imaging ──
  t("CXR_RESULT", "CXR", "cxr", "Chest x-ray", "ผลอ่านเอกซเรย์ทรวงอก"),
  { code: "CXR_IMAGE", test: "CXR", section: "cxr", en: "Chest x-ray image", th: "ภาพถ่ายเอกซเรย์", kind: "file" },
  t("ECG_RESULT", "ECG", "ecg", "Electrocardiogram", "ผลอ่านคลื่นไฟฟ้าหัวใจ"),
  { code: "ECG_IMAGE", test: "ECG", section: "ecg", en: "Electrocardiogram graph", th: "กราฟคลื่นไฟฟ้าหัวใจ", kind: "file" },

  // ── other laboratory ──
  c("HAV_IGM", "HAV", "other", "Anti-HAV (IgM)", "ตรวจหาภูมิคุ้มกันต่อไวรัสตับอักเสบเอ ชนิด IgM", PN, ["Negative"], { refText: "Positive : ท่านกำลังติดเชื้อ ระยะเฉียบพลัน\nNegative : ไม่พบการติดเชื้อใหม่", check: true }),
  c("HAV_IGG", "HAV", "other", "Anti-HAV (IgG)", "ตรวจหาภูมิคุ้มกันต่อไวรัสตับอักเสบเอ ชนิด IgG", PN, "any", { refText: "Positive : พบภูมิคุ้มกันจากการหายจากการติดเชื้อ หรือได้รับวัคซีน\nNegative : ไม่พบภูมิคุ้มกัน", check: true }),
  c("HAV_TOTAL", "HAV", "other", "Anti-HAV (IgM+IgG)(Total)", "ตรวจหาภูมิคุ้มกันต่อไวรัสตับอักเสบเอ แบบรวม", PN, "any", { refText: "Positive : พบภูมิคุ้มกันหรือเคยติดเชื้อ\nNegative : ไม่พบภูมิคุ้มกันและไม่เคยติดเชื้อ", check: true }),
  c("HBSAG", "HBSAG", "other", "HBsAg", "ตรวจหาแอนติเจนผิวของไวรัสตับอักเสบบี", PN, ["Negative"], { refText: "Positive : พบเชื้อไวรัสตับอักเสบบี\nNegative : ไม่พบเชื้อไวรัสตับอักเสบบี", check: true }),
  c("ANTI_HBS", "ANTIHBS", "other", "Anti-HBs", "ตรวจหาภูมิคุ้มกันต่อไวรัสตับอักเสบบี", PN, "any", { refText: "Positive : พบภูมิคุ้มกัน หรือรับวัคซีนแล้ว\nNegative : ไม่พบภูมิคุ้มกัน", check: true }),
  c("ANTI_HBC", "ANTIHBC", "other", "Anti-HBc", "ตรวจหาภูมิคุ้มกันต่อแกนกลางไวรัสตับอักเสบบี", PN, ["Negative"], { refText: "Positive : เคยติดเชื้อมาก่อน\nNegative : ไม่เคยติดเชื้อมาก่อน", check: true }),
  c("ANTI_HCV", "ANTIHCV", "other", "Anti-HCV", "ตรวจหาภูมิคุ้มกันต่อไวรัสตับอักเสบซี", PN, ["Negative"], { refText: "Positive : พบการติดเชื้อหรือเคยติดเชื้อ\nNegative : ไม่พบการติดเชื้อ", check: true }),
  c("ANTI_HIV", "HIV", "other", "Anti-HIV", "ตรวจหาภูมิคุ้มกันต่อเชื้อเอชไอวี", PN, ["Negative"], { hidden: true, restricted: true, refText: "(รายงานผลตรวจ ออกให้ในเอกสารอีกฉบับ โดยได้รับความยินยอมจากผู้เข้ารับการตรวจแล้ว)" }),
  c("VDRL", "VDRL", "other", "VDRL", "การตรวจกรองโรคซิฟิลิส", ["Negative", "Positive"], ["Negative"], { refText: "Negative" }),
  n("TSH", "TSH", "other", "TSH : Thyroid-stimulating hormone", "ฮอร์โมนจากต่อมใต้สมองที่กระตุ้นต่อมไทรอยด์", "uIU/mL", [r(0.350, 4.940)], [0.001, 500], { decimals: 3 }),
  n("FT3", "FT3", "other", "Free T3 : Free triiodothyronine", "ฮอร์โมนจากต่อมไทรอยด์ชนิด T3 ในรูปอิสระ", "pg/mL", [r(1.58, 3.91)], [0.1, 50], { decimals: 2 }),
  n("FT4", "FT4", "other", "Free T4 : Thyroxine", "ฮอร์โมนจากต่อมไทรอยด์ชนิด T4 ในรูปอิสระ", "ng/dL", [r(0.70, 1.48)], [0.05, 20], { decimals: 2 }),
  n("CORTISOL", "CORTISOL", "other", "Cortisol", "ฮอร์โมนจากต่อมหมวกไต", "", [r(0, 2)], [0, 200], { check: true }),   // template prints 0 – 2 with no unit
  n("AFP", "AFP", "other", "AFP : Alpha-fetoprotein", "สารบ่งชี้มะเร็งตับ และความผิดปกติของตับ", "ng/mL", [r(0.0, 10.0)], [0, 100000], { decimals: 1 }),
  n("CEA", "CEA", "other", "CEA : Carcinoembryonic antigen", "สารบ่งชี้มะเร็งลำไส้ใหญ่ และมะเร็งบางชนิด", "ng/mL", [r(0.0, 5.8)], [0, 100000], { decimals: 1 }),
  n("PSA", "PSA", "other", "PSA : Prostate-specific antigen", "สารบ่งชี้มะเร็งต่อมลูกหมาก", "ng/mL", [r(0.0, 4.0)], [0, 100000], { decimals: 2 }),
  n("CA125", "CA125", "other", "CA125 : Carbohydrate antigen 125", "สารบ่งชี้มะเร็งรังไข่", "ng/mL", [r(0, 35)], [0, 100000], { check: true }),
  n("CA153", "CA153", "other", "CA153 : Cancer antigen 153", "สารบ่งชี้มะเร็งเต้านม", "ng/mL", [r(0, 25)], [0, 100000], { check: true }),
  n("CA199", "CA199", "other", "CA199 : Carbohydrate antigen 199", "สารบ่งชี้มะเร็งตับอ่อน และทางเดินอาหารบางชนิด", "ng/mL", [r(0, 27)], [0, 100000], { check: true }),

  // ── stool ──
  t("ST_COLOR", "STOOLEXAM", "stool", "Color", "สีของอุจจาระ"),
  t("ST_APPEAR", "STOOLEXAM", "stool", "Appearance", "ลักษณะทั่วไปของอุจจาระ"),
  c("ST_WBC", "STOOLEXAM", "stool", "WBC : Stool", "การตรวจหาเม็ดเลือดขาวในอุจจาระ", ["Negative", "Positive"], ["Negative"], { refText: "Negative" }),
  c("ST_RBC", "STOOLEXAM", "stool", "RBC : Stool", "การตรวจหาเม็ดเลือดแดงในอุจจาระ", ["Negative", "Positive"], ["Negative"], { refText: "Negative" }),
  c("ST_PARASITE", "STOOLEXAM", "stool", "Parasite : Stool", "การตรวจหาไข่หรือพยาธิในอุจจาระ", ["Not found", "Found"], ["Not found"], { refText: "Not found" }),
  c("ST_FUNGUS", "STOOLEXAM", "stool", "Fungus : Stool", "การตรวจหาเชื้อราในอุจจาระ", ["No fungus seen", "Fungus seen"], ["No fungus seen"], { refText: "No fungus seen" }),
  c("ST_FOB", "FOB", "stool", "Fecal occult blood", "การตรวจหาเลือดที่ไม่ปรากฏให้เห็นด้วยตาเปล่า", ["Negative", "Positive"], ["Negative"], { refText: "Negative" }),
  t("ST_CULTURE", "STOOL", "stool", "Stool culture and sensitivity", "การเพาะเชื้อในทางเดินอาหารและทดสอบความไวต่อยาปฏิชีวนะ", { refText: "No enteropathogenic bacteria seen\n(Negative for Salmonella spp., Shigella spp., Aeromonas spp., Plesiomonas spp. and Vibrio spp.)" }),

  // ── cervical + drug screen ──
  t("PAP_LBC", "PAP", "cervical", "Liquid-based preparation / SurePrep®", "สรุปผลการตรวจคัดกรองมะเร็งปากมดลูก Liquid-based preparation (The 2014 Bethesda system)"),
  t("PAP_HPV", "HPV", "cervical", "HPV DNA with Genotyping (High risk 14 subtypes)", "สรุปผลการตรวจ HPV DNA with Genotyping (High risk 14 subtypes: 16, 18, 31, 33, 35, 39, 45, 51, 52, 56, 58, 59, 66 และ 68)"),
  c("DRUG_AMPH", "AMPH", "drug", "Urine amphetamine", "ตรวจหาสารเสพติด (เมทแอมเฟตามีน) ในปัสสาวะ", ["Negative", "Positive"], ["Negative"], { restricted: true, refText: "Positive : พบสารเสพติดในปัสสาวะ\nNegative : ไม่พบสารเสพติดในปัสสาวะ" })
];

/** Orderable tests the report needs that the 2026 programme catalogue (20 tests) does not have yet. */
export const EXTRA_TESTS: Array<[code: string, th: string, en: string, kind: "number" | "text" | "panel"]> = [
  ["HBA1C", "น้ำตาลสะสม (HbA1C)", "Hemoglobin A1C", "number"], ["ALP", "การทำงานของตับ (ALP)", "Alkaline phosphatase (ALP)", "number"],
  ["TP", "โปรตีนรวมในเลือด", "Total protein", "number"], ["ALB", "อัลบูมินและโกลบูลิน", "Albumin / Globulin", "panel"], ["TBIL", "บิลิรูบิน", "Bilirubin (total / direct / indirect)", "panel"],
  ["ANTIHBS", "ภูมิคุ้มกันไวรัสตับอักเสบบี (Anti-HBs)", "Anti-HBs", "text"], ["ANTIHBC", "Anti-HBc", "Anti-HBc", "text"], ["ANTIHCV", "ไวรัสตับอักเสบซี (Anti-HCV)", "Anti-HCV", "text"],
  ["HIV", "เอชไอวี (ผลออกเอกสารแยก)", "Anti-HIV (separate document)", "text"], ["VDRL", "ซิฟิลิส (VDRL)", "VDRL", "text"],
  ["TSH", "ฮอร์โมนไทรอยด์ (TSH)", "TSH", "number"], ["FT3", "Free T3", "Free T3", "number"], ["FT4", "Free T4", "Free T4", "number"], ["CORTISOL", "คอร์ติซอล", "Cortisol", "number"],
  ["AFP", "สารบ่งชี้มะเร็งตับ (AFP)", "AFP", "number"], ["CEA", "สารบ่งชี้มะเร็งลำไส้ใหญ่ (CEA)", "CEA", "number"], ["PSA", "สารบ่งชี้มะเร็งต่อมลูกหมาก (PSA)", "PSA", "number"],
  ["CA125", "สารบ่งชี้มะเร็งรังไข่ (CA125)", "CA125", "number"], ["CA153", "สารบ่งชี้มะเร็งเต้านม (CA153)", "CA153", "number"], ["CA199", "สารบ่งชี้มะเร็งตับอ่อน (CA199)", "CA199", "number"],
  ["STOOLEXAM", "ตรวจอุจจาระทั่วไป", "Stool examination", "panel"], ["FOB", "เลือดแฝงในอุจจาระ", "Fecal occult blood", "text"],
  ["PAP", "มะเร็งปากมดลูก (Liquid-based)", "Cervical cytology (Liquid-based)", "text"], ["HPV", "HPV DNA", "HPV DNA with genotyping", "text"],
  ["ECG", "คลื่นไฟฟ้าหัวใจ", "Electrocardiogram (ECG)", "text"], ["AMPH", "สารเสพติดในปัสสาวะ", "Urine amphetamine", "text"]
];
