# โครงการ Mounjaro Employee Wellness — Integration Plan

> **เฟส 1 (Discovery) — เอกสารวางสถาปัตยกรรม** · ยังไม่เขียนโค้ดจริง
> รอเจ้าของตอบ "ผ่าน" ก่อนเริ่มเฟส 2

---

## 0. สรุปผู้บริหาร (อ่านก่อน)

โครงการนี้เก็บ **clinical data + sensitive personal data (PDPA)** ฝังในพอร์ทัล
สิ่งที่ต้องตัดสินใจก่อนลงมือ คือ **ช่องว่างทางสถาปัตยกรรม 1 จุดใหญ่:**

> สเปกเขียนสำหรับ **Supabase/Postgres** (Row-Level Security ที่ระดับ DB,
> `jsonb`, edge functions) — แต่ระบบจริงคือ **SQLite (better-sqlite3)**
> ซึ่ง **ไม่มี RLS ที่ระดับ DB เลย** (ไม่มี per-connection identity, ไม่มี
> `CREATE POLICY`, ไม่มี `auth.uid()`).

ดังนั้น "RLS ที่ database level" ตามตัวอักษร **เป็นไปไม่ได้บน SQLite** จำเป็นต้อง
เลือก 1 ใน 2 ทาง (ดู §3 + คำถาม Q1) — เรื่องนี้ต้องเคลียร์ก่อนเฟส 2

ส่วนที่เหลือ (schema, UI 4 บทบาท, safety alerts, consent, audit, LINE)
ทำได้ครบตามสเปก บนรากฐานที่มีอยู่แล้ว

---

## 1. Discovery — สิ่งที่พบในระบบจริง

### 1.1 Tech stack
| ด้าน | ของจริง |
|---|---|
| Framework | **Next.js 14.2** (App Router) |
| ภาษา | **TypeScript 5.6** (strict), React 18 |
| Build/run | `next build` → **PM2** (`reserva`) บน VPS, Nginx proxy :3010 |
| Validation | **zod** |
| Styling | **Tailwind 3.4** + custom utility classes |
| Runtime scripts | `tsx` (เช่น check-i18n, cron) |

### 1.2 Database — **SQLite ผ่าน better-sqlite3 (ไม่ใช่ Postgres/Supabase)**
- ไฟล์เดียว: `/var/www/reserva/data/reserva.db` (โหมด synchronous, in-process)
- Schema สร้าง/ปรับใน `src/lib/db.ts` → `runMigrations()` **รันตอน boot**
  แบบ **idempotent** (PRAGMA-guarded `ALTER TABLE ADD COLUMN`, ตารางสร้างด้วย
  `CREATE TABLE IF NOT EXISTS`) — **ไม่มี migration framework / ไม่มีไฟล์
  migration แยก / ไม่มี down-migration อัตโนมัติ**
- **ไม่มี `jsonb`** → เก็บ JSON เป็นคอลัมน์ `TEXT` (โค้ดเดิมทำแบบนี้แล้ว เช่น
  `health_checkups.items_json`, `recruita_candidates.education_json`)
- **ไม่มี RLS, ไม่มี views ที่กรองตาม identity, ไม่มี edge functions/triggers
  ที่ผูกกับ auth** (SQLite มี trigger แต่ไม่รู้ว่า "ใคร" กำลัง query)

### 1.3 Authentication
- Cookie session ชื่อ `reserva_session` → ตาราง `sessions` (id, user_id,
  active_branch_id, expires_at) JOIN `users`
- `getSessionUser()` (src/lib/auth.ts) = ground truth ของ "ใคร login + สาขาไหน
  + สิทธิ์อะไร" เรียกทุก request ฝั่ง server
- **PIN** (bcrypt, `users.pin_hash`) สำหรับ action ที่ต้องพิสูจน์ตัวตนซ้ำ
  (`verifyAdminPin`) — เหมาะกับ "เปิดดู clinical data"
