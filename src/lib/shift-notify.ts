// Per-shift personal LINE reminder — owl-themed Flex card edition.
//
// Each morning at branches.shift_notify_time the cron DMs every staff
// member assigned a roster entry today (or with approved leave covering
// today) to their personal users.line_user_id. An admin can also fire
// it on demand from the roster page.
//
// 2026-05 rewrite — three notification kinds, one Flex per recipient:
//   • work    — regular work shift (one or more position+time rows)
//   • day_off — admin assigned a shift_codes row with kind='day_off'
//   • on_leave — leave_requests covers today (approved)
//
// Token: the personal DM goes through the IKIGAI OS *platform* OA
// (same as clock-in confirmation card). Branch RESERVA OAs are
// customer-facing.
//
// Dedupe: shift_notify_last_sent_date stamped once per day per branch.

import { getDb, getSystemSettings, type Branch } from "./db";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import { sendLinePush, personaShiftReminderFlex } from "./line";

// Local Thai labels for the 8 PDPA leave types — leave-types.ts owns
// the canonical row data but the simple "type → label" mapping is
// inlined here to avoid threading another export.
function leaveLabelTh(type: string | null): string {
  if (!type) return "ลางาน";
  const m: Record<string, string> = {
    sick:           "ลาป่วย",
    personal:       "ลากิจส่วนตัว",
    annual:         "ลาพักร้อน",
    maternity:      "ลาคลอด",
    ordination:     "ลาบวช",
    sterilization:  "ลาทำหมัน",
    pilgrimage:     "ลาประกอบพิธีฮัจญ์",
    military:       "ลารับราชการทหาร"
  };
  return m[type] ?? "ลางาน";
}

// 2026-05-27: expanded from { position, start, end } to include the
// shift CODE (e.g. "NPF", "A") and the position's free-text job
// description. The Flex card now renders them as three distinct rows:
//   green box   = positionTitle (the duty assignment, e.g. "PASTA")
//   shiftCode line = code + time on opposite sides
//   description = subtle italic-ish job description below
// All three already live in the DB (roster_positions.title /
// roster_positions.description / shift_codes.code) — we just weren't
// surfacing them before.
export type ShiftLine = {
  positionTitle: string;
  positionDescription: string | null;
  shiftCode: string;
  start: string;
  end: string;
};

export type ShiftRecipient =
  | { kind: "work"; userId: number; displayName: string; titlePrefix: string | null;
      nickname: string | null; lineUserId: string; shifts: ShiftLine[] }
  | { kind: "day_off"; userId: number; displayName: string; titlePrefix: string | null;
      nickname: string | null; lineUserId: string }
  | { kind: "on_leave"; userId: number; displayName: string; titlePrefix: string | null;
      nickname: string | null; lineUserId: string; leaveType: string };

/** Build per-recipient classification for dateBkk at branch.
 *  Includes only staff with line_user_id bound (can't DM otherwise).
 *  Skip rule: no roster + no leave → truly weekly off, no notification
 *  (admin must assign 'day_off' to surface the "เป็นวันหยุดของพี่" card). */
