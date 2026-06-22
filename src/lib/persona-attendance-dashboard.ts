// /lib/persona-attendance-dashboard — aggregates ขาดงาน / ลางาน / มาสาย
// across one or more branches for the HR overview dashboard (owner 2026-06-22).
//
// Built on computeMonthlyAttendanceStats (late + leave per staff) plus a direct
// "absent" query (scheduled work day with no clock-in and no leave). There is no
// department column on users, so the breakdown is by BRANCH — the owner's real
// org unit. All numbers come from real data; no demo values.

import { getDb } from "./db";
import { computeMonthlyAttendanceStats } from "./monthly-attendance-stats";

const LEAVE_TYPE_LABEL: Record<string, string> = {
  sick: "ลาป่วย", personal: "ลากิจ", annual: "ลาพักผ่อน", maternity: "ลาคลอด",
  ordination: "ลาบวช", sterilization: "ลาทำหมัน", military: "ลาราชการทหาร"
};

type StaffRow = { user_id: number; shift_start_time: string | null; display_name: string };

function branchStaff(branchId: number): StaffRow[] {
  return getDb().prepare(`
    SELECT u.id AS user_id, u.shift_start_time, u.display_name
      FROM users u JOIN user_branches ub ON ub.user_id = u.id
     WHERE ub.branch_id = ? AND u.status = 'active'
       AND u.role IN ('staff','admin') AND COALESCE(u.is_test_account,0) = 0
  `).all(branchId) as StaffRow[];
}

/** Scheduled work-days with no clock-in and no leave = ขาดงาน, for a branch+month. */
function absentCount(branchId: number, month: string): number {
  const r = getDb().prepare(`
    SELECT COUNT(*) AS n
      FROM roster_assignments ra
      JOIN shift_codes sc ON sc.id = ra.shift_code_id AND sc.kind = 'work'
      LEFT JOIN time_entries te ON te.user_id = ra.user_id
        AND date(te.ts, '+7 hours') = ra.assignment_date AND te.type = 'in'
      LEFT JOIN leave_requests lr ON lr.user_id = ra.user_id
        AND lr.status IN ('approved','pending')
        AND ra.assignment_date BETWEEN lr.date_from AND lr.date_to
     WHERE ra.branch_id = ? AND substr(ra.assignment_date,1,7) = ?
       AND te.id IS NULL AND lr.id IS NULL
  `).get(branchId, month) as { n: number };
  return r.n;
}

type BranchTotals = { late: number; leaveDays: number; absent: number; scheduledDays: number };

function branchMonthTotals(branchId: number, month: string): BranchTotals {
  const staff = branchStaff(branchId);
  if (staff.length === 0) return { late: 0, leaveDays: 0, absent: 0, scheduledDays: 0 };
  const stats = computeMonthlyAttendanceStats(branchId, month, staff);
  let late = 0, leaveDays = 0, scheduledDays = 0;
  for (const s of stats.values()) {
    late += s.lateCount;
    leaveDays += s.totalLeaveDays;
    scheduledDays += s.scheduledDays;
  }
  return { late, leaveDays: Math.round(leaveDays * 10) / 10, absent: absentCount(branchId, month), scheduledDays };
}

export type AttendanceDashboard = {
  month: string;
  staffCount: number;
  totals: { late: number; leaveDays: number; absent: number };
  rate: number;                       // (late+leave+absent) / scheduledDays × 100
  trend: Array<{ month: string; late: number; leaveDays: number; absent: number }>;
  leaveByType: Array<{ type: string; label: string; count: number }>;
  topLate: Array<{ name: string; branch: string; late: number }>;
  byBranch: Array<{ branch: string; late: number; leaveDays: number; absent: number; rate: number }>;
  lateByBucket: Array<{ label: string; count: number }>;
};

