# ตารางค่าอ้างอิง — เล่มผลตรวจสุขภาพ (สร้างอัตโนมัติจาก `src/lib/health-report/catalog.ts`)

ค่าทั้งหมดคัดจากเล่มต้นแบบ `docs/design/health-report-template.pdf` · **รายการที่มีเครื่องหมาย ⚠ คือที่ผมอ่านจากต้นแบบแล้วไม่แน่ใจ ขอให้แพทย์ยืนยัน** ·
คอลัมน์ "ช่วงที่ยอมรับได้" คือช่วงที่เป็นไปได้ของคนจริง ใช้ถามยืนยันตอนกรอก (เช่น น้ำตาล 1590 จะถามก่อนบันทึก) ไม่ใช่ค่าอ้างอิงทางการแพทย์

## ข้อมูลส่วนบุคคลและตรวจร่างกาย · General information and physical examination

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| WEIGHT | Weight | กก. | — | 2 – 400 |  |
| HEIGHT | Height | ซม. | — | 40 – 250 |  |
| BMI | Body Mass Index : BMI | กก./ตร.ม. | — | 8 – 90 | คำนวณอัตโนมัติ (bmi) |
| BP_SYS | Blood pressure (systolic) | mmHg | — | 50 – 300 |  |
| BP_DIA | Blood pressure (diastolic) | mmHg | — | 20 – 200 |  |
| PULSE | Pulse | ครั้งต่อนาที | — | 20 – 250 |  |
| BLOOD_GROUP | ABO/Rh Group |  | ปกติ = แสดงผลอย่างเดียว |  |  |
| SMOKING | History of smoking |  | ปกติ = แสดงผลอย่างเดียว |  |  |
| ALCOHOL | History of alcohol drinking |  | ปกติ = แสดงผลอย่างเดียว |  |  |
| ALLERGY | History of food / drug allergy |  | ปกติ = แสดงผลอย่างเดียว |  |  |
| UNDERLYING | History of underlying disease |  | — |  |  |
| EX_HEAD | Head |  | Normal (ปกติ) |  |  |
| EX_ENT | Ear Nose Throat |  | Normal (ปกติ) |  |  |
| EX_ORAL | Oral cavity and teeth |  | Normal (ปกติ) |  |  |
| EX_CHEST | Chest |  | Normal (ปกติ) |  |  |
| EX_HEART | Heart |  | Normal (ปกติ) |  |  |
| EX_ABDOMEN | Abdomen |  | Normal (ปกติ) |  |  |
| EX_MSK | Musculoskeletal |  | Normal (ปกติ) |  |  |
| EX_NERVOUS | Nervous system |  | Normal (ปกติ) |  |  |
| EX_SKIN | Skin |  | Normal (ปกติ) |  |  |
| EX_LYMPH | Lymph nodes |  | Normal (ปกติ) |  |  |

## ผลการตรวจความสมบูรณ์ของเม็ดเลือด · Complete blood count : CBC

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| WBC | WBC Count | x 10³ cell/mm³ | 4.5 – 11 | 0.1 – 500 |  |
| NEUT | Neutrophil | % | 40 – 80 | 0 – 100 |  |
| LYMPH | Lymphocyte | % | 20 – 40 | 0 – 100 |  |
| MONO | Monocyte | % | 2 – 10 | 0 – 100 |  |
| EOS | Eosinophil | % | 1 – 6 | 0 – 100 |  |
| BASO | Basophil | % | 0 – 2 | 0 – 100 | ⚠ ขอให้แพทย์ยืนยัน |
| RBC | RBC Count | x 10⁶ cell/µL | Male : 4.5 – 5.9<br>Female : 4.5 – 5.1 | 0.5 – 12 |  |
| HB | Hb (Hemoglobin) | g/dL | Male : 13.5 – 17.5<br>Female : 12 – 15.5 | 2 – 25 |  |
| HCT | Hct (Hematocrit) | % | Male : 38.8 – 50<br>Female : 34.9 – 44.5 | 8 – 75 |  |
| MCV | MCV | fL | 80 – 96 | 40 – 150 |  |
| MCH | MCH | pg | 27.5 – 33.2 | 10 – 60 |  |
| MCHC | MCHC | g/dL | 33.4 – 35.5 | 20 – 45 |  |
| RDW | RDW | % | 11.6 – 14.6 | 5 – 40 |  |
| PLT | Platelet count | x 10³ cell/mm³ | 150 – 450 | 1 – 2000 |  |
| RBC_MORPH | RBC Morphology |  | ปกติ = Normal |  |  |
| ESR | ESR | mm/hr | Age < 50 · Male : < 15<br>Age < 50 · Female : < 20<br>Age ≥ 50 · Male : < 20<br>Age ≥ 50 · Female : < 30 | 0 – 150 | ⚠ ขอให้แพทย์ยืนยัน |

