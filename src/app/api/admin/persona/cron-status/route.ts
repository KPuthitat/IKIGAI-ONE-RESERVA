import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { isDailySummaryDue } from "@/lib/daily-attendance-summary";

// GET /api/admin/persona/cron-status
//
// Diagnostic endpoint for "why isn't the daily attendance summary
// (or any other scheduled thing) firing?". Returns:
//   • last_cron_run_at — when the external scheduler last POST'd
//     to /api/cron. Stale / null = the scheduler isn't hitting us,
//     which is the most common reason ANYTHING fails to auto-fire.
//   • For each branch: the daily-summary configuration + the exact
//     reason it would or wouldn't fire RIGHT NOW.
//
// Admin can hit this in a browser tab (must be logged in as admin)
// and read the JSON directly — no special UI needed for the first
// pass. Pure read-only, no side effects.

type BranchDiagnosis = {
  branch_id: number;
  branch_slug: string;
  branch_name: string;
  status: string;
  attendance_summary_time: string | null;
  attendance_summary_last_sent_date: string | null;
  due_now: boolean;
  reason: string;
};

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const db = getDb();
  const sys = db.prepare(
    "SELECT last_cron_run_at FROM system_settings WHERE id = 1"
  ).get() as { last_cron_run_at: string | null } | undefined;

  const nowMs = Date.now();
  const lastRunAt = sys?.last_cron_run_at ?? null;
  const ageMinutes = lastRunAt
    ? Math.round((nowMs - new Date(lastRunAt).getTime()) / 60_000)
    : null;

  // Bangkok-local now — same calculation the cron handler uses.
  const nowBkk = new Date(nowMs + 7 * 60 * 60 * 1000);
  const todayBkk = nowBkk.toISOString().slice(0, 10);
  const nowHhmmBkk = nowBkk.toISOString().slice(11, 16);

  const branches = db.prepare("SELECT * FROM branches").all() as Branch[];
  const perBranch: BranchDiagnosis[] = branches.map((b) => {
    let reason = "";
    if (b.status === "closed") {
      reason = `branch.status = '${b.status}' — closed branches are skipped`;
    } else if (!b.attendance_summary_time) {
      reason = "attendance_summary_time is NULL — admin hasn't enabled the daily summary for this branch (set HH:MM in /admin/persona/settings)";
    } else if (b.attendance_summary_last_sent_date === todayBkk) {
      reason = `last_sent_date = today (${todayBkk}) — already sent. Will refire tomorrow.`;
    } else if (nowHhmmBkk < b.attendance_summary_time) {
      reason = `now ${nowHhmmBkk} (Bangkok) < configured time ${b.attendance_summary_time}. Will fire at or after that time.`;
    } else {
      reason = `DUE NOW — will send on the next cron tick (next POST /api/cron)`;
    }
    return {
      branch_id: b.id,
      branch_slug: b.slug,
      branch_name: b.name,
      status: b.status,
      attendance_summary_time: b.attendance_summary_time,
      attendance_summary_last_sent_date: b.attendance_summary_last_sent_date,
      due_now: isDailySummaryDue(b, nowHhmmBkk, todayBkk),
      reason
    };
  });

  // Sanity check the cron-secret config so admin can confirm the env
  // is set without leaking the value. Only reports presence.
  const cronSecretSet = !!process.env.CRON_SECRET;

  return NextResponse.json({
    now_iso: new Date().toISOString(),
    now_bkk_date: todayBkk,
    now_bkk_hhmm: nowHhmmBkk,
    cron_secret_set: cronSecretSet,
    last_cron_run_at: lastRunAt,
    last_cron_run_age_minutes: ageMinutes,
    last_cron_run_hint: lastRunAt == null
      ? "NEVER — the external scheduler has not POST'd to /api/cron since this app started. Configure cron-job.org / GitHub Actions / Windows Task Scheduler to POST every 5-10 min with header x-cron-token: <CRON_SECRET>."
      : (ageMinutes != null && ageMinutes > 15)
        ? `Stale (${ageMinutes} min ago) — the external scheduler may have stopped. Expected interval is 5-10 min.`
        : `Healthy (${ageMinutes} min ago)`,
    branches: perBranch
  });
}
