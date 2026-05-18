// Per-shift personal LINE reminder.
//
// Each morning at branches.shift_notify_time the cron DMs every staff
// member who has a roster assignment that day, to their personal
// users.line_user_id, listing the shift time(s) + position(s). An
// admin can also fire it on demand from the roster page (the manual
// endpoint reuses sendShiftNotifications()).
//
// Token: the personal DM goes through the IKIGAI OS *platform* OA
// (the same one the clock-in confirmation card uses) — that's the OA
// staff have added as a friend and whose userId is bound on the
// employee record. Branch RESERVA OAs are customer-facing and can't
// push to staff personal accounts.
//
// Dedupe: shift_notify_last_sent_date (YYYY-MM-DD) — once today's
// batch is sent the column is stamped so subsequent 5-min cron ticks
// are no-ops. Mirrors the daily-attendance-summary pattern.

import { getDb, type Branch } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush } from "./line";

type ShiftLine = { position: string; start: string; end: string };
export type ShiftRecipient = {
  userId: number;
  displayName: string;
  lineUserId: string;
  shifts: ShiftLine[];
};

/** Staff who have at least one roster assignment on dateBkk at the
 *  branch AND have a personal LINE userId bound. One row per user
 *  with every position/shift they're on that day. */
export function buildShiftRecipients(
  branchId: number,
  dateBkk: string
): ShiftRecipient[] {
  const rows = getDb().prepare(`
    SELECT u.id            AS user_id,
           u.display_name  AS display_name,
           u.line_user_id  AS line_user_id,
           p.title         AS position,
           p.display_order AS pos_order,
           s.start_time    AS start_time,
           s.end_time      AS end_time
    FROM roster_assignments a
    JOIN users u           ON u.id = a.user_id
    JOIN roster_positions p ON p.id = a.position_id
    JOIN shift_codes s     ON s.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date = ?
      AND u.line_user_id IS NOT NULL
      AND TRIM(u.line_user_id) <> ''
    ORDER BY u.display_name COLLATE NOCASE ASC, p.display_order ASC
  `).all(branchId, dateBkk) as Array<{
    user_id: number;
    display_name: string;
    line_user_id: string;
    position: string;
    pos_order: number;
    start_time: string;
    end_time: string;
  }>;

  const byUser = new Map<number, ShiftRecipient>();
  for (const r of rows) {
    let rec = byUser.get(r.user_id);
    if (!rec) {
      rec = {
        userId: r.user_id,
        displayName: r.display_name,
        lineUserId: r.line_user_id,
        shifts: []
      };
      byUser.set(r.user_id, rec);
    }
    rec.shifts.push({ position: r.position, start: r.start_time, end: r.end_time });
  }
  return [...byUser.values()];
}

/** YYYY-MM-DD → DD/MM/YYYY for the message (Gregorian, no BE shift —
 *  staff read both fine and it avoids year-conversion confusion). */
function thaiDate(dateBkk: string): string {
  const [y, m, d] = dateBkk.split("-");
  return `${d}/${m}/${y}`;
}

function buildMessage(
  branchName: string,
  dateBkk: string,
  rec: ShiftRecipient
): string {
  const lines = rec.shifts
    .map((s) => `- ${s.position}: ${s.start}–${s.end} น.`)
    .join("\n");
  return (
    `แจ้งเตือนเวรงาน (${thaiDate(dateBkk)})\n` +
    `สวัสดีคุณ ${rec.displayName}\n` +
    `วันนี้คุณมีเวรที่ ${branchName}\n${lines}\n` +
    `กรุณามาตรงเวลาและอย่าลืมลงเวลาเข้างานนะครับ`
  );
}

/** Send today's (dateBkk) shift reminders to every eligible staff
 *  member's personal LINE. Pure side-effect; never throws. Returns
 *  how many messages went out vs. were skipped (push failed). When
 *  the platform OA isn't configured it's a silent no-op. */
export async function sendShiftNotifications(
  branch: Branch,
  dateBkk: string
): Promise<{ sent: number; skipped: number; recipients: number }> {
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) {
    return { sent: 0, skipped: 0, recipients: 0 };
  }
  const recipients = buildShiftRecipients(branch.id, dateBkk);
  let sent = 0;
  let skipped = 0;
  for (const rec of recipients) {
    const text = buildMessage(branch.name, dateBkk, rec);
    try {
      const res = await sendLinePush(platform.channel_token, {
        to: rec.lineUserId,
        messages: [{ type: "text", text }]
      });
      if (res.ok) sent += 1; else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { sent, skipped, recipients: recipients.length };
}

/** Stamp the branch so the rest of today's cron ticks are no-ops. */
export function markShiftNotifySent(branchId: number, dateBkk: string): void {
  getDb().prepare(
    "UPDATE branches SET shift_notify_last_sent_date = ? WHERE id = ?"
  ).run(dateBkk, branchId);
}

/** Auto-send due check (pure). Mirrors isDailySummaryDue:
 *    shift_notify_time NULL/empty   → auto disabled, never due
 *    last_sent_date == today        → already sent, skip
 *    now < configured time          → not yet
 *    else                           → due */
export function isShiftNotifyDue(
  branch: Branch,
  nowHhmmBkk: string,
  todayBkk: string
): boolean {
  const t = branch.shift_notify_time;
  if (!t || !t.trim()) return false;
  if (branch.shift_notify_last_sent_date === todayBkk) return false;
  if (nowHhmmBkk < t) return false;
  return true;
}