## ผลการตรวจความสมบูรณ์ของปัสสาวะ · Urine analysis : UA

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| UA_COLOR | Color |  | Yellow |  |  |
| UA_APPEAR | Appearance |  | Clear |  |  |
| UA_SG | Specific gravity |  | 1.003 – 1.035 | 1 – 1.06 |  |
| UA_PH | pH |  | 4.5 – 8 | 3 – 10 |  |
| UA_URO | Urobilinogen |  | ปกติ = Normal |  |  |
| UA_BIL | Bilirubin |  | ปกติ = Negative |  |  |
| UA_NIT | Nitrite |  | ปกติ = Negative |  |  |
| UA_LE | Leukocyte esterase |  | ปกติ = Negative |  |  |
| UA_ERY | Erythrocyte |  | ปกติ = Negative |  |  |
| UA_PRO | Protein |  | ปกติ = Negative |  |  |
| UA_GLU | Glucose |  | ปกติ = Negative |  |  |
| UA_KET | Ketone |  | ปกติ = Negative |  |  |
| UA_RBC | Red blood cell | cells/HPF | 0 – 2 | 0 – 1000 |  |
| UA_WBC | White blood cell | cells/HPF | 0 – 5 | 0 – 1000 |  |
| UA_EPI | Epithelium cell | cells/HPF | 15 – 20 | 0 – 1000 | ⚠ ขอให้แพทย์ยืนยัน |
| UA_CAST | Cast |  | — |  | ⚠ ขอให้แพทย์ยืนยัน |
| UA_CRYSTAL | Crystal |  | — |  |  |
| UA_MUCOUS | Mucous |  | — |  |  |
| UA_BACT | Bacteria/Yeast/Parasite |  | Not found |  |  |

## ผลการตรวจทางชีวเคมีในเลือด · Blood chemistry examination

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| FBS | Fasting blood sugar | mg/dL | 70 – 99 | 20 – 800 |  |
| HBA1C | Hemoglobin A1C | % | 4 – 5.6 | 3 – 20 |  |
| CHOL | Total cholesterol | mg/dL | < 200 | 40 – 1000 |  |
| TG | Triglyceride | mg/dL | < 150 | 10 – 5000 |  |
| HDL | HDL-cholesterol | mg/dL | Male : ≥ 40<br>Female : ≥ 50 | 5 – 200 |  |
| LDL | LDL-cholesterol | mg/dL | < 100 | 10 – 700 |  |
| BUN | Blood urea nitrogen | mg/dL | 7 – 20 | 1 – 250 |  |
| CREAT | Creatinine | mg/dL | Male : 0.7 – 1.3<br>Female : 0.6 – 1.1 | 0.1 – 30 |  |
| EGFR | eGFR | mL/min/1.73 m² | ≥ 90 | 1 – 200 |  |
| URIC | Uric acid | mg/dL | Male : 3.4 – 7<br>Female : 2.4 – 6 | 0.5 – 25 |  |
| AST | AST/SGOT | U/L | 8 – 40 | 1 – 10000 |  |
| ALT | ALT/SGPT | U/L | 7 – 56 | 1 – 10000 |  |
| ALP | ALK/ALP | U/L | 40 – 130 | 5 – 3000 |  |
| TP | Total protein | g/dL | 6 – 8.3 | 2 – 15 |  |
| ALB | Albumin | g/dL | 3.5 – 5 | 0.5 – 8 |  |
| GLOB | Globulin | g/dL | 2 – 3.5 | 0.1 – 10 | คำนวณอัตโนมัติ (globulin) |
| TBIL | Total bilirubin | mg/dL | 0.1 – 1.2 | 0.05 – 50 |  |
| DBIL | Direct bilirubin | mg/dL | 0 – 0.3 | 0 – 40 |  |
| IBIL | Indirect bilirubin | mg/dL | 0.2 – 0.8 | 0 – 40 | คำนวณอัตโนมัติ (indirect_bili) |