- Account state gate: resigned/disabled/pending_invite ถูกบล็อกที่ getSessionUser

### 1.4 Role / permission system ที่มีอยู่
- `users.role` = **`super_admin` | `admin` | `staff`** เท่านั้น
  (**ไม่มี `clinical_staff` / `hr_admin`**)
- per-branch admin: `user_branches.is_admin = 1`
- **Capability flag pattern ที่มีแล้ว:** `users.can_view_payroll` (0/1, super_admin
  เป็นคนให้สิทธิ์) → ใช้ gate หน้า payroll + ซ่อนเมนู + กรอง field. **นี่คือแม่แบบที่
  เหมาะกับ "clinical staff" และ "HR analytics"**
- helpers: `requireUser / requireAdmin / requireSuperAdmin / requirePayrollAccess`,
  `userCanViewPayroll`, `isSuperAdmin`, `isAdminOrAbove`

### 1.5 Menu / routing
- 2 layout หลัก: `src/app/staff/layout.tsx` (พนักงาน) + `src/app/admin/layout.tsx`
  (คอนโซลผู้ดูแล) — sidebar เป็น `SidebarSection[]` (กรอง item ตาม role/flag
  ได้ในตัว เช่น payroll link โผล่เฉพาะคนมีสิทธิ์)
- ปุ่มสลับ "มุมมองพนักงาน / มุมมองผู้ดูแลระบบ" (AdminModeToggle)
- โมดูลเดิม: PERSONA, RESERVA, INVENTA, RECRUITA, ASCENDA, INSIGNA
- **ผลตรวจสุขภาพเดิมอยู่ที่ `/admin/persona/health`** (ตาราง `health_checkups`)
- พอร์ทัลพนักงานหน้าแรก `/staff` (module picker) — ที่วาง banner ชวนเข้าโครงการได้

### 1.6 Design system / UI
- Tailwind + คลาส: `.card .btn-primary .btn-secondary .input .label`
  + brand color (คาราเมล `#a06820`), ink-gradient (เอสเพรสโซ)
- Components: `PinPromptModal`, `ConfirmModal`, `OwlMascot`, `LangToggle`,
  `Sidebar`, `RefreshButton`, ฯลฯ (src/app/components)
- i18n: `src/lib/i18n.ts` + `useLang()/t()` (มีสคริปต์ check-i18n บังคับ th/en parity)
- ภาษาไทยทางการ (ทั้งระบบเลิกใช้ emoji/คำแสลงแล้ว)

### 1.7 LINE OA integration — **มีแล้ว ใช้ได้**
- `src/lib/line.ts` (Flex cards), `messaging-channels.ts` (platform OA = "IKIGAI OS"
  / น้องฮูก, + per-branch OA), `notifyToStaffGroup`, push ราย user ผ่าน
  `users.line_user_id`
- LIFF: portal / invite / recruita (auto-login + ผูก userId)
- มีแม่แบบการ์ดแจ้งเตือน + ระบบโควต้า push → **เฟส 5 (reminder ฉีดยา/นัด/self-log)
  ทำได้จริง**

### 1.8 Audit & PDPA patterns ที่มีแล้ว
- `logPersonaAction(userId, action, refId)` → `persona_activity_log`
- `payroll_line_audit` (before/after JSON snapshot) — แม่แบบ audit เชิงลึก
- RECRUITA: consent capture (consent_at/ip/user_agent), PDPA policy text/image,
  retention cron (ลบอัตโนมัติ 30 วัน) — แม่แบบ consent + retention ครบ

### 1.9 Testing — **ไม่มี test framework**
- ไม่มี jest/vitest. "เทส" ปัจจุบัน = สคริปต์ `tsx` (check-i18n, scan-build-risks)
  รันผ่าน `node --import tsx scripts/x.ts`
