// Server-side helpers สำหรับระบบลา (PERSONA Phase 1C)
// ไฟล์นี้ใช้ node:fs/node:path → import ได้เฉพาะ server (route.ts / page.tsx)
// ห้าม import จาก "use client" component → ใช้ ./leave-types แทน
import { getDb } from "./db";
import fs from "node:fs";
import path from "node:path";
import {
  ALL_LEAVE_TYPES, type LeaveType, type LeaveTypeRow, type PublicHoliday, type QuotaInfo
} from "./leave-types";

export { ALL_LEAVE_TYPES };
export type { LeaveType, LeaveTypeRow, PublicHoliday, QuotaInfo };

export function getAllLeaveTypes(): LeaveTypeRow[] {
  return getDb().prepare(
    "SELECT * FROM leave_types ORDER BY sort_order"
  ).all() as LeaveTypeRow[];
}

/** ประเภทการลาที่พนักงานคนนี้มีสิทธิ์ขอ — กรองตาม gender + employment_type + pre-approval */
export function getEligibleLeaveTypesForUser(user: {
  id: number;
  gender: string | null;
  employment_type: string | null;
}): LeaveTypeRow[] {
  const all = getAllLeaveTypes();
  const unlocked = getDb().prepare(
    "SELECT type FROM leave_unlocks WHERE user_id = ?"
  ).all(user.id) as Array<{ type: string }>;
  const unlockedSet = new Set(unlocked.map((u) => u.type));

  return all.filter((t) => {
    // gender filter — ถ้า user ยังไม่ระบุเพศ ให้ผ่านทุกประเภท (ไม่บล็อก)
    if (user.gender && t.gender_eligibility !== "all" && t.gender_eligibility !== user.gender) {
      return false;
    }
    // employment filter
    if (user.employment_type && t.employment_eligibility !== "all" && t.employment_eligibility !== user.employment_type) {
      return false;
    }
    // ถ้า user ไม่มี employment_type แต่ type นี้ requires PT/FT → ซ่อน
    // ตัวอย่าง pt_emergency จะไม่โผล่ถ้า user ยังไม่ตั้ง employment_type
    if (!user.employment_type && t.employment_eligibility !== "all") {
      return false;
    }
    // pre-approval gate
    if (t.requires_pre_approval && !unlockedSet.has(t.code)) {
      return false;
    }
    return true;
  });
}

