# RBAC — ระบบบทบาท/สิทธิ์ (แบบ empeo) — Integration Plan

> **เฟส 1 (Design) — ยังไม่แตะโค้ด** · รอเจ้าของตอบ "ผ่าน" ก่อนเริ่มเฟส 2
> เป้าหมาย: บทบาทกำหนดได้เอง + กำหนดว่าบทบาทไหนเข้าอะไรได้ + assign หลาย
> บทบาทต่อคน (รวมแพทย์/พยาบาล + เลขใบประกอบ, HR) — เลิกใช้เมนูแยก

---

## 0. หลักการสำคัญ (อ่านก่อน)

แก้ระบบสิทธิ์ = งานเสี่ยงสูง (พลาด = ล็อกคนออกทั้งร้าน) จึงยึด 3 ข้อ:

1. **Additive ก่อน ค่อยสลับ** — สร้างระบบ RBAC ขนานไปกับของเดิม, seed บทบาท
   ให้ "เหมือนเดิมเป๊ะ", backfill บทบาทให้ทุกคนจากสิทธิ์ปัจจุบัน → ของเดิมยัง
   ทำงาน 100% ระหว่างทาง → แล้วค่อยสลับ gate ทีละจุด
2. **super_admin = เทพเสมอ** — ข้ามทุก permission (กันล็อกตัวเอง)
3. **เทสทุกเฟส** — สคริปต์พิสูจน์ว่า "ไม่มีใครเสียสิทธิ์ที่เคยมี" + "บทบาทใหม่
   ได้สิทธิ์ตามที่ตั้ง" ก่อน deploy

---

## 1. ระบบสิทธิ์ปัจจุบัน (สิ่งที่ต้องห่อด้วย RBAC)

- `users.role` = `super_admin | admin | staff` (คงที่)
- `user_branches.is_admin` (admin รายสาขา)
- ธงสิทธิ์เสริมบน users: `can_view_payroll`, `clinical_role` (doctor/nurse),
  `license_no`, `is_hr_analytics`
- helper ที่ gate อยู่: `requireUser / requireAdmin / requireSuperAdmin /
  requirePayrollAccess / requireClinicalDoctor`, `userCanViewPayroll`,
  `isClinicalUnlocked` ฯลฯ
- จุดที่ถูก gate (ตัวอย่าง): /admin (requireAdmin), payroll (can_view_payroll),
  RECRUITA (requireAdmin), INVENTA settings (super_admin), system-settings/
  companies (super_admin), Mounjaro clinical (clinical_role=doctor) / HR
  (is_hr_analytics)

---

## 2. โมเดล RBAC ที่เสนอ

**Permission = code-defined** (แอปต้องรู้ว่าแต่ละ permission กั้นอะไร — เพิ่ม
permission ใหม่ต้องแก้โค้ด แต่ "บทบาท" สร้าง/แก้/ลบ + เลือก permission + assign
ได้อิสระจากหน้าเว็บ) — เหมือน empeo

### ตาราง (SQLite, idempotent)
```
rbac_roles            id, key(unique,nullable), name, description,
                      is_system (0/1 = บทบาทระบบ ลบไม่ได้), created_at
rbac_role_permissions role_id, permission_key            (PK ร่วม)
rbac_user_roles       user_id, role_id, license_no(nullable), assigned_by,
                      assigned_at  (PK ร่วม user_id+role_id)
```
> license_no ย้ายมาอยู่ที่ "การ assign บทบาทแพทย์/พยาบาลต่อคน" (เพราะใบประกอบ
> เป็นของบุคคล ผูกกับบทบาทคลินิกที่เขาถือ) — ไม่ใช่ property ของบทบาท

### Permission catalog (ชุดเริ่มต้น — ขยายได้ในโค้ด)
```
admin.console        เข้าคอนโซลผู้ดูแล (/admin)
persona.manage       จัดการ PERSONA (พนักงาน/กะ/ลา/รายงาน)
persona.payroll      ดู/จัดการเงินเดือน (= can_view_payroll เดิม)
reserva.manage       จัดการ RESERVA
inventa.manage       จัดการ INVENTA
inventa.settings     ตั้งค่า INVENTA
recruita.access      เข้าใช้ RECRUITA
mounjaro.clinical    เข้าดูข้อมูลคลินิก Mounjaro (ยังถูก scope รายคนไข้ + ปลดล็อก
                     ใบประกอบใน gateway เหมือนเดิม — permission นี้แค่ "ให้เข้าได้")
mounjaro.hr          ดูภาพรวม Mounjaro (= is_hr_analytics เดิม)
system.settings      ตั้งค่าระบบ/บริษัทในเครือ
rbac.manage          จัดการบทบาท + assign (super_admin)
```

### บทบาทระบบที่ seed (ลบไม่ได้ — สะท้อนของเดิม)
```
ผู้ดูแลระบบสาขา (admin)   → admin.console, persona.manage, reserva.manage,
                            inventa.manage, recruita.access
แพทย์ (doctor)            → mounjaro.clinical    (+ ต้องใส่ใบประกอบตอน assign)
พยาบาล (nurse)            → (ยังไม่ให้ clinical ในเฟสนี้ — บทบาทไว้ก่อน)
HR (วิเคราะห์)             → mounjaro.hr
ฝ่ายเงินเดือน             → persona.payroll
```
(super_admin ไม่ต้องมีบทบาท — เป็นเทพอยู่แล้ว)

