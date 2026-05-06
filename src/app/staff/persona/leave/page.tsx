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
    "SELECT id, gender, employment_type, hire_date FROM users WHERE id = ?"
  ).get(user.id) as {
    id: number; gender: string | null; employment_type: string | null; hire_date: string | null;
  };

  const eligibleTypes: LeaveTypeRow[] = getEligibleLeaveTypesForUser(userMeta);
  const quotas: QuotaInfo[] = eligibleTypes.map((t) => getQuotaInfo(user.id, t));

  const requests = db.prepare(`
    SELECT id, type, date_from, date_to, days, hours, reason,
           evidence_filename, status, decided_by, decided_at, decision_note,
           created_by, created_at
    FROM leave_requests
    WHERE user_id = ?
    ORDER BY created_at DESC
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
      userGenderSet={Boolean(userMeta.gender)}
      userEmploymentSet={Boolean(userMeta.employment_type)}
    />
  );
}
