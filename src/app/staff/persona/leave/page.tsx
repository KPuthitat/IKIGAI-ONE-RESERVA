import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getEligibleLeaveTypesForUser,
  getQuotaInfo,
  getAllPublicHolidays,
  getYearsOfService,
  countLongLeaveUsageThisYear,
  type LeaveType,
  type LeaveTypeRow,
  type QuotaInfo,
  type PublicHoliday
} from "@/lib/leave";
import LeaveClient, { type LeaveRow } from "./LeaveClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · การลา" };

export default function StaffLeavePage() {
  const user = requireUser();
  const db = getDb();

  const userMeta = db.prepare(
    "SELECT id, gender, employment_type, hire_date, weekly_off_day FROM users WHERE id = ?"
  ).get(user.id) as {
    id: number; gender: string | null; employment_type: string | null;
    hire_date: string | null; weekly_off_day: number | null;
  };

  const eligibleTypes: LeaveTypeRow[] = getEligibleLeaveTypesForUser(userMeta);
  const quotas: QuotaInfo[] = eligibleTypes.map((t) => getQuotaInfo(user.id, t));

  const requests = db.prepare(`
    SELECT r.id, r.type, r.date_from, r.date_to, r.days, r.hours, r.reason,
           r.evidence_filename, r.status, r.decided_by, r.decided_at, r.decision_note,
           r.created_by, r.created_at, r.replaces_id, r.is_special_request,
           (SELECT id FROM leave_requests WHERE replaces_id = r.id ORDER BY id DESC LIMIT 1) AS resubmitted_as_id
    FROM leave_requests r
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
    LIMIT 50
  `).all(user.id) as LeaveRow[];

  const holidays: PublicHoliday[] = getAllPublicHolidays();
  const yearsOfService = getYearsOfService(userMeta.hire_date);
  const longLeaveCount = countLongLeaveUsageThisYear(user.id);

  return (
    <LeaveClient
      eligibleTypes={eligibleTypes.map((t) => t.code as LeaveType)}
      quotas={quotas}
      requests={requests}
      holidays={holidays}
      yearsOfService={yearsOfService}
      longLeaveCount={longLeaveCount}
      weeklyOffDay={userMeta.weekly_off_day}
      userGenderSet={Boolean(userMeta.gender)}
      userEmploymentSet={Boolean(userMeta.employment_type)}
    />
  );
}