### ฟังก์ชันกลาง
```
userPermissions(user): Set<string>   // union ของ permission จากทุกบทบาทของ user
userCan(user, key): boolean          // super_admin → true เสมอ
userIsDoctor(user): boolean          // มีบทบาทที่ให้ mounjaro.clinical + license
```
helper เดิม (requireAdmin ฯลฯ) จะถูกเขียนใหม่ให้เรียก userCan() ข้างใน → จุดที่
gate ทั้งหมดไม่ต้องแก้ logic เอง

---

## 3. กลยุทธ์ migration (กันพัง)

1. seed บทบาทระบบ + role_permissions ตาม §2
2. **backfill rbac_user_roles จากสถานะปัจจุบัน:**
   - role='admin' (มี is_admin สาขา) → ได้บทบาท "ผู้ดูแลระบบสาขา"
   - can_view_payroll=1 → +บทบาท "ฝ่ายเงินเดือน"
   - clinical_role='doctor' → +บทบาท "แพทย์" (ยก license_no เดิมมาใส่)
   - clinical_role='nurse' → +บทบาท "พยาบาล"
   - is_hr_analytics=1 → +บทบาท "HR"
3. เขียน requireAdmin/userCanViewPayroll/requireClinicalDoctor/ฯลฯ ใหม่ให้อ่าน
   จาก userCan() — ค่าเดิมทุกคนต้อง "เท่าเดิมเป๊ะ" (เทสยืนยัน)
4. คงคอลัมน์ธงเดิมไว้ก่อน (เผื่อ rollback) — เลิกใช้ภายหลังเมื่อมั่นใจ

---

## 4. UI

- **หน้า "บทบาทและสิทธิ์"** (ภายใต้ system-settings / super_admin เท่านั้น):
  - รายการบทบาท → สร้าง/แก้ชื่อ/เลือก permission (ติ๊กจาก catalog) · บทบาทระบบ
    แก้ permission ได้แต่ลบไม่ได้
- **หน้าแก้ไขพนักงาน** (เฉพาะ super_admin เห็นส่วนนี้):
  - "บทบาท" แบบ multi-select (ชิปเหมือน empeo) — เพิ่ม/ลบบทบาทให้คนนั้น
  - ถ้าบทบาทที่เพิ่มเป็นแพทย์/พยาบาล → โผล่ช่องกรอกเลขใบประกอบ
- **ลบเมนูแยก** /admin/mounjaro-access (ย้าย logic มาอยู่ในหน้าพนักงาน)

---

## 5. แผนเฟส
- **เฟส 2:** ตาราง RBAC + seed + backfill + ฟังก์ชัน userCan + เขียน gate เดิมใหม่
  ให้อ่าน RBAC + **สคริปต์เทส** (ทุกคนสิทธิ์เท่าเดิม) — ยังไม่มี UI, deploy ได้
  โดยไม่มีใครรู้สึกต่าง
- **เฟส 3:** หน้า "บทบาทและสิทธิ์" (สร้าง/แก้บทบาท + permission)
- **เฟส 4:** assign บทบาทในหน้าพนักงาน (multi-select + ใบประกอบ) + ลบเมนู
  mounjaro-access + ย้าย clinical/HR ให้เป็นบทบาท
- **เฟส 5:** เก็บกวาด — เลิกพึ่งธงเดิม (ถ้าต้องการ) + เอกสาร

---

## 6. ❓ คำถามก่อนเฟส 2

**R1:** บทบาท "พยาบาล" เฟสนี้ยังไม่ให้เห็น clinical (ตามที่ตกลงไว้) — เก็บเป็น
บทบาทเปล่า ๆ ไว้ก่อนใช่ไหม?

**R2:** ใครได้สิทธิ์ `rbac.manage` (จัดการบทบาท)? เสนอ **super_admin เท่านั้น** —
โอเคไหม? หรืออยากให้บางบทบาทจัดการบทบาทอื่นได้

**R3:** ตอนนี้ "admin ทุกคนเข้า RECRUITA/PERSONA/RESERVA/INVENTA ได้หมด" — หลัง
RBAC อยากแยกละเอียดขึ้นไหม (เช่น HR เข้า RECRUITA ได้ แต่ไม่เข้า INVENTA) หรือเก็บ
บทบาท "ผู้ดูแลระบบสาขา" ที่ได้ครบเหมือนเดิมไปก่อน แล้วค่อยแยกทีหลัง?

**R4:** ยืนยันว่า super_admin = เข้าได้ทุกอย่างเสมอ (ไม่ต้อง assign บทบาท) ใช่ไหม?

**R5:** ใบประกอบวิชาชีพ ผูกกับ "การถือบทบาทแพทย์/พยาบาลของคนนั้น" (1 คน 1 เลข
ต่อบทบาทคลินิก) — โอเคไหม?

---

*จบเฟส 1 — รอ "ผ่าน" + คำตอบ R1–R5 ก่อนเริ่มเฟส 2 (schema + backfill + เทสไม่ให้ใคร
เสียสิทธิ์)*