/** ชั่วโมงที่ใช้ไปแล้วในปีนี้ — แปลง days → hours (1 day = 8h) */
export function getLeaveHoursUsedThisYear(userId: number, type: LeaveType): number {
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 4);
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN hours IS NOT NULL THEN hours ELSE days * 8 END
    ), 0) AS total_hours
    FROM leave_requests
    WHERE user_id = ? AND type = ?
      AND status IN ('pending','approved')
      AND substr(date_from, 1, 4) = ?
  `).get(userId, type, year) as { total_hours: number };
  return Number(row.total_hours) || 0;
}

/** Quota override ของ user (ถ้ามี) มิฉะนั้นคืน default จาก leave_types */
export function getEffectiveQuotaDays(userId: number, type: LeaveTypeRow): number | null {
  const row = getDb().prepare(
    "SELECT quota_days FROM user_leave_quotas WHERE user_id = ? AND type = ?"
  ).get(userId, type.code) as { quota_days: number } | undefined;
  if (row) return row.quota_days;
  return type.default_quota_days;
}

/** สิทธิ์คงเหลือ — แสดงเป็น "X วัน Y ชั่วโมง" (1 วัน = 8 ชม.) */
export function getQuotaInfo(userId: number, type: LeaveTypeRow): QuotaInfo {
  const usedHours = getLeaveHoursUsedThisYear(userId, type.code);
  const quotaDays = getEffectiveQuotaDays(userId, type);
  if (quotaDays == null) {
    return { type: type.code, quota: null, used: +(usedHours / 8).toFixed(2), remaining: null };
  }
  const quotaHours = quotaDays * 8;
  const remainingHours = Math.max(0, quotaHours - usedHours);
  return {
    type: type.code,
    quota: quotaDays,
    used: +(usedHours / 8).toFixed(2),
    remaining: +(remainingHours / 8).toFixed(4)  // ใช้ทศนิยม 4 ตัว ป้องกัน rounding
  };
}

/** Format ชั่วโมงเป็น "X วัน Y ชม." (ปัดเศษให้เป็นจำนวนเต็ม) */
export function formatRemainingHours(hours: number): { days: number; hours: number; totalHours: number } {
  const totalH = Math.round(hours * 2) / 2;
  const fullDays = Math.floor(totalH / 8);
  const restH = Math.round(totalH - fullDays * 8);
  return { days: fullDays, hours: restH, totalHours: totalH };
}

// ── Phase 1C v5: Weekend / weekly off-day extension intent detection ────

export type WeekendExtensionInfo = {
  weekendDates: string[];          // วัน Sat/Sun ในช่วงลา
  onWeeklyOffDay: string[];         // วันที่ตรงกับ weekly_off_day ของพนักงาน
  hasWeekendLeave: boolean;
  fallsOnUserOffDay: boolean;
};

/**
 * ตรวจการลาที่อาจมีเจตนา "ขยายวันหยุด"
 * - เสาร์/อาทิตย์ในช่วงลา → suspicious (ร้านเปิด ต้องการคนทำงาน)
 * - ตรงกับ weekly_off_day ของพนักงาน → ไม่จำเป็น (วันหยุดอยู่แล้ว)
 */
export function detectWeekendExtension(
  weeklyOffDay: number | null,
  dateFrom: string,
  dateTo: string
): WeekendExtensionInfo {
  const weekendDates: string[] = [];
  const onWeeklyOffDay: string[] = [];
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    const ds = d.toISOString().slice(0, 10);
    if (dow === 0 || dow === 6) weekendDates.push(ds);
    if (weeklyOffDay != null && dow === weeklyOffDay) onWeeklyOffDay.push(ds);
  }
  return {
    weekendDates,
    onWeeklyOffDay,
    hasWeekendLeave: weekendDates.length > 0,
    fallsOnUserOffDay: onWeeklyOffDay.length > 0
  };
}

// ── Phase 1C v5: Resignation logic ─────────────────────────────────────

/**
 * คำนวณวันสุดท้ายขั้นต่ำที่ต้องทำงาน = วันสุดท้ายของเดือนถัดจากเดือนที่ยื่น
 * ตัวอย่าง: ยื่น 11 เม.ย. → ทำงานถึง 31 พ.ค.
 */
export function computeMinLastWorkingDay(submissionDateStr: string): string {
  const [y, m] = submissionDateStr.split("-").map(Number);
  // เดือนถัดไป (ใส่ +1) แล้วเอาวันสุดท้ายของเดือนนั้น
  // วันสุดท้าย = วันแรกของเดือน +2 ลบ 1 วัน
  const targetMonthIdx = (m - 1) + 2; // 0-based + 2 months
  const targetYear = y + Math.floor(targetMonthIdx / 12);
  const finalMonthIdx = targetMonthIdx % 12;
  const firstOfNextNext = new Date(Date.UTC(targetYear, finalMonthIdx, 1));
  firstOfNextNext.setUTCDate(firstOfNextNext.getUTCDate() - 1);
  return firstOfNextNext.toISOString().slice(0, 10);
}

// ── File upload helpers ──────────────────────────────────────────────
const UPLOAD_DIR = process.env.LEAVE_UPLOAD_DIR
  || path.join(process.cwd(), "data", "uploads", "leave");

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf"
]);
const MAX_BYTES = 3 * 1024 * 1024; // 3MB (Phase 1C v4 — ลดลงเพื่อประหยัด disk)

export async function saveLeaveAttachment(
  userId: number,
  file: File
): Promise<{ ok: true; filename: string } | { ok: false; error: string }> {
  if (file.size > MAX_BYTES) return { ok: false, error: "file_too_large" };
  if (!ALLOWED_TYPES.has(file.type)) return { ok: false, error: "file_type_not_allowed" };

  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  // ชื่อไฟล์: <userId>_<timestamp>_<random>.<ext>
  const origName = file.name || "evidence";
  const extMatch = /\.([a-zA-Z0-9]{1,8})$/.exec(origName);
  const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${userId}_${ts}_${rand}.${ext}`;

  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);

  return { ok: true, filename };
}

export function getAttachmentPath(filename: string): string | null {
  // ป้องกัน path traversal
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const full = path.join(UPLOAD_DIR, filename);
  if (!fs.existsSync(full)) return null;
  return full;
}

// ── Phase 1C v3: หยุดยาว + วันหยุดราชการ ─────────────────────────────

export function getAllPublicHolidays(): PublicHoliday[] {
  return getDb().prepare("SELECT date, name_th, name_en FROM public_holidays ORDER BY date").all() as PublicHoliday[];
}

