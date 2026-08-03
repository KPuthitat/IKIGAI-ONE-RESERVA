// Client-safe constants & types สำหรับระบบลา
// (แยกจาก leave.ts เพราะ leave.ts ใช้ node:fs/node:path → bundle ฝั่ง client ไม่ได้)

// pilgrimage ถูกลบออกตามคำขอผู้ใช้ (Phase 1C v4)
// "unpaid" (ลาไม่รับค่าจ้าง / ลานอกสิทธิ์) was seeded into leave_types on
// 2026-06-17 (eligibility = all, both PT + FT) and wired into payroll + i18n,
// but was missing from this enum — so the submit/admin-create validation
// (ALL_LEAVE_TYPES.includes) rejected it as invalid_type. Added 2026-06-24.
// "holiday" (วันหยุดประเพณีสะสม, owner 2026-08-03): 13 วัน/ปี สะสมตามอายุงาน
// (~1.08 วัน/เดือน) — โควตาคิดแบบ accrual ใน leave.ts (getEffectiveQuotaDays) ไม่ใช่
// ก้อนคงที่. ใช้เป็นชนิดลาปกติ (ขอ → อนุมัติ → ตัดยอด) เพื่อ reuse ระบบลาที่มีอยู่.
export const ALL_LEAVE_TYPES = [
  "sick", "personal", "annual", "pt_emergency",
  "maternity", "sterilization", "ordination", "military", "unpaid", "holiday"
] as const;

export type LeaveType = typeof ALL_LEAVE_TYPES[number];

export type LeaveTypeRow = {
  code: LeaveType;
  default_quota_days: number | null;
  gender_eligibility: "all" | "male" | "female";
  employment_eligibility: "all" | "pt" | "ft";
  requires_pre_approval: number;
  requires_evidence: number;  // 1 = ต้องแนบหลักฐาน, 0 = ไม่บังคับ
  sort_order: number;
};

export type PublicHoliday = {
  date: string;
  name_th: string;
  name_en: string;
  is_workday: number;  // 1 = ธุรกิจถือเป็นวันทำงาน (เช่น Labor Day สำหรับร้านอาหาร)
};

export type QuotaInfo = {
  type: LeaveType;
  quota: number | null;
  used: number;
  remaining: number | null;
};
