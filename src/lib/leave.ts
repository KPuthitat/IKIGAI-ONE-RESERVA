// Helpers สำหรับระบบลา (PERSONA Phase 1C v2)
import { getDb } from "./db";
import fs from "node:fs";
import path from "node:path";

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

/** วันที่ใช้ไปแล้วในปีนี้ของ type นี้ (รวม pending + approved) */
export function getLeaveDaysUsedThisYear(userId: number, type: LeaveType): number {
  const year = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 4);
  const row = getDb().prepare(`
    SELECT COALESCE(SUM(days), 0) AS total
    FROM leave_requests
    WHERE user_id = ? AND type = ?
      AND status IN ('pending','approved')
      AND substr(date_from, 1, 4) = ?
  `).get(userId, type, year) as { total: number };
  return Number(row.total) || 0;
}

export type QuotaInfo = {
  type: LeaveType;
  quota: number | null;     // null = unlimited
  used: number;
  remaining: number | null; // null = unlimited
};

export function getQuotaInfo(userId: number, type: LeaveTypeRow): QuotaInfo {
  const used = getLeaveDaysUsedThisYear(userId, type.code);
  const quota = type.default_quota_days;
  const remaining = quota == null ? null : Math.max(0, quota - used);
  return { type: type.code, quota, used, remaining };
}

// ── File upload helpers ──────────────────────────────────────────────
const UPLOAD_DIR = process.env.LEAVE_UPLOAD_DIR
  || path.join(process.cwd(), "data", "uploads", "leave");

const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf"
]);
const MAX_BYTES = 5 * 1024 * 1024; // 5MB

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
