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
  dailyAttendanceSummaryFlex,
  personaResignationTakenFlex,
  sendLinePush
} from "@/lib/line";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import {
  sweepResignationsToTake,
  sweepResignationPurge
} from "@/lib/resignation-sweep";
import { purgeOldBookings } from "@/lib/retention";
import { bookingStartMs } from "@/lib/time";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";
import {
  buildDailyAttendanceRoster,
  isDailySummaryDue,
  markDailySummarySent
} from "@/lib/daily-attendance-summary";
import {
  sendShiftNotifications,
  isShiftNotifyDue,
  markShiftNotifySent
} from "@/lib/shift-notify";
import { reportError } from "@/lib/error-reporter";
import { expireOldRedemptions } from "@/lib/redemption";
import { escalateStaleTier1, getSystemEscalationHours } from "@/lib/approval-tiers";
import { notifyLeaveEvent } from "@/lib/approval-notify";

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return await runCron();
  } catch (e) {
    // Outer safety net — per-loop try/catch above should handle most
    // failures gracefully, but anything that escapes (db unavailable,
    // OOM, etc.) lands here. Report + still return 500 so the
    // external scheduler logs the failure too.
    console.error("cron top-level error", e);
    reportError(e, "cron top-level", {});
    return NextResponse.json({ ok: false, error: "internal" }, { status: 500 });
  }
}