## ตรวจสมรรถภาพการได้ยิน · Audiometry screening

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| AUD_R_500 | Frequency 500 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_1000 | Frequency 1,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_2000 | Frequency 2,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_3000 | Frequency 3,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_4000 | Frequency 4,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_6000 | Frequency 6,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_R_8000 | Frequency 8,000 Hertz (Hz) · Rt (หูขวา) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_500 | Frequency 500 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_1000 | Frequency 1,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_2000 | Frequency 2,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_3000 | Frequency 3,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_4000 | Frequency 4,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_6000 | Frequency 6,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |
| AUD_L_8000 | Frequency 8,000 Hertz (Hz) · Lt (หูซ้าย) | dB | ≤ 25 | -10 – 120 |  |

## ตรวจสายตาอาชีวอนามัย · Occupational health vision test

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| EYE_BINOC | Binocular vision |  | Normal (ปกติ) |  |  |
| EYE_FAR_BOTH | Far vision - Both |  | Normal (ปกติ) |  |  |
| EYE_FAR_R | Far vision - Right |  | Normal (ปกติ) |  |  |
| EYE_FAR_L | Far vision - Left |  | Normal (ปกติ) |  |  |
| EYE_STEREO | Stereo depth |  | Normal (ปกติ) |  |  |
| EYE_COLOR | Color discrimination |  | Normal (ปกติ) |  |  |
| EYE_FAR_VPH | Far vertical phoria |  | Normal (ปกติ) |  |  |
| EYE_FAR_LPH | Far lateral phoria |  | Normal (ปกติ) |  |  |
| EYE_NEAR_BOTH | Near vision - Both |  | Normal (ปกติ) |  |  |
| EYE_NEAR_R | Near vision - Right |  | Normal (ปกติ) |  |  |
| EYE_NEAR_L | Near vision - Left |  | Normal (ปกติ) |  |  |
| EYE_NEAR_LPH | Near lateral phoria |  | Normal (ปกติ) |  |  |
| EYE_VFIELD | Visual field |  | Normal (ปกติ) |  |  |

## ตรวจสมรรถภาพปอด · Pulmonary function test

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| FVC_MEAS | Forced Vital Capacity : FVC · Measure | L | — | 0.3 – 9 |  |
| FVC_PRED | Forced Vital Capacity : FVC · Predicted | L | — | 0.3 – 9 |  |
| FVC_PCT | Forced Vital Capacity : FVC · % Predicted | % | > 80 | 5 – 250 |  |
| FEV1_MEAS | Forced expiratory volume in 1 second : FEV1 · Measure | L | — | 0.2 – 8 |  |
| FEV1_PRED | Forced expiratory volume in 1 second : FEV1 · Predicted | L | — | 0.2 – 8 |  |
| FEV1_PCT | Forced expiratory volume in 1 second : FEV1 · % Predicted | % | > 80 | 5 – 250 |  |
| FEV1FVC_MEAS | Forced expiratory volume in 1 second / Forced vital capacity : FEV1/FVC · Measure | % | — | 20 – 100 |  |
| FEV1FVC_PRED | Forced expiratory volume in 1 second / Forced vital capacity : FEV1/FVC · Predicted | % | — | 20 – 100 |  |
| FEV1FVC_PCT | Forced expiratory volume in 1 second / Forced vital capacity : FEV1/FVC · % Predicted | % | — | 5 – 250 |  |
| FEF_MEAS | Forced expiratory flow at 25-75 % : FEF 25-75 · Measure | L | — | 0.1 – 10 |  |
| FEF_PRED | Forced expiratory flow at 25-75 % : FEF 25-75 · Predicted | L | — | 0.1 – 10 |  |
| FEF_PCT | Forced expiratory flow at 25-75 % : FEF 25-75 · % Predicted | % | — | 5 – 250 |  |