- → "Unit tests สำหรับ RLS + alert logic" จะทำเป็น **สคริปต์ tsx** ที่ seed DB
  ชั่วคราว + ยืนยัน access-control + alert ทีละ rule (เพิ่ม `npm run test:mounjaro`)

---

## 2. ช่องว่างสเปก ↔ ระบบจริง (ต้องตัดสินใจ)

| สเปกเขียนไว้ | ระบบจริง | ทางแก้ที่เสนอ |
|---|---|---|
| RLS ที่ DB level | SQLite ไม่มี RLS | **App-layer enforcement** (ดู §3) + เทสพิสูจน์ |
| `jsonb` | ไม่มี | คอลัมน์ `TEXT` เก็บ JSON (โค้ดเดิมทำอยู่) |
| edge function คำนวณ alert | ไม่มี | คำนวณใน **API route / server module** (server-side) |
| migration file rollback ได้ | migration in-code idempotent | ทำตาม convention เดิม + แนบ **rollback SQL** ต่อการเปลี่ยนใน `docs/` |
| role `clinical_staff` / `hr_admin` | มีแค่ 3 role | **capability flags** บน users (แม่แบบ can_view_payroll) |
| view `program_stats` (HR) | SQLite ไม่มี RLS บน view | สร้าง view ได้ แต่ "กัน HR ไม่ให้เห็นตารางคนไข้" ทำที่ app-layer ไม่ใช่ DB |

---

## 3. โมเดลความปลอดภัย (RLS-equivalent บน SQLite)

เนื่องจาก DB กั้นรายแถวไม่ได้ → กั้นที่ **application data-access layer** ชั้นเดียว
ที่ทุก query ของ Mounjaro ต้องผ่าน (ห้ามมี query ตรงนอกชั้นนี้):

**`src/lib/mounjaro-db.ts`** — gateway เดียวสำหรับ clinical data ทุกตัว
- ทุกฟังก์ชันรับ `actor: SessionUser` เป็น argument แรก (บังคับ) และ **scope
  query ตาม actor เสมอ**:
  - **Employee** → ทุก query เติม `WHERE enrollment.employee_id = actor.id`
    (join ผ่าน enrollment_id เสมอ — คนไข้เห็นเฉพาะของตัวเอง)
  - **Clinical staff** (`is_clinical_staff=1`) → เห็นทุกคนในโครงการ (R/W)
  - **HR** (`is_hr_analytics=1`) → เรียกได้เฉพาะฟังก์ชัน `getProgramStats()`
    (อ่าน aggregate) — **ไม่มีฟังก์ชันใดใน gateway คืนแถวคนไข้ให้ HR เลย**
- ทุกฟังก์ชันอ่าน/เขียน clinical → เรียก `logMounjaroAccess()` อัตโนมัติ (audit)
- การเข้าถึง clinical detail ของ clinical staff → ต้องผ่าน PIN (re-prove presence)

**การพิสูจน์ (เฟส 2):** สคริปต์เทส seed ผู้ใช้ A/B (employee), clinical, HR แล้ว
ยืนยัน:
- `getMyPatientRecord(employeeB_actor)` เมื่อยิงด้วย employeeA → **คืน null/throw**
- ทุกฟังก์ชัน gateway เมื่อ actor เป็น HR → **คืน 0 แถวคนไข้ / throw forbidden**
- เรียก clinical table ตรง ๆ นอก gateway → ไม่มี (เทส grep + code review)

> **หมายเหตุสำคัญต่อ acceptance criteria:** ข้อ "HR query mounjaro_patients → 0
> rows ที่ DB" บน SQLite **ทำตามตัวอักษรไม่ได้** (ใครถือ connection ก็ query ได้
> ทุกแถว) สิ่งที่รับประกันแทนคือ *"ไม่มี code path ใดเปิดเผยแถวคนไข้ให้ HR — บังคับ
> ด้วย gateway ชั้นเดียว + เทสอัตโนมัติ + audit"*. ถ้าต้องการ RLS ที่ DB จริง ๆ
> ต้องย้าย clinical data ไป Postgres/Supabase แยก (งานใหญ่กว่ามาก + เพิ่ม infra)
> → **คำถาม Q1**