async function runCron(): Promise<NextResponse> {
  const db = getDb();
  // Stamp the heartbeat right at the top so even partially-failing
  // runs are recorded. Diagnostic page reads this to confirm the
  // external scheduler is actually pinging us.
  db.prepare("UPDATE system_settings SET last_cron_run_at = ? WHERE id = 1")
    .run(new Date().toISOString());
  const branches = db.prepare("SELECT * FROM branches").all() as Branch[];
  let remindersSent = 0;
  let attendanceSummariesSent = 0;
  let shiftNotificationsSent = 0;

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
            titlePrefix: r.titlePrefix,
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
      reportError(e, "cron daily-attendance-summary", {
        branchSlug: branch.slug,
        branchId: branch.id,
        date: todayBkk
      });
    }
  }

  // ── Per-shift personal LINE reminder ─────────────────────────────
  // Once per day per branch, at branches.shift_notify_time, DM every
  // staff member rostered today (to their personal line_user_id)
  // with their shift time + position. Same idempotency model as the
  // attendance summary: isShiftNotifyDue() short-circuits on the
  // dedupe column so repeated cron pings don't re-send.
  for (const branch of branches) {
    if (!isShiftNotifyDue(branch, nowHhmmBkk, todayBkk)) continue;
    try {
      const { sent } = await sendShiftNotifications(branch, todayBkk);
      shiftNotificationsSent += sent;
      // Stamp even when 0 went out (no roster / no LINE bound) so we
      // don't retry every 5 min for an empty day.
      markShiftNotifySent(branch.id, todayBkk);
    } catch (e) {
      console.error("shift notify error", branch.slug, e);
      reportError(e, "cron shift-notify", {
        branchSlug: branch.slug,
        branchId: branch.id,
        date: todayBkk
      });
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
        reportError(e, "cron booking-reminder", {
          branchSlug: branch.slug,
          bookingId: b.id,
          bookingRef: b.ref_no
        });
      }
    }
  }

  // Stale-booking cleanup — same logic also runs on every admin page load
  // via autoExpireStaleBookings(), so behaviour is consistent whether the
  // external cron is configured or not. Only confirmed bookings auto-flip
  // to no_show; pending_review stays in admin's queue for manual review.
  const { no_show_count: autoNoShow } = autoExpireStaleBookings();

  // Redemption expiry sweep — flip still-eligible rows older than
  // 6 hours past their booking_time (or visited_at for walk-ins)
  // to 'expired'. Cheap query, idempotent — runs every cron tick.
  let expiredBookings = 0;
  let expiredWalkIns = 0;
  try {
    const r = expireOldRedemptions();
    expiredBookings = r.bookings;
    expiredWalkIns = r.walkIns;
  } catch (e) {
    console.error("redemption expiry sweep error", e);
    reportError(e, "cron redemption-expiry", {});
  }

  // Tier-1 escalation sweep (2026-05 tier-based rewrite). Any pending
  // leave/resignation row sitting at tier 1 longer than the system-
  // wide escalation window gets bumped to tier 2; tier 2 rows are
  // already at the top so they're not escalated further (they sit
  // until an executive acts). Idempotent — runs every cron tick.
  let escalatedLeave = 0;
  let escalatedResign = 0;
  const escHours = getSystemEscalationHours();
  try {
    const l = escalateStaleTier1("leave_requests", escHours);
    escalatedLeave = l.reassigned;
    // Fire owl notifications to all tier-2 members of each branch
    // where a request just escalated. Fire-and-forget — individual
    // failures don't affect the cron summary.
    for (const ev of l.events) {
      notifyLeaveEvent({
        requestId: ev.requestId,
        event: "escalated"
      }).catch((e) => console.warn("leave notify (escalated) failed", e));
    }
  } catch (e) {
    console.error("leave escalation sweep error", e);
    reportError(e, "cron leave-escalation", {});
  }
  try {
    const r = escalateStaleTier1("resignation_requests", escHours);
    escalatedResign = r.reassigned;
    // Resignation notifications follow the same pattern but the
    // helper is leave-specific for now — track as #38 to extend it.
  } catch (e) {
    console.error("resignation escalation sweep error", e);
    reportError(e, "cron resignation-escalation", {});
  }

  // Resignation auto-close (2026-05-28). When a user's approved
  // resignation's proposed_last_day has passed, flip their account
  // to 'resigned' so login is blocked on the NEXT day. Idempotent —
  // re-runs are no-ops. Then DM each newly-closed user a Flex card
  // confirming + pointing them at the admin if they want to come
  // back. Push uses the platform OA (same channel as clock-in DM /
  // shift reminder); skipped silently when the token isn't ready.
  let resignationsClosed = 0;
  let resignationCloseNotified = 0;
  try {
    const { closed, userIds } = sweepResignationsToTake(todayBkk);
    resignationsClosed = closed;
    if (userIds.length > 0) {
      const platform = getPlatformChannel();
      if (isChannelReady(platform) && platform?.channel_token) {
        for (const uid of userIds) {
          try {
            // Pull display name + LINE id + last_day to render the
            // card. Joining branches → user_branches gives us a
            // contact-admin name for the closing line. NULL admin
            // is fine — the card silently omits that line.
            const u = db.prepare(`
              SELECT u.line_user_id,
                     COALESCE(u.nickname_th, u.display_name) AS recipient_name,
                     (SELECT MAX(r.proposed_last_day) FROM resignation_requests r
                       WHERE r.user_id = u.id AND r.status = 'approved') AS last_day,
                     (SELECT a.display_name FROM user_branches ub
                       JOIN users a ON a.id != u.id
                         AND a.role IN ('admin','super_admin')
                         AND a.status = 'active'
                         AND EXISTS (
                           SELECT 1 FROM user_branches ub2
                            WHERE ub2.user_id = a.id
                              AND ub2.branch_id = ub.branch_id
                              AND ub2.is_admin = 1
                         )
                       WHERE ub.user_id = u.id
                       LIMIT 1) AS admin_name
              FROM users u WHERE u.id = ?
            `).get(uid) as {
              line_user_id: string | null;
              recipient_name: string;
              last_day: string | null;
              admin_name: string | null;
            } | undefined;
            if (!u?.line_user_id || !u.last_day) continue;
            const flex = personaResignationTakenFlex({
              recipientName: u.recipient_name,
              lastDay: u.last_day,
              contactAdminName: u.admin_name
            });
            const r = await sendLinePush(platform.channel_token, {
              to: u.line_user_id, messages: [flex]
            });
            if (r.ok) resignationCloseNotified += 1;
          } catch (e) {
            console.warn("resignation take notify failed for uid", uid, e);
          }
        }
      }
    }
  } catch (e) {
    console.error("resignation auto-close sweep error", e);
    reportError(e, "cron resignation-take", {});
  }

  // 1-year purge — DELETE users whose status='resigned' AND
  // resigned_at older than the retention window. Cascades carry
  // the related rows (sessions/leave/etc) away via FK constraints.
  let resignationsPurged = 0;
  try {
    const { purged } = sweepResignationPurge(todayBkk);
    resignationsPurged = purged;
  } catch (e) {
    console.error("resignation purge sweep error", e);
    reportError(e, "cron resignation-purge", {});
  }

  // retention cleanup
  const purged = purgeOldBookings();

  return NextResponse.json({
    ok: true,
    reminders_sent: remindersSent,
    attendance_summaries_sent: attendanceSummariesSent,
    shift_notifications_sent: shiftNotificationsSent,
    auto_no_show: autoNoShow,
    expired_redemptions_bookings: expiredBookings,
    expired_redemptions_walk_ins: expiredWalkIns,
    escalated_leave_requests: escalatedLeave,
    escalated_resignation_requests: escalatedResign,
    resignations_closed: resignationsClosed,
    resignations_close_notified: resignationCloseNotified,
    resignations_purged: resignationsPurged,
    purged_old_bookings: purged
  });
}

// อนุญาต GET เผื่อใช้ทดสอบจาก browser ตอน dev (มี token เหมือนกัน)
export async function GET(req: Request) {
  return POST(req);
}