export function getPublicHolidaySet(): Set<string> {
  return new Set(getAllPublicHolidays().map((h) => h.date));
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00Z`).getTime();
  const t = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((t - f) / 86400000) + 1);
}

export type StretchInfo = {
  leaveDays: number;
  prepended: PublicHoliday[];   // วันหยุดราชการก่อนหน้าวันลา (ติดกัน)
  appended: PublicHoliday[];    // วันหยุดราชการหลังวันลา (ติดกัน)
  totalConsecutive: number;     // รวม leave + prepended + appended
};

/** วิเคราะห์ "หยุดต่อเนื่อง" — leave + วันหยุดราชการที่ติดกัน */
export function computeStretch(dateFrom: string, dateTo: string): StretchInfo {
  const holidaysList = getAllPublicHolidays();
  const byDate = new Map(holidaysList.map((h) => [h.date, h]));

  const leaveDays = daysBetweenInclusive(dateFrom, dateTo);

  const prepended: PublicHoliday[] = [];
  let cur = addDays(dateFrom, -1);
  while (byDate.has(cur)) {
    prepended.unshift(byDate.get(cur)!);
    cur = addDays(cur, -1);
  }

  const appended: PublicHoliday[] = [];
  cur = addDays(dateTo, 1);
  while (byDate.has(cur)) {
    appended.push(byDate.get(cur)!);
    cur = addDays(cur, 1);
  }

  return {
    leaveDays,
    prepended,
    appended,
    totalConsecutive: leaveDays + prepended.length + appended.length
  };
}

/** อายุงานเป็นปี (ทศนิยม) — null ถ้าไม่มี hire_date */
export function getYearsOfService(hireDate: string | null, asOf?: Date): number | null {
  if (!hireDate || !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return null;
  const start = new Date(`${hireDate}T00:00:00Z`).getTime();
  const now = (asOf ?? new Date()).getTime();
  return (now - start) / (365.25 * 86400000);
}

/** นับครั้งที่ใช้ "long-leave" (personal/annual ที่ติดวันหยุด) ของปีนี้ */
export function countLongLeaveUsageThisYear(userId: number): number {
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 4);
  const rows = getDb().prepare(`
    SELECT date_from, date_to FROM leave_requests
    WHERE user_id = ?
      AND type IN ('personal','annual')
      AND status IN ('pending','approved')
      AND substr(date_from, 1, 4) = ?
  `).all(userId, year) as Array<{ date_from: string; date_to: string }>;

  // นับเฉพาะ request ที่ติดวันหยุดราชการ (อย่างน้อย prepend หรือ append)
  let count = 0;
  for (const r of rows) {
    const s = computeStretch(r.date_from, r.date_to);
    if (s.prepended.length > 0 || s.appended.length > 0) count++;
  }
  return count;
}

export type LongLeaveAnalysis = {
  stretch: StretchInfo;
  daysAdvanceNotice: number;       // วันที่ขอ - วันที่เริ่มลา (>=0)
  longLeaveUsageThisYear: number;  // นับ ก่อน รวม request ปัจจุบัน
  yearsOfService: number | null;
  // กฎ self-service (3 ข้อ):
  withinConsecutiveLimit: boolean;  // total ≤ 3
  withinUsageLimit: boolean;        // count < 2 (ก่อนรวม request นี้)
  withinAdvanceLimit: boolean;      // advance ≥ 7 วัน
  // กฎ hard:
  exceedsMaxConsecutive: boolean;   // total > 5
  meetsAnnualEligibility: boolean | null; // null ถ้าไม่ใช่ลาพักร้อน
  // สถานะรวม
  status: "self_service" | "needs_special_approval" | "blocked";
  blockReason?: "exceeds_max_consecutive" | "annual_requires_one_year";
};

export function analyzeLongLeave(args: {
  userId: number;
  type: LeaveType;
  dateFrom: string;
  dateTo: string;
  hireDate: string | null;
}): LongLeaveAnalysis {
  const stretch = computeStretch(args.dateFrom, args.dateTo);

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const advanceDays = Math.floor(
    (new Date(`${args.dateFrom}T00:00:00Z`).getTime() - new Date(`${todayBkk}T00:00:00Z`).getTime())
    / 86400000
  );

  const usageBefore = countLongLeaveUsageThisYear(args.userId);
  const yos = getYearsOfService(args.hireDate);

  const withinConsecutiveLimit = stretch.totalConsecutive <= 3;
  const withinUsageLimit = usageBefore < 2;
  const withinAdvanceLimit = advanceDays >= 7;
  const exceedsMaxConsecutive = stretch.totalConsecutive > 5;
  const isAnnual = args.type === "annual";
  const meetsAnnualEligibility = isAnnual ? (yos != null && yos >= 1) : null;

  let status: LongLeaveAnalysis["status"];
  let blockReason: LongLeaveAnalysis["blockReason"];

  if (exceedsMaxConsecutive) {
    status = "blocked";
    blockReason = "exceeds_max_consecutive";
  } else if (isAnnual && meetsAnnualEligibility === false) {
    status = "blocked";
    blockReason = "annual_requires_one_year";
  } else if (withinConsecutiveLimit && withinUsageLimit && withinAdvanceLimit) {
    status = "self_service";
  } else {
    status = "needs_special_approval";
  }

  return {
    stretch,
    daysAdvanceNotice: advanceDays,
    longLeaveUsageThisYear: usageBefore,
    yearsOfService: yos,
    withinConsecutiveLimit,
    withinUsageLimit,
    withinAdvanceLimit,
    exceedsMaxConsecutive,
    meetsAnnualEligibility,
    status,
    blockReason
  };
}