---

## 4. "สุขภาพพนักงาน" — โครงสร้างเมนูใหม่

สร้างกลุ่มเมนูใหม่ **"สุขภาพพนักงาน"** แล้วย้าย/รวมของที่เกี่ยวข้อง:

```
สุขภาพพนักงาน  (ฝั่งผู้ดูแล /admin)
├── ผลตรวจสุขภาพ            ← ย้ายจาก /admin/persona/health (health_checkups เดิม)
└── โครงการ Mounjaro        ← ใหม่ (clinical staff: /admin/mounjaro,
                               HR: /admin/mounjaro-hr)

สุขภาพของฉัน  (ฝั่งพนักงาน /staff)   ← โผล่เฉพาะคนที่มี enrollment
└── โครงการ Mounjaro        ← /staff/health/mounjaro (self-service)
```

- ฝั่ง admin: เพิ่ม section "สุขภาพพนักงาน" ใน `admin/layout.tsx`; ผลตรวจสุขภาพเดิม
  ย้าย route `/admin/persona/health` → `/admin/health/checkups` (หรือคง path เดิม
  แต่ย้ายตำแหน่งในเมนู — ดู Q7)
- ฝั่ง staff: เพิ่ม section ใน `staff/layout.tsx` ที่ render **เฉพาะเมื่อ user มี
  enrollment record** (เงื่อนไข privacy ข้อ 1: ไม่มี enrollment = ไม่เห็นเมนูเลย)

---

## 5. Database schema (แปลงเป็น SQLite)

ทุกตารางสร้างใน `db.ts runMigrations()` (idempotent). JSON = TEXT. วันเวลา = TEXT ISO.

```
mounjaro_enrollments
  id INTEGER PK
  employee_id INTEGER NOT NULL REFERENCES users(id)
  status TEXT NOT NULL DEFAULT 'pending'
     CHECK (status IN ('pending','active','withdrawn','completed'))
  enrolled_at TEXT, completed_at TEXT
  consent_signed_at TEXT, consent_version TEXT
  withdrawn_reason TEXT
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
  UNIQUE(employee_id)            -- หนึ่งคนหนึ่ง enrollment ที่ active

mounjaro_patients               -- clinical record (สร้างเมื่อแพทย์รับเข้า)
  id INTEGER PK
  enrollment_id INTEGER NOT NULL UNIQUE REFERENCES mounjaro_enrollments(id)
  hn TEXT
  baseline_json TEXT             -- {weight,height,hr,bp,hba1c,fbs,waist,target}
  comorbidities_json TEXT        -- {dm,htn,dlp,cvd,ckd,panc,gb}
  contraindications_json TEXT    -- {mtc,men2,preg,allergy}
  medications_json TEXT          -- {insulin,su,met,sglt2,ocp}
  notes TEXT, start_date TEXT
  created_by INTEGER REFERENCES users(id), updated_at TEXT
  deleted_at TEXT                -- soft delete (PDPA + medical retention)

mounjaro_visits
  id INTEGER PK
  patient_id INTEGER NOT NULL REFERENCES mounjaro_patients(id)
  date TEXT, dose REAL CHECK (dose IN (2.5,5,7.5,10,12.5,15))
  weight REAL, bp TEXT, hr INTEGER, hba1c REAL, fbs REAL, waist REAL
  side_effects_json TEXT         -- {nausea,vomit,diarrhea,const,abdomen,tachy,fatigue,inject} 0-3
  hypo_count INTEGER
  adherence TEXT CHECK (adherence IN ('full','missed1','missed2','held'))
  decision TEXT CHECK (decision IN ('maintain','increase','decrease','hold'))
  next_visit TEXT, notes TEXT
  entered_by INTEGER REFERENCES users(id)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP

mounjaro_self_logs              -- พนักงาน log เอง
  id INTEGER PK
  enrollment_id INTEGER NOT NULL REFERENCES mounjaro_enrollments(id)
  date TEXT, weight REAL, injection_done INTEGER   -- 0/1
  side_effect_diary_json TEXT, notes_for_doctor TEXT
  doctor_reply TEXT, replied_by INTEGER, replied_at TEXT
  logged_by INTEGER REFERENCES users(id)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP

mounjaro_audit_log
  id INTEGER PK
  user_id INTEGER, action TEXT, resource_type TEXT, resource_id INTEGER
  ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP

mounjaro_consent_versions       -- ข้อความ consent + เวอร์ชัน (super_admin ดูแล)
  id INTEGER PK, version TEXT UNIQUE, body TEXT, active INTEGER, created_at TEXT
```