function prevMonth(month: string, back: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function personaAttendanceDashboard(branchIds: number[], month: string): AttendanceDashboard {
  const db = getDb();
  const branches = branchIds.length
    ? (db.prepare(`SELECT id, name FROM branches WHERE id IN (${branchIds.map(() => "?").join(",")})`).all(...branchIds) as Array<{ id: number; name: string }>)
    : [];

  // Headcount (distinct active staff across the branches).
  const staffCount = branchIds.length
    ? (db.prepare(
        `SELECT COUNT(DISTINCT u.id) AS n FROM users u JOIN user_branches ub ON ub.user_id = u.id
          WHERE ub.branch_id IN (${branchIds.map(() => "?").join(",")}) AND u.status='active'
            AND u.role IN ('staff','admin') AND COALESCE(u.is_test_account,0)=0`
      ).get(...branchIds) as { n: number }).n
    : 0;

  // Per-branch this month + aggregate.
  const byBranch = branches.map((b) => {
    const t = branchMonthTotals(b.id, month);
    const rate = t.scheduledDays > 0 ? Math.round(((t.late + t.leaveDays + t.absent) / t.scheduledDays) * 1000) / 10 : 0;
    return { branch: b.name, late: t.late, leaveDays: t.leaveDays, absent: t.absent, rate, _sched: t.scheduledDays };
  });
  const totals = byBranch.reduce((a, b) => ({ late: a.late + b.late, leaveDays: Math.round((a.leaveDays + b.leaveDays) * 10) / 10, absent: a.absent + b.absent }), { late: 0, leaveDays: 0, absent: 0 });
  const totalSched = byBranch.reduce((a, b) => a + b._sched, 0);
  const rate = totalSched > 0 ? Math.round(((totals.late + totals.leaveDays + totals.absent) / totalSched) * 1000) / 10 : 0;

  // 6-month trend.
  const trend = Array.from({ length: 6 }, (_, i) => prevMonth(month, 5 - i)).map((mo) => {
    const agg = branches.reduce((a, b) => {
      const t = branchMonthTotals(b.id, mo);
      return { late: a.late + t.late, leaveDays: a.leaveDays + t.leaveDays, absent: a.absent + t.absent };
    }, { late: 0, leaveDays: 0, absent: 0 });
    return { month: mo, late: agg.late, leaveDays: Math.round(agg.leaveDays * 10) / 10, absent: agg.absent };
  });

  // Leave by type (approved, date_from in month, across branches).
  const leaveRows = branchIds.length
    ? (db.prepare(
        `SELECT type, COUNT(*) AS count FROM leave_requests
          WHERE branch_id IN (${branchIds.map(() => "?").join(",")}) AND status='approved'
            AND substr(date_from,1,7)=? GROUP BY type ORDER BY count DESC`
      ).all(...branchIds, month) as Array<{ type: string; count: number }>)
    : [];
  const leaveByType = leaveRows.map((r) => ({ type: r.type, label: LEAVE_TYPE_LABEL[r.type] ?? r.type, count: r.count }));

  // Top-5 late staff this month.
  const topLate: Array<{ name: string; branch: string; late: number }> = [];
  for (const b of branches) {
    const staff = branchStaff(b.id);
    if (!staff.length) continue;
    const stats = computeMonthlyAttendanceStats(b.id, month, staff);
    for (const s of staff) {
      const st = stats.get(s.user_id);
      if (st && st.lateCount > 0) topLate.push({ name: s.display_name, branch: b.name, late: st.lateCount });
    }
  }
  topLate.sort((a, b) => b.late - a.late);

  // Late by time-of-day bucket (clock-ins this month across branches).
  const lateBuckets = [
    { label: "ก่อน 08:30", lo: 0, hi: 510 },
    { label: "08:31–09:00", lo: 511, hi: 540 },
    { label: "09:01–09:30", lo: 541, hi: 570 },
    { label: "หลัง 09:30", lo: 571, hi: 1440 }
  ];
  const inRows = branchIds.length
    ? (db.prepare(
        `SELECT ts FROM time_entries WHERE type='in' AND branch_id IN (${branchIds.map(() => "?").join(",")}) AND substr(date(ts,'+7 hours'),1,7)=?`
      ).all(...branchIds, month) as Array<{ ts: string }>)
    : [];
  const lateByBucket = lateBuckets.map((b) => ({ label: b.label, count: 0 }));
  for (const r of inRows) {
    const d = new Date(new Date(r.ts).getTime() + 7 * 3600_000);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    const idx = lateBuckets.findIndex((b) => mins >= b.lo && mins <= b.hi);
    if (idx >= 0) lateByBucket[idx].count += 1;
  }

  return {
    month, staffCount, totals, rate, trend, leaveByType,
    topLate: topLate.slice(0, 5),
    byBranch: byBranch.map(({ _sched, ...rest }) => rest),
    lateByBucket
  };
}