export function buildShiftRecipients(
  branchId: number,
  dateBkk: string
): ShiftRecipient[] {
  const db = getDb();

  // 1) All staff at branch with LINE — these are the candidates.
  //    nickname_th is the Thai short name (ชื่อเล่น) admin sets per
  //    employee — used for the warm "สวัสดีครับพี่ <ชื่อเล่น>" opener
  //    on the shift card so it feels personal. Falls back to
  //    displayName when nickname is blank.
  const staffRows = db.prepare(`
    SELECT u.id AS user_id, u.display_name, u.title_prefix, u.nickname_th,
           u.line_user_id
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ?
      AND u.role IN ('staff', 'admin')
      AND u.is_test_account = 0
      AND u.line_user_id IS NOT NULL
      AND TRIM(u.line_user_id) <> ''
    ORDER BY u.display_name COLLATE NOCASE ASC
  `).all(branchId) as Array<{
    user_id: number; display_name: string;
    title_prefix: string | null; nickname_th: string | null;
    line_user_id: string;
  }>;
  if (staffRows.length === 0) return [];

  const staffIds = staffRows.map((s) => s.user_id);
  const placeholders = staffIds.map(() => "?").join(",");

  // 2) Roster assignments for today (with shift_code kind + times +
  //    code label + position description so the Flex card can render
  //    them as separate rows — green-box position name, code+time
  //    line, italic job-description line).
  const rosterRows = db.prepare(`
    SELECT a.user_id, sc.kind,
           p.title AS position_title,
           p.description AS position_description,
           p.display_order AS pos_order,
           sc.code AS shift_code,
           sc.start_time, sc.end_time
    FROM roster_assignments a
    JOIN roster_positions p ON p.id = a.position_id
    JOIN shift_codes sc ON sc.id = a.shift_code_id
    WHERE a.branch_id = ?
      AND a.assignment_date = ?
      AND a.user_id IN (${placeholders})
    ORDER BY p.display_order ASC
  `).all(branchId, dateBkk, ...staffIds) as Array<{
    user_id: number; kind: string;
    position_title: string; position_description: string | null;
    pos_order: number;
    shift_code: string;
    start_time: string; end_time: string;
  }>;
  type RosterAgg = { dayOff: boolean; shifts: ShiftLine[] };
  const rosterByUser = new Map<number, RosterAgg>();
  for (const r of rosterRows) {
    let agg = rosterByUser.get(r.user_id);
    if (!agg) {
      agg = { dayOff: false, shifts: [] };
      rosterByUser.set(r.user_id, agg);
    }
    if (r.kind === "day_off") {
      agg.dayOff = true;
    } else {
      agg.shifts.push({
        positionTitle: r.position_title,
        positionDescription: r.position_description,
        shiftCode: r.shift_code,
        start: r.start_time,
        end: r.end_time
      });
    }
  }

  // 3) Approved leaves overlapping today.
  const leaveRows = db.prepare(`
    SELECT user_id, type
    FROM leave_requests
    WHERE status = 'approved'
      AND date_from <= ?
      AND date_to >= ?
      AND user_id IN (${placeholders})
  `).all(dateBkk, dateBkk, ...staffIds) as Array<{ user_id: number; type: string }>;
  const leaveByUser = new Map<number, string>();
  for (const r of leaveRows) leaveByUser.set(r.user_id, r.type);

  // 4) Classify. Priority: on_leave > work > day_off > skip.
  //    Leave wins over a work assignment too — the approved leave is
  //    the truth even if admin forgot to clear the roster.
  const out: ShiftRecipient[] = [];
  for (const s of staffRows) {
    const leaveType = leaveByUser.get(s.user_id) ?? null;
    const nickname = s.nickname_th?.trim() || null;
    if (leaveType) {
      out.push({
        kind: "on_leave",
        userId: s.user_id,
        displayName: s.display_name,
        titlePrefix: s.title_prefix,
        nickname,
        lineUserId: s.line_user_id,
        leaveType
      });
      continue;
    }
    const roster = rosterByUser.get(s.user_id);
    if (roster && roster.shifts.length > 0) {
      out.push({
        kind: "work",
        userId: s.user_id,
        displayName: s.display_name,
        titlePrefix: s.title_prefix,
        nickname,
        lineUserId: s.line_user_id,
        shifts: roster.shifts
      });
      continue;
    }
    // Owner direction 2026-05: an empty roster cell = "วันหยุด
    // ประจำสัปดาห์" by default. Sends the warm day-off card
    // ("วันนี้เป็นวันของพี่") to every active staff who isn't
    // working and isn't on leave today.
    out.push({
      kind: "day_off",
      userId: s.user_id,
      displayName: s.display_name,
      titlePrefix: s.title_prefix,
      nickname,
      lineUserId: s.line_user_id
    });
  }
  return out;
}

/** Friendly Thai date — "วันจันทร์ที่ 26 พฤษภาคม 2569" feels warm + clear.
 *  Used in the Flex card body. The Buddhist year is fine; staff are
 *  bilingual but BE is what they expect in HR contexts. */
function thaiFriendlyDate(dateBkk: string): string {
  const [yStr, mStr, dStr] = dateBkk.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  // Read the weekday off the SAME calendar date. Parsing at Bangkok midnight
  // (+07:00) and calling getDay() on a UTC server rolls back to the previous
  // day → "วันจันทร์ที่ 7" (Mon name + Tue's number). Parse as UTC midnight and
  // read the UTC weekday so name + number always agree (owner 2026-07-06).
  const wd = new Date(`${dateBkk}T00:00:00Z`).getUTCDay();
  const WD = ["วันอาทิตย์","วันจันทร์","วันอังคาร","วันพุธ","วันพฤหัสบดี","วันศุกร์","วันเสาร์"];
  const MO = ["", "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
              "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
  return `${WD[wd]}ที่ ${d} ${MO[m]} ${y + 543}`;
}

/** Send today's (dateBkk) shift reminders to every eligible staff
 *  member's personal LINE as an owl-themed Flex card. Pure side-
 *  effect; never throws. */
export async function sendShiftNotifications(
  branch: Branch,
  dateBkk: string
): Promise<{ sent: number; skipped: number; recipients: number }> {
  const platform = getPlatformChannel();
  if (!isChannelReady(platform) || !platform?.channel_token) {
    return { sent: 0, skipped: 0, recipients: 0 };
  }
  const recipients = buildShiftRecipients(branch.id, dateBkk);
  const friendlyDate = thaiFriendlyDate(dateBkk);
  // Fetch once per send-batch — the greeting picker reads these
  // newline-separated overrides per kind. NULL/empty falls back to
  // DEFAULT_SHIFT_GREETINGS inside lib/line.ts.
  const ss = getSystemSettings();
  const greetingOverrides = {
    work: ss.shift_greetings_work,
    day_off: ss.shift_greetings_day_off,
    on_leave: ss.shift_greetings_on_leave
  };
  let sent = 0;
  let skipped = 0;
  for (const rec of recipients) {
    const flex = personaShiftReminderFlex({
      branchName: branch.name,
      dateLabel: friendlyDate,
      displayName: rec.displayName,
      titlePrefix: rec.titlePrefix,
      nickname: rec.nickname,
      kind: rec.kind,
      shifts: rec.kind === "work" ? rec.shifts : [],
      leaveTypeLabel: rec.kind === "on_leave" ? leaveLabelTh(rec.leaveType) : null,
      headerColor: branch.brand_color,
      dateBkk,
      greetingOverrides
    });
    try {
      const res = await sendLinePush(platform.channel_token, {
        to: rec.lineUserId,
        messages: [flex]
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

/** Auto-send due check (pure). */
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