**HR view (aggregate-only):**
```
CREATE VIEW mounjaro_program_stats AS
  SELECT COUNT(*) total, ... retention, avg weight-loss %, dropout rate ...
  FROM mounjaro_enrollments LEFT JOIN ...     -- ไม่มีคอลัมน์ระบุตัวบุคคล
```
(การกัน HR เข้าถึงตารางคนไข้ = ที่ gateway/route ไม่ใช่ที่ view — ดู §3)

**rollback:** แต่ละการเปลี่ยน schema จะมีไฟล์ `docs/migrations/mounjaro-NN-rollback.sql`
(`DROP TABLE ... / ALTER ... DROP COLUMN` ตามลำดับย้อน) ให้รันมือได้

---

## 6. Role / permission matrix (ของจริง)

เพิ่ม capability flags บน `users` (super_admin ให้สิทธิ์ — แม่แบบ can_view_payroll):
- `is_clinical_staff INTEGER DEFAULT 0` — แพทย์/พยาบาลคลินิก
- `is_hr_analytics INTEGER DEFAULT 0` — HR (เห็น aggregate เท่านั้น)

| ตาราง | Employee (enrolled) | Clinical staff | HR analytics | super_admin |
|---|---|---|---|---|
| enrollments | ของตัวเอง | ทั้งหมด | ผ่าน view (นับ) | ทั้งหมด* |
| patients | ของตัวเอง (R) | ทั้งหมด (R/W) | **ไม่มีสิทธิ์** | * |
| visits | ของตัวเอง (R) | ทั้งหมด (R/W) | **ไม่มีสิทธิ์** | * |
| self_logs | ของตัวเอง (R/W) | ทั้งหมด (R) | **ไม่มีสิทธิ์** | * |
| audit_log | ของตัวเอง | ของตัวเอง | ทั้งหมด | ทั้งหมด |
| program_stats | ไม่ | ใช่ | ใช่ | ใช่ |

\* **คำถาม Q1/Q3:** super_admin (เจ้าของ) ควรเห็น clinical data ดิบไหม? โดยหลัก
PDPA/อาชีวเวชศาสตร์ "เจ้าของกิจการ ≠ ผู้มีสิทธิ์เข้าถึงเวชระเบียน" → เสนอให้
super_admin **เห็นได้เฉพาะ aggregate เหมือน HR** (ไม่เห็น raw clinical) เว้นแต่
super_admin คนนั้นถูกตั้ง `is_clinical_staff=1` ด้วย

---

## 7. Routes + component tree ที่จะสร้าง

