// Mounjaro LINE notifications. Pushes to the employee's own LINE via the
// IKIGAI OS platform OA (น้องฮูก). Best-effort: never throws into the
// request path. Only the real-time doctor-reply notification is wired in
// this phase; scheduled reminders (injection / next-visit / weekly log)
// are a cron follow-up.

import { getDb } from "./db";
import { sendLinePush } from "./line";
import { getPlatformChannel } from "./messaging-channels";

async function pushToEmployee(lineUserId: string, text: string): Promise<void> {
  const token = getPlatformChannel()?.channel_token ?? null;
  if (!token) return;
  await sendLinePush(token, { to: lineUserId, messages: [{ type: "text", text }] });
}

/** Notify the employee that the doctor replied to their self-log. */
export async function notifySelfLogReply(selfLogId: number): Promise<void> {
  try {
    const row = getDb().prepare(`
      SELECT u.line_user_id AS line_user_id
      FROM mounjaro_self_logs sl
      JOIN mounjaro_enrollments e ON e.id = sl.enrollment_id
      JOIN users u ON u.id = e.employee_id
      WHERE sl.id = ?
    `).get(selfLogId) as { line_user_id: string | null } | undefined;
    if (!row?.line_user_id) return;
    await pushToEmployee(
      row.line_user_id,
      "แพทย์ได้ตอบบันทึกอาการของคุณในโครงการ Mounjaro แล้ว — เปิดดูในพอร์ทัล IKIGAI OS"
    );
  } catch { /* best-effort */ }
}
