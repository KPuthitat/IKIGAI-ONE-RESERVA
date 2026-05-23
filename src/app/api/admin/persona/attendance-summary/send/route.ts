import { NextResponse } from "next/server";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import {
  buildDailyAttendanceRoster,
  markDailySummarySent
} from "@/lib/daily-attendance-summary";
import {
  dailyAttendanceSummaryFlex,
  notifyToStaffGroup
} from "@/lib/line";

// POST /api/admin/persona/attendance-summary/send
//
// Manual trigger for the daily attendance summary that admin can
// hit when the cron-driven auto-fire hasn't landed (cron service
// down, branch.attendance_summary_time not configured yet, the
// idempotency stamp accidentally set from a test run).
//
// Awaits the LINE push so the response carries a real success /
// failure result the UI can show — unlike the cron route which is
// fire-and-forget. On success we still stamp
// attendance_summary_last_sent_date so the auto-flow won't
// double-send today.
//
// Auth: admin/super_admin in the active branch. No body required;
// always fires for the admin's current branch.

export async function POST() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  }

  const today = todayBkk();
  const rows = buildDailyAttendanceRoster(branch.id, today);
  if (rows.length === 0) {
    return NextResponse.json({
      error: "empty_roster",
      message: "ไม่มีพนักงานในตารางเวรของวันนี้"
    }, { status: 422 });
  }

  const flex = dailyAttendanceSummaryFlex({
    branchName: branch.name,
    reportDate: today,
    rows: rows.map((r) => ({
      displayName: r.displayName,
      category: r.category,
      inTs: r.inTs,
      minutesLate: r.minutesLate,
      leaveType: r.leaveType
    })),
    headerColor: branch.brand_color
  });

  try {
    // notifyToStaffGroup with "global" → uses platform OA + global
    // staff group. Throws on hard LINE failure (token expired, group
    // not joined, quota exceeded) — the catch below converts to a
    // friendly error code for the UI.
    await notifyToStaffGroup(branch, flex, "global");
    markDailySummarySent(branch.id, today);
    return NextResponse.json({
      ok: true,
      rows_sent: rows.length,
      date: today
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    // Detect the LINE monthly-cap error so the UI can show the right
    // copy (same pattern as the shift-reports resend route).
    const isQuotaError = /reached your monthly limit/i.test(msg);
    return NextResponse.json({
      error: isQuotaError ? "monthly_quota_exceeded" : "push_failed",
      message: msg
    }, { status: isQuotaError ? 429 : 500 });
  }
}