## ผลการตรวจทางรังสีวิทยา (เอกซเรย์ทรวงอก) · Radiologic examination (Chest x-ray)

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| CXR_RESULT | Chest x-ray |  | — |  |  |
| CXR_IMAGE | Chest x-ray image |  | — |  |  |

## ผลการตรวจคลื่นไฟฟ้าหัวใจ · Electrocardiogram (ECG)

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| ECG_RESULT | Electrocardiogram |  | — |  |  |
| ECG_IMAGE | Electrocardiogram graph |  | — |  |  |

## รายการตรวจทางห้องปฏิบัติการอื่นๆ · Other laboratory examination

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| HAV_IGM | Anti-HAV (IgM) |  | Positive : ท่านกำลังติดเชื้อ ระยะเฉียบพลัน<br>Negative : ไม่พบการติดเชื้อใหม่ |  | ⚠ ขอให้แพทย์ยืนยัน |
| HAV_IGG | Anti-HAV (IgG) |  | Positive : พบภูมิคุ้มกันจากการหายจากการติดเชื้อ หรือได้รับวัคซีน<br>Negative : ไม่พบภูมิคุ้มกัน |  | ⚠ ขอให้แพทย์ยืนยัน |
| HAV_TOTAL | Anti-HAV (IgM+IgG)(Total) |  | Positive : พบภูมิคุ้มกันหรือเคยติดเชื้อ<br>Negative : ไม่พบภูมิคุ้มกันและไม่เคยติดเชื้อ |  | ⚠ ขอให้แพทย์ยืนยัน |
| HBSAG | HBsAg |  | Positive : พบเชื้อไวรัสตับอักเสบบี<br>Negative : ไม่พบเชื้อไวรัสตับอักเสบบี |  | ⚠ ขอให้แพทย์ยืนยัน |
| ANTI_HBS | Anti-HBs |  | Positive : พบภูมิคุ้มกัน หรือรับวัคซีนแล้ว<br>Negative : ไม่พบภูมิคุ้มกัน |  | ⚠ ขอให้แพทย์ยืนยัน |
| ANTI_HBC | Anti-HBc |  | Positive : เคยติดเชื้อมาก่อน<br>Negative : ไม่เคยติดเชื้อมาก่อน |  | ⚠ ขอให้แพทย์ยืนยัน |
| ANTI_HCV | Anti-HCV |  | Positive : พบการติดเชื้อหรือเคยติดเชื้อ<br>Negative : ไม่พบการติดเชื้อ |  | ⚠ ขอให้แพทย์ยืนยัน |
| ANTI_HIV | Anti-HIV |  | (รายงานผลตรวจ ออกให้ในเอกสารอีกฉบับ โดยได้รับความยินยอมจากผู้เข้ารับการตรวจแล้ว) |  | ไม่แสดงในเล่ม · เห็นเฉพาะแพทย์และเจ้าตัว |
| VDRL | VDRL |  | Negative |  |  |
| TSH | TSH : Thyroid-stimulating hormone | uIU/mL | 0.35 – 4.94 | 0.001 – 500 |  |
| FT3 | Free T3 : Free triiodothyronine | pg/mL | 1.58 – 3.91 | 0.1 – 50 |  |
| FT4 | Free T4 : Thyroxine | ng/dL | 0.7 – 1.48 | 0.05 – 20 |  |
| CORTISOL | Cortisol |  | 0 – 2 | 0 – 200 | ⚠ ขอให้แพทย์ยืนยัน |
| AFP | AFP : Alpha-fetoprotein | ng/mL | 0 – 10 | 0 – 100000 |  |
| CEA | CEA : Carcinoembryonic antigen | ng/mL | 0 – 5.8 | 0 – 100000 |  |
| PSA | PSA : Prostate-specific antigen | ng/mL | 0 – 4 | 0 – 100000 |  |
| CA125 | CA125 : Carbohydrate antigen 125 | ng/mL | 0 – 35 | 0 – 100000 | ⚠ ขอให้แพทย์ยืนยัน |
| CA153 | CA153 : Cancer antigen 153 | ng/mL | 0 – 25 | 0 – 100000 | ⚠ ขอให้แพทย์ยืนยัน |
| CA199 | CA199 : Carbohydrate antigen 199 | ng/mL | 0 – 27 | 0 – 100000 | ⚠ ขอให้แพทย์ยืนยัน |

