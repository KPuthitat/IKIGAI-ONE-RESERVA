/**
 * Endpoint ที่ external scheduler เรียกทุก 5–10 นาที (cron-job.org / GitHub Actions / Windows Task Scheduler)
 *   POST /api/cron
 *   Header: x-cron-token: <CRON_SECRET>
 *
 * ทำสองอย่าง:
 *   1. ส่ง reminder ก่อนถึงเวลาจอง (รัน window = ภายใน reminder_minutes_before ± 10 นาที, ส่งครั้งเดียวต่อ booking)
 *   2. ลบข้อมูลที่เกินเวลา retention (default 60 วัน)
 */

import { NextResponse } from "next/server";
import { getDb, type Branch, type Booking } from "@/lib/db";
import {
  notifyCustomer,
  notifyStaff,
  notifyToStaffGroup,
  dailyAttendanceSummaryFlex
} from "@/lib/line";
import { purgeOldBookings } from "@/lib/retention";
import { bookingStartMs } from "@/lib/time";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import {
  buildDailyAttendanceRoster,
  isDailySummaryDue,
  markDailySummarySent
} from "@/lib/daily-attendance-summary";

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const branches = db.prepare("SELECT * FROM branches").all() as Branch[];
  let remindersSent = 0;
  let attendanceSummariesSent = 0;

  // ── Daily attendance summary (TC-6) ──────────────────────────────
  // Once per day per branch, at the admin-configured
  // attendance_summary_time, push a 4-category roll-call to the
  // global executive group. Idempotent: isDailySummaryDue() short-
  // circuits on the dedupe column, so this runs as often as the
  // external cron pings us (every 5–10 min) without spamming.
  //
  // Skipped silently when:
  //   • branch hasn't configured attendance_summary_time yet
  //   • we already sent today's summary for that branch
  //   • now is before today's configured time
  //
  // Wrapped in try/catch so a single bad branch can't kill the
  // booking-reminder loop below.
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const todayBkk = nowBkk.toISOString().slice(0, 10);  // YYYY-MM-DD
  const nowHhmmBkk = nowBkk.toISOString().slice(11, 16); // HH:MM
  for (const branch of branches) {
    if (!isDailySummaryDue(branch, nowHhmmBkk, todayBkk)) continue;
    try {
      const rows = buildDailyAttendanceRoster(branch.id, todayBkk);
      // If the branch has zero staff, mark "sent" anyway so we
      // don't keep retrying every 5 minutes for a branch with an
      // empty roster.
      if (rows.length > 0) {
        const flex = dailyAttendanceSummaryFlex({
          branchName: branch.name,
          reportDate: todayBkk,
          rows: rows.map((r) => ({
            displayName: r.displayName,
            category: r.category,
            inTs: r.inTs,
            minutesLate: r.minutesLate,
            leaveType: r.leaveType
          })),
          headerColor: branch.brand_color
        });
        await notifyToStaffGroup(branch, flex, "global");
        attendanceSummariesSent += 1;
      }
      markDailySummarySent(branch.id, todayBkk);
    } catch (e) {
      console.error("daily attendance summary error", branch.slug, e);
    }
  }

  for (const branch of branches) {
    const reminderWindow = branch.reminder_minutes_before;
    // ดึง booking ที่ยัง confirmed และยังไม่เคยส่ง reminder
    const bookings = db.prepare(`
      SELECT b.* FROM bookings b
      WHERE b.branch_id = ? AND b.status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM notification_log nl
          WHERE nl.booking_id = b.id AND nl.type = 'reminder' AND nl.audience = 'customer' AND nl.status = 'sent'
        )
    `).all(branch.id) as Booking[];

    for (const b of bookings) {
      const startMs = bookingStartMs(b.booking_date, b.booking_time);
      const minutesUntil = (startMs - Date.now()) / 60_000;
      // ส่งเมื่อใกล้ถึงเวลาในหน้าต่าง [reminderWindow - 10, reminderWindow + 5]
      if (minutesUntil < reminderWindow - 10 || minutesUntil > reminderWindow + 5) continue;
      const tableLabel = b.table_id
        ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(b.table_id) as { label: string } | undefined)?.label ?? null
        : null;
      try {
        await notifyCustomer(branch, b, "reminder");
        await notifyStaff(branch, b, tableLabel, "reminder");
        remindersSent++;
      } catch (e) {
        console.error("reminder error", e);
      }
    }
  }

  // Stale-booking cleanup — same logic also runs on every admin page load
  // via autoExpireStaleBookings(), so behaviour is consistent whether the
  // external cron is configured or not. Only confirmed bookings auto-flip
  // to no_show; pending_review stays in admin's queue for manual review.
  const { no_show_count: autoNoShow } = autoExpireStaleBookings();

  // retention cleanup
  const purged = purgeOldBookings();

  return NextResponse.json({
    ok: true,
    reminders_sent: remindersSent,
    attendance_summaries_sent: attendanceSummariesSent,
    auto_no_show: autoNoShow,
    purged_old_bookings: purged
  });
}

// อนุญาต GET เผื่อใช้ทดสอบจาก browser ตอน dev (มี token เหมือนกัน)
export async function GET(req: Request) {
  return POST(req);
}
