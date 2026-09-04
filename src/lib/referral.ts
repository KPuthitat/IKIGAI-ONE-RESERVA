// ระบบแนะนำคนมาทำงาน (employee referral) — owner 2026-09-03/09-04.
//
// Flow:
//   1. Applicant picks a referrer on the job form (recruita_candidates
//      .referred_by_user_id) — captured in the applications route.
//   2. On HIRE the referrer is carried onto the new employee
//      (users.referred_by_user_id) and a `referrals` ledger row is opened
//      (status 'pending', eligible_on = hire_date + 119 days) — recordReferralOnHire.
//   3. From eligible_on the gates are evaluated; passing → 'qualified', the
//      500฿ is posted to the referrer's payroll (part 3/4).
//
// Gates (same spirit as the SVC late-ratio rule), measured over the whole
// 119-day window from hire:
//   • ขาด/ลา/สาย รวมกัน ≤ 20% ของเวลางาน
//   • ส่งเวร ≥ 50% ของวันที่ถูกจัดกะ (ไม่กำหนดชั่วโมง — เผื่อ PT หลังเลิกเรียน)
//   • อยู่กับเราครบ 119 วัน (retention)

import type Database from "better-sqlite3";

export const REFERRAL_REWARD_BAHT = 500;
export const REFERRAL_RETENTION_DAYS = 119;
/** ขาด/ลา/สาย รวมกันต้องไม่เกินสัดส่วนนี้ของเวลางาน (เดียวกับ SVC). */
export const REFERRAL_MAX_LATE_ABSENCE_RATIO = 0.20;
/** ส่งเวรอย่างน้อยสัดส่วนนี้ของวันที่ถูกจัดกะ. */
export const REFERRAL_MIN_ATTENDANCE_RATIO = 0.50;

export type ReferralStatus = "pending" | "qualified" | "paid" | "disqualified" | "cancelled";

/** Add `days` calendar days to a YYYY-MM-DD date, returning YYYY-MM-DD. */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Is `userId` an active (non-resigned/disabled/terminated, non-test) employee? */
export function isActiveEmployee(db: Database.Database, userId: number): boolean {
  return !!db.prepare(
    `SELECT 1 FROM users WHERE id = ? AND role IN ('staff','admin')
       AND status NOT IN ('disabled','resigned','terminated') AND is_test_account = 0`
  ).get(userId);
}

/**
 * On hire, carry the referrer from the candidate onto the new employee and open
 * a referrals ledger row. Must run inside the hire transaction. No-op when there
 * is no referrer, the referrer isn't an active employee, or it's a self-referral.
 * Idempotent per referred employee (UNIQUE(referred_user_id) + INSERT OR IGNORE).
 */
export function recordReferralOnHire(
  db: Database.Database,
  newUserId: number,
  referrerId: number | null,
  hireDate: string | null
): void {
  if (!referrerId || referrerId === newUserId) return;
  if (!isActiveEmployee(db, referrerId)) return;
  db.prepare("UPDATE users SET referred_by_user_id = ? WHERE id = ?").run(referrerId, newUserId);
  const eligibleOn = hireDate ? addDaysYmd(hireDate, REFERRAL_RETENTION_DAYS) : null;
  db.prepare(`
    INSERT OR IGNORE INTO referrals
      (referred_user_id, referrer_user_id, hire_date, eligible_on, reward_amount, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `).run(newUserId, referrerId, hireDate, eligibleOn, REFERRAL_REWARD_BAHT);
}