## ตรวจอุจจาระ · Stool examination

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| ST_COLOR | Color |  | — |  |  |
| ST_APPEAR | Appearance |  | — |  |  |
| ST_WBC | WBC : Stool |  | Negative |  |  |
| ST_RBC | RBC : Stool |  | Negative |  |  |
| ST_PARASITE | Parasite : Stool |  | Not found |  |  |
| ST_FUNGUS | Fungus : Stool |  | No fungus seen |  |  |
| ST_FOB | Fecal occult blood |  | Negative |  |  |
| ST_CULTURE | Stool culture and sensitivity |  | No enteropathogenic bacteria seen<br>(Negative for Salmonella spp., Shigella spp., Aeromonas spp., Plesiomonas spp. and Vibrio spp.) |  |  |

## ตรวจคัดกรองมะเร็งปากมดลูก · Cervical cancer screening

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| PAP_LBC | Liquid-based preparation / SurePrep® |  | — |  |  |
| PAP_HPV | HPV DNA with Genotyping (High risk 14 subtypes) |  | — |  |  |

## ตรวจสารเสพติดในปัสสาวะ · Urine drug screen

| รหัส | รายการ | หน่วย | ค่าอ้างอิง | ช่วงที่ยอมรับได้ | หมายเหตุ |
|---|---|---|---|---|---|
| DRUG_AMPH | Urine amphetamine |  | Positive : พบสารเสพติดในปัสสาวะ<br>Negative : ไม่พบสารเสพติดในปัสสาวะ |  | เห็นเฉพาะแพทย์และเจ้าตัว |

## กติกาแปลผล (ใช้ตามที่เจ้าของระบบกำหนด)

- **การได้ยิน:** เกิน 25 เดซิเบลถือว่าลดลงที่ความถี่นั้น เขียนว่า "การได้ยินของหู[ขวา/ซ้าย]ลดลงที่ความถี่ …" ถ้าทั้ง 7 ความถี่เกิน 25 เขียน "ลดลงทุกความถี่" หูขวาและซ้ายอยู่บรรทัดเดียวคั่นด้วย ` / ` (ถ้าหูข้างใดปกติ ผมเขียนว่า "ปกติ" ในบรรทัดเดียวกัน — **คำนี้ผมเลือกเอง ขอให้ยืนยัน**)
- **ปอด:** FEV1/FVC ผิดปกติเมื่อ ≤ 75 ในอายุต่ำกว่า 50 ปี และ ≤ 70 ในอายุ 50 ปีขึ้นไป · FVC และ FEV1 ผิดปกติเมื่อ ≤ 80% ของค่าคาดคะเน · ไม่ใช้ FEF25-75 · ต่ำเฉพาะอัตราส่วน = กลุ่มก้ำกึ่ง · **การแบ่งเป็นแบบอุดกั้น/จำกัดการขยายตัว/ผสม เป็นการตีความของผมตามหน้าอธิบายในเล่ม ขอให้แพทย์ยืนยัน**
- **ค่าที่แจ้งเตือนแพทย์ทันที:** เอนไซม์ตับ (AST, ALT) เกิน 5 เท่าของค่าสูงสุดที่อ้างอิง (ตั้งค่าได้) · ค่าเริ่มต้นอื่นที่ผมใส่เอง **ขอให้แพทย์ยืนยัน:** น้ำตาล < 50 หรือ > 400, Hb < 7, เกล็ดเลือด < 20 หรือ > 1000, เม็ดเลือดขาว < 2 หรือ > 30
- **ดัชนีมวลกาย:** น้ำหนัก ÷ ส่วนสูง² ใช้เกณฑ์เอเชีย-แปซิฟิก (< 18.5 ต่ำกว่าเกณฑ์, 18.5–22.9 ปกติ, 23–24.9 น้ำหนักเกิน, 25–29.9 อ้วนระดับ 1, ≥ 30 อ้วนระดับ 2) **ขอให้แพทย์ยืนยัน**
- **ค่าที่คำนวณอัตโนมัติ:** Globulin = Total protein − Albumin · Indirect bilirubin = Total − Direct
