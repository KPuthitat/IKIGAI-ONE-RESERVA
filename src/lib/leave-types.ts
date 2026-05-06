// Client-safe constants & types สำหรับระบบลา
// (แยกจาก leave.ts เพราะ leave.ts ใช้ node:fs/node:path → bundle ฝั่ง client ไม่ได้)

export const ALL_LEAVE_TYPES = [
  "sick", "personal", "annual", "pt_emergency",
  "maternity", "sterilization", "ordination", "pilgrimage", "military"
] as const;

export type LeaveType = typeof ALL_LEAVE_TYPES[number];

export type LeaveTypeRow = {
  code: LeaveType;
  default_quota_days: number | null;
  gender_eligibility: "all" | "male" | "female";
  employment_eligibility: "all" | "pt" | "ft";
  requires_pre_approval: number;
  sort_order: number;
};

export type PublicHoliday = { date: string; name_th: string; name_en: string };

export type QuotaInfo = {
  type: LeaveType;
  quota: number | null;
  used: number;
  remaining: number | null;
};
