/**
 * รัน cron แบบ standalone (ไม่ต้อง deploy):
 *   node --import tsx scripts/cron.ts
 * จะส่ง reminder + cleanup ทันที (เหมาะกับ Windows Task Scheduler รัน 1 ครั้งทุก 5 นาที)
 */

// อ่าน env จาก .env หากมี (ไม่ throw ถ้าไฟล์ไม่มี)
import fs from "node:fs";
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
import { getDb, type Branch, type Booking } from "../src/lib/db";
import { notifyCustomer, notifyStaff } from "../src/lib/line";
import { purgeOldBookings } from "../src/lib/retention";
import { bookingStartMs } from "../src/lib/time";

const db = getDb();
const branches = db.prepare("SELECT * FROM branches").all() as Branch[];

(async () => {
  let remindersSent = 0;
  for (const branch of branches) {
    const reminderWindow = branch.reminder_minutes_before;
    const bookings = db.prepare(`
      SELECT b.* FROM bookings b
      WHERE b.branch_id = ? AND b.status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM notification_log nl
          WHERE nl.booking_id = b.id AND nl.type = 'reminder' AND nl.audience = 'customer' AND nl.status = 'sent'
        )
    `).all(branch.id) as Booking[];
    for (const b of bookings) {
      const minutesUntil = (bookingStartMs(b.booking_date, b.booking_time) - Date.now()) / 60_000;
      if (minutesUntil < reminderWindow - 10 || minutesUntil > reminderWindow + 5) continue;
      const tableLabel = b.table_id
        ? (db.prepare("SELECT label FROM tables WHERE id = ?").get(b.table_id) as { label: string } | undefined)?.label ?? null
        : null;
      await notifyCustomer(branch, b, "reminder");
      await notifyStaff(branch, b, tableLabel, "reminder");
      remindersSent++;
    }
  }
  const purged = purgeOldBookings();
  console.log(`[cron] reminders=${remindersSent} purged=${purged}`);
  process.exit(0);
})();