```
ฝั่งพนักงาน (self-service, gated: ต้องมี enrollment)
  /staff/health/mounjaro                 page + MounjaroSelfClient
     states: NO_ENROLLMENT(ผ่าน banner) / PENDING / ACTIVE / WITHDRAWN|COMPLETED

ฝั่ง clinical staff (gated: is_clinical_staff)
  /admin/mounjaro                        รายชื่อผู้ป่วย + filter
  /admin/mounjaro/[patientId]            รายละเอียด (tabs: baseline / titration /
                                         visits / safety alerts / progress / self-logs)

ฝั่ง HR (gated: is_hr_analytics)
  /admin/mounjaro-hr                     aggregate dashboard + export CSV

API routes (server-side, ผ่าน mounjaro-db gateway + audit)
  /api/mounjaro/enroll            POST  พนักงานกดสนใจ (สร้าง pending) + แจ้งคลินิก
  /api/mounjaro/self-log          POST  พนักงาน log
  /api/mounjaro/export            GET   export ข้อมูลตัวเอง (PDPA)
  /api/mounjaro/erase             POST  ขอลบ (soft delete + audit)
  /api/mounjaro/consent           POST  บันทึก consent
  /admin/api/mounjaro/patients/[id]/baseline   POST clinical สร้าง patient
  /admin/api/mounjaro/patients/[id]/visit      POST clinical บันทึกนัด
  /admin/api/mounjaro/self-logs/[id]/reply     POST clinical ตอบ self-log

lib
  src/lib/mounjaro-db.ts          gateway (access-control + audit) — ชั้นเดียว
  src/lib/mounjaro-alerts.ts      safety-alert rules (server-side, pure functions)
  src/lib/mounjaro-consent.ts     consent version helpers
  scripts/test-mounjaro.ts        เทส access-control + alert logic
```

---

## 8. รายการไฟล์ที่จะสร้าง/แก้ (ภาพรวม)

