// ── RBAC permission catalog (shared client + server) ───────────────
//
// Permissions are CODE-DEFINED (the app knows what each one gates).
// Roles are owner-DEFINED in the UI: pick a name + tick permissions,
// then assign roles to people. Adding a new permission = add an entry
// here + gate the corresponding module with requirePermission().
//
// Scope (v1, 2026-06-04): admin MODULE access only. Payroll, clinical
// (doctor/nurse + license) and HR-aggregate keep their own dedicated
// grants on the employee record — they're PDPA-sensitive and managed
// separately, not via these generic roles.
//
// This module is pure data (no better-sqlite3 import) so client
// components can import the catalog for the role editor UI.

export type RbacPermissionKey =
  | "persona.manage"
  | "reserva.manage"
  | "recruita.access"
  | "insigna.view"
  | "ascenda.view"
  | "accounta.manage"
  | "delivera.manage"
  | "ir.manage"
  | "partner.drink.redeem"
  | "partner.mealpass.confirm";

export type RbacPermissionDef = {
  key: RbacPermissionKey;
  /** Module label (matches the sidebar). */
  module: string;
  /** Short Thai description of what the permission unlocks. */
  labelTh: string;
  descTh: string;
};

export const RBAC_PERMISSIONS: RbacPermissionDef[] = [
  {
    key: "persona.manage",
    module: "PERSONA",
    labelTh: "PERSONA — บุคคล/กะ/ลา/รายงาน",
    descTh: "จัดการพนักงาน ตารางกะ การลา และรายงาน (ไม่รวมเงินเดือน — ตั้งแยกในหน้าพนักงาน)"
  },
  {
    key: "reserva.manage",
    module: "RESERVA",
    labelTh: "RESERVA — จองโต๊ะ",
    descTh: "จัดการการจอง โต๊ะ ผังเวลา และตั้งค่าการจอง"
  },
  {
    key: "recruita.access",
    module: "RECRUITA",
    labelTh: "RECRUITA — รับสมัครงาน",
    descTh: "ดูใบสมัคร จัดการตำแหน่ง สัมภาษณ์ และ pipeline การจ้าง"
  },
  {
    key: "insigna.view",
    module: "INSIGNA",
    labelTh: "INSIGNA — วิเคราะห์ลูกค้า",
    descTh: "ดูข้อมูลเชิงลึกและสถิติลูกค้า"
  },
  {
    key: "ascenda.view",
    module: "ASCENDA",
    labelTh: "ASCENDA — รายได้/KPI",
    descTh: "ดูรายได้ เป้าหมาย และตัวชี้วัด"
  },
  {
    key: "accounta.manage",
    module: "ACCOUNTA",
    labelTh: "ACCOUNTA — บัญชี/ความเป็นไปได้",
    descTh: "ลงบัญชีรายรับ-รายจ่าย ภาษี และประเมินความเป็นไปได้ของโปรเจคลงทุน (FEASIBILITY)"
  },
  {
    key: "delivera.manage",
    module: "DELIVERA",
    labelTh: "DELIVERA — เดลิเวอรี่ส่งเอง",
    descTh: "กระดานครัวรับออเดอร์เดลิเวอรี่ ยืนยันสลิป จัดการเมนู/โซนส่ง และทีมงานส่งสุข"
  },
  {
    key: "ir.manage",
    module: "IR",
    labelTh: "IR — ความเสี่ยง/อุบัติการณ์",
    descTh: "รับแจ้งเหตุการณ์ไม่พึงประสงค์/ความเสี่ยง ทบทวนหาสาเหตุ ติดตามการแก้ไข และดูเทรนด์รายสัปดาห์ (Risk Management)"
  },
  {
    key: "partner.drink.redeem",
    module: "PARTNER",
    labelTh: "จ้อจี้ — สแกนรับเครื่องดื่ม",
    descTh: "สแกน QR ของพนักงานเพื่อจ่ายเครื่องดื่มสวัสดิการ (สำหรับบัญชีพาร์ทเนอร์ เช่น จ้อจี้)"
  },
  {
    key: "partner.mealpass.confirm",
    module: "PARTNER",
    labelTh: "ศาลาชิลล์ — สแกนยืนยันอาหารข้ามบริษัท",
    descTh: "สแกน QR ของพนักงานเพื่อยืนยันอาหารข้ามบริษัท (หักค่าตอบแทน บริษัทชำระให้ตามรอบสัปดาห์)"
  }
];

export const RBAC_PERMISSION_KEYS: RbacPermissionKey[] =
  RBAC_PERMISSIONS.map((p) => p.key);

/** Type guard — true when a string is a known permission key. */
export function isRbacPermissionKey(k: string): k is RbacPermissionKey {
  return (RBAC_PERMISSION_KEYS as string[]).includes(k);
}

/** Filter an arbitrary string[] down to valid, de-duplicated keys. */
export function sanitizePermissionKeys(keys: string[]): RbacPermissionKey[] {
  return [...new Set(keys)].filter(isRbacPermissionKey);
}

/** Permission → label lookup for rendering chips/lists. */
export function permissionLabel(key: string): string {
  return RBAC_PERMISSIONS.find((p) => p.key === key)?.labelTh ?? key;
}
