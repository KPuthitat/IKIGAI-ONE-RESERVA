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
import { notifyCustomer, notifyStaff } from "@/lib/line";
import { purgeOldBookings } from "@/lib/retention";
import { bookingStartMs } from "@/lib/time";
import { autoExpireStaleBookings } from "@/lib/stale-bookings";

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token");
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const branches = db.prepare("SELECT * FROM branches").all() as Branch[];
  let remindersSent = 0;

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
    auto_no_show: autoNoShow,
    purged_old_bookings: purged
  });
}

// อนุญาต GET เผื่อใช้ทดสอบจาก browser ตอน dev (มี token เหมือนกัน)
export async function GET(req: Request) {
  return POST(req);
}