**สร้างใหม่:** mounjaro-db.ts, mounjaro-alerts.ts, mounjaro-consent.ts,
ทุก route/หน้าใน §7, scripts/test-mounjaro.ts, docs/migrations/*.sql
**แก้ไข:** `db.ts` (ตาราง + flags + view), `auth.ts` (helper:
`userIsClinicalStaff`, `userIsHrAnalytics`, `requireClinicalStaff`,
`getMyEnrollment`), `staff/layout.tsx` + `admin/layout.tsx` (เมนู "สุขภาพพนักงาน"
แบบมีเงื่อนไข), `i18n.ts` (คีย์ใหม่ th/en), `/staff` home (banner ชวนเข้าร่วม)

---

## 9. Safety alert rules (เฟส 4 — ย้ำว่าคำนวณ server-side)

DANGER: HR↑>15bpm→EKG · ปวดท้อง≥2→pancreatitis · ติ๊ก contraindication→ห้ามใช้ยา
WARNING: HR↑10-15→เฝ้าระวัง · อาเจียน≥2→dehydration · ใจสั่น≥2→arrhythmia/EKG ·
hypo≥1 ขณะใช้ insulin/su→ลด · adherence missed2/held→สอบถาม · maintain+dose<15+>8wk
เดิม→titrate up · dose≥10+visit≥3+น้ำหนักลด<5%→ประเมินสาเหตุ
→ implement เป็น pure functions ใน `mounjaro-alerts.ts` + เทสทีละ rule

---

## 10. PDPA / consent / audit / สิทธิเจ้าของข้อมูล

- **Consent**: popup ตอนเข้าครั้งแรก, เก็บ version+signed_at, version เปลี่ยน→re-consent
- **Audit**: ทุกอ่าน/เขียน clinical ผ่าน gateway → `mounjaro_audit_log` + หน้าให้
  พนักงานดู "ใครเข้าดูข้อมูลฉันบ้าง"
- **Right to access**: export JSON (เฟส 3) / PDF (ถ้าทำได้ในเวลา)
- **Right to erasure ⚠️ ขัดกับกฎหมายเก็บเวชระเบียน**: เวชระเบียนมีอายุการเก็บตาม
  กฎหมาย (ไทย ~5 ปีหลังผู้ป่วยรายสุดท้ายมารับบริการ) → PDPA ลบทันทีไม่ได้ทั้งหมด
  เสนอ: **soft delete** (ซ่อนจากผู้ใช้/พนักงาน + ตัด self-service) + เก็บแกนเวชระเบียน
  ภายใต้ lawful basis + audit, พร้อมแจ้งผู้ใช้ถึงข้อจำกัด → **คำถาม Q5**

---

## 11. LINE (เฟส 5 — มี SDK แล้ว ทำได้)
reminder ฉีดยา/นัด(3วันก่อน)/กรอก self-log + แจ้งเมื่อแพทย์ตอบ → push ราย user ผ่าน
`line_user_id` + แม่แบบการ์ดเดิม (เคารพระบบโควต้า push)

---

## 12. แผนเฟส (ปรับให้ตรงระบบจริง)
- **เฟส 2**: db.ts (ตาราง+flags+view) + mounjaro-db gateway + scripts/test-mounjaro
  + rollback SQL → พิสูจน์ access-control ก่อน UI
- **เฟส 3**: self-service UI (/staff/health/mounjaro) + เมนูเงื่อนไข + enroll/self-log/export
- **เฟส 4**: clinical dashboard + alerts
- **เฟส 5**: HR aggregate + consent + audit viewer + LINE

---

## 13. ❓ คำถามที่ต้องตอบก่อนเริ่มเฟส 2

**Q1 (สำคัญสุด) — RLS:** ยอมรับ "RLS-equivalent ที่ app-layer บน SQLite" (gateway
ชั้นเดียว + เทส + audit) ตาม §3 ไหม? หรือยืนยันต้อง RLS ที่ DB จริง (ต้องย้าย
clinical data ไป Postgres/Supabase แยก = โปรเจกต์ใหญ่กว่ามาก + infra ใหม่)?

**Q2 — บทบาทคลินิก:** แพทย์/พยาบาลที่จะเห็นข้อมูลคนไข้ เป็น user ในระบบนี้อยู่แล้ว
ไหม? ใครบ้าง (กี่คน)? ตั้งเป็น `is_clinical_staff` ให้ใคร?

**Q3 — super_admin เห็น clinical ดิบไหม?** เสนอ "ไม่เห็น (เห็นแค่ aggregate)" เว้นแต่
ถูกตั้ง is_clinical_staff — โอเคไหม?

**Q4 — HR คือใคร:** บัญชีไหนเป็น `is_hr_analytics`?

**Q5 — สิทธิลบข้อมูล vs เก็บเวชระเบียน:** ใช้ soft-delete + แจ้งข้อจำกัดตามกฎหมาย
เวชระเบียน (ตาม §10) ได้ไหม?

**Q6 — HN:** เลข HN มาจากระบบคลินิก IKIGAI MediHealth เดิม หรือให้ clinical staff
กรอกเองในพอร์ทัล?

**Q7 — เมนู "สุขภาพพนักงาน":** ย้าย "ผลตรวจสุขภาพ" (health_checkups) เดิมจาก
PERSONA มาอยู่ใต้กลุ่มใหม่นี้เลยไหม? ย้าย route ด้วย (`/admin/persona/health` →
`/admin/health/...`) หรือคงเดิมแค่จัดกลุ่มเมนู?

**Q8 — ใครเข้าร่วมได้:** พนักงานทุกสาขา หรือเฉพาะบางกลุ่ม/สาขา?

**Q9 — consent text:** ใครเป็นคนเขียน/ดูแลข้อความ consent + เวอร์ชัน (super_admin
ในหน้า system-settings เหมือน PDPA RECRUITA ไหม)?

**Q10 — Data isolation ระดับไฟล์:** ต้องการแยก clinical data ไป SQLite ไฟล์/
encrypt ต่างหากจาก reserva.db ไหม (เพิ่มความปลอดภัยเชิงกายภาพ) หรือใช้ DB เดียวกัน?

---

*จบเฟส 1 — รอเจ้าของตอบ "ผ่าน" + คำตอบ Q1-Q10 ก่อนเริ่มเฟส 2*
