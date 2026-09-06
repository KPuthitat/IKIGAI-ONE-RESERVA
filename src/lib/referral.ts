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
import { computeMonthlyAttendanceStats } from "./monthly-attendance-stats";
import { approvedExcusedDatesForMonth } from "./late-excusals";
import { recomputeLine } from "./payroll-compute";

const round2 = (n: number) => Math.round(n * 100) / 100;

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

// ── Gate evaluation (part 3) ─────────────────────────────────────────

export type ReferralEval = {
  /** True when there IS roster data to judge attendance/penalty against. */
  computable: boolean;
  scheduledDays: number;
  daysWorked: number;
  /** ขาด/ลา/สาย รวม % — SVC combinedPenaltyPct over the window. */
  penaltyPct: number;
  attendancePct: number;
  retentionOk: boolean;    // ยังเป็นพนักงานอยู่ ณ วันประเมิน (ครบ 119 วัน)
  penaltyOk: boolean;      // ≤ 20%
  attendanceOk: boolean;   // ≥ 50%
  qualified: boolean;
  reasons: string[];       // เหตุผลที่ไม่ผ่าน (สำหรับ disqualify)
};

/** YYYY-MM list from `fromYmd`'s month to `toYmd`'s month, inclusive. */
function monthsInclusive(fromYmd: string, toYmd: string): string[] {
  const out: string[] = [];
  let [y, m] = fromYmd.slice(0, 7).split("-").map(Number);
  const [ty, tm] = toYmd.slice(0, 7).split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Evaluate a referral's 3 gates over the [hire_date, eligible_on] window using
 * the SAME attendance metric as the SVC statistics page (combinedPenaltyPct).
 * Advisory — the admin confirms the payout (part 4), so a no-roster window is
 * judged leniently (penalty passes; attendance passes if they clocked at all)
 * and flagged computable=false for review.
 */
export function evaluateReferral(
  db: Database.Database,
  r: { referred_user_id: number; hire_date: string | null; eligible_on: string | null }
): ReferralEval {
  const reasons: string[] = [];

  // Retention — still an active employee at evaluation time (which is on/after
  // eligible_on). A resignation/termination flips users.status, so an active
  // status here means they made it past 119 days.
  const u = db.prepare(
    "SELECT status, shift_start_time FROM users WHERE id = ?"
  ).get(r.referred_user_id) as { status: string; shift_start_time: string | null } | undefined;
  const retentionOk = !!u && !["disabled", "resigned", "terminated"].includes(u.status);
  if (!retentionOk) reasons.push("retention");

  const from = r.hire_date;
  const to = r.eligible_on;
  let scheduledDays = 0, penaltyNumer = 0;
  if (from && to && u) {
    // Primary branch drives the roster/stats denominator.
    const branch = (db.prepare(`
      SELECT COALESCE(
        (SELECT branch_id FROM user_branches WHERE user_id = ? AND is_primary = 1 LIMIT 1),
        (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ?)
      ) AS b
    `).get(r.referred_user_id, r.referred_user_id) as { b: number | null }).b;
    if (branch != null) {
      for (const ym of monthsInclusive(from, to)) {
        let stats;
        try {
          // อนุโลมการมาสายที่อนุมัติแล้ว ไม่นับเป็น "สาย" ในเกณฑ์ 20% (เดียวกับ SVC).
          const excusedDates = approvedExcusedDatesForMonth(db, ym);
          stats = computeMonthlyAttendanceStats(branch, ym,
            [{ user_id: r.referred_user_id, shift_start_time: u.shift_start_time }],
            { excusedDates }).get(r.referred_user_id);
        } catch { continue; }
        if (!stats) continue;
        scheduledDays += stats.scheduledDays;
        penaltyNumer += stats.lateCount + stats.earlyOutCount + stats.leavesOnRestrictedDays + stats.abnormalLeaveCount;
      }
    }
  }

  // Days actually clocked in the window (any branch) — "ส่งเวร".
  let daysWorked = 0;
  if (from && to) {
    const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
    const toIso = new Date(`${to}T23:59:59+07:00`).toISOString();
    const ins = db.prepare(
      "SELECT ts FROM time_entries WHERE user_id = ? AND type = 'in' AND ts >= ? AND ts <= ?"
    ).all(r.referred_user_id, fromIso, toIso) as Array<{ ts: string }>;
    const dates = new Set<string>();
    for (const e of ins) dates.add(new Date(new Date(e.ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10));
    daysWorked = dates.size;
  }

  const computable = scheduledDays > 0;
  const penaltyPct = computable ? (penaltyNumer / scheduledDays) * 100 : 0;
  const attendancePct = computable ? (daysWorked / scheduledDays) * 100 : 0;
  const penaltyOk = computable ? penaltyPct <= REFERRAL_MAX_LATE_ABSENCE_RATIO * 100 : true;
  const attendanceOk = computable ? attendancePct >= REFERRAL_MIN_ATTENDANCE_RATIO * 100 : daysWorked > 0;
  if (!penaltyOk) reasons.push("late_absence");
  if (!attendanceOk) reasons.push("attendance");

  return {
    computable, scheduledDays, daysWorked,
    penaltyPct: Math.round(penaltyPct * 10) / 10,
    attendancePct: Math.round(attendancePct * 10) / 10,
    retentionOk, penaltyOk, attendanceOk,
    qualified: retentionOk && penaltyOk && attendanceOk,
    reasons
  };
}

/**
 * Evaluate every PENDING referral whose eligible_on has arrived, moving it to
 * 'qualified' or 'disqualified'. Advisory — payout still needs admin confirm
 * (part 4). Safe to run repeatedly (idempotent per status). Returns the counts.
 */
export function evaluateDueReferrals(db: Database.Database, today?: string): { qualified: number; disqualified: number } {
  const todayYmd = today ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const due = db.prepare(
    "SELECT id, referred_user_id, hire_date, eligible_on FROM referrals WHERE status = 'pending' AND eligible_on IS NOT NULL AND eligible_on <= ?"
  ).all(todayYmd) as Array<{ id: number; referred_user_id: number; hire_date: string | null; eligible_on: string | null }>;
  let qualified = 0, disqualified = 0;
  const upd = db.prepare(`
    UPDATE referrals SET status = ?, qualified_at = ?, disqualify_reason = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `);
  for (const row of due) {
    const ev = evaluateReferral(db, row);
    if (ev.qualified) { upd.run("qualified", new Date().toISOString(), null, row.id); qualified++; }
    else { upd.run("disqualified", null, ev.reasons.join(","), row.id); disqualified++; }
  }
  return { qualified, disqualified };
}

// ── Payout (part 4) ──────────────────────────────────────────────────

export type PayReferralResult =
  | { ok: true; periodId: number; amount: number }
  | { ok: false; reason: "not_qualified" | "no_open_round" | "not_found" };

/**
 * Admin-confirmed payout of a QUALIFIED referral: add the reward to the
 * referrer's current OPEN (draft) payroll round as an "เพิ่มอื่นๆ" addition, then
 * recompute that line so tax falls out correctly (ในระบบ = SSO base unchanged /
 * นอกระบบ = WHT 3%). Marks the referral 'paid'. No open draft round → no-op error
 * so the admin opens a round first. Idempotent: a non-qualified referral is
 * rejected, so a double click can't pay twice.
 */
export function payReferral(db: Database.Database, referralId: number): PayReferralResult {
  const r = db.prepare(
    "SELECT id, referrer_user_id, reward_amount, status FROM referrals WHERE id = ?"
  ).get(referralId) as { id: number; referrer_user_id: number; reward_amount: number; status: string } | undefined;
  if (!r) return { ok: false, reason: "not_found" };
  if (r.status !== "qualified") return { ok: false, reason: "not_qualified" };

  // The referrer's most recent OPEN (draft) payroll line — the round the money
  // lands in. Latest pay_date wins so it goes to the round being worked now.
  const line = db.prepare(`
    SELECT pl.period_id, pl.other_additions
    FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.status = 'draft'
    ORDER BY pp.pay_date DESC, pp.id DESC LIMIT 1
  `).get(r.referrer_user_id) as { period_id: number; other_additions: number } | undefined;
  if (!line) return { ok: false, reason: "no_open_round" };

  const amount = round2(r.reward_amount || REFERRAL_REWARD_BAHT);
  // Atomic: bump the addition, recompute the line (so gross/tax/net include it —
  // tax mode handled by the engine), and mark the referral paid — all or nothing.
  db.transaction(() => {
    db.prepare(
      "UPDATE payroll_lines SET other_additions = ? WHERE period_id = ? AND user_id = ?"
    ).run(round2((line.other_additions || 0) + amount), line.period_id, r.referrer_user_id);
    recomputeLine(db, line.period_id, r.referrer_user_id);
    db.prepare(`
      UPDATE referrals
      SET status = 'paid', paid_at = ?, paid_period_id = ?,
          note = 'จ่ายค่าแนะนำ ' || ? || ' บาท เข้ารอบเงินเดือน', updated_at = datetime('now')
      WHERE id = ?
    `).run(new Date().toISOString(), line.period_id, amount, referralId);
  })();
  return { ok: true, periodId: line.period_id, amount };
}

export type ReferralListRow = {
  id: number; status: ReferralStatus;
  referred_user_id: number; referred_name: string | null;
  referrer_user_id: number; referrer_name: string | null;
  hire_date: string | null; eligible_on: string | null;
  reward_amount: number; disqualify_reason: string | null;
  paid_at: string | null; paid_period_id: number | null;
};

/** All referrals with both names resolved, newest first. */
export function listReferrals(db: Database.Database): ReferralListRow[] {
  return db.prepare(`
    SELECT rf.id, rf.status,
           rf.referred_user_id, ru.display_name AS referred_name,
           rf.referrer_user_id, rr.display_name AS referrer_name,
           rf.hire_date, rf.eligible_on, rf.reward_amount, rf.disqualify_reason,
           rf.paid_at, rf.paid_period_id
    FROM referrals rf
    LEFT JOIN users ru ON ru.id = rf.referred_user_id
    LEFT JOIN users rr ON rr.id = rf.referrer_user_id
    ORDER BY rf.created_at DESC, rf.id DESC
  `).all() as ReferralListRow[];
}
