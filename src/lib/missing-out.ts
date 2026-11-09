// Forgotten clock-out: block the next clock-in until the warning letter is acknowledged,
// send the letter in the afternoon when the next day is a day off, and keep statistics
// (owner 2026-11-09).
//
//   • Rule: a person who did not clock OUT cannot clock IN again — in every case — until they press
//     รับทราบ (PIN) on the warning letter for that lapse. Filing a certification no longer
//     lifts the block by itself (it still can: the certification form acknowledges the letter).
//   • If the day after the lapse is a day off, the letter goes out in the afternoon (from 13:00,
//     by the 5-minute cron) so it is already acknowledged on the next working day.
//   • missing_out_lapses is the ledger behind the statistics card on the admin discipline page.

import { getDb } from "./db";
import { blockingMissingOutLetter, issueMissingOutLetter } from "./discipline";
import { hasMissingOutCert, priorMissingOutDay } from "./attendance-flags";
import { userHasWorkShiftOn } from "./roster";
import { hasApprovedShiftRequestOn } from "./shift-requests";
import { nameWithPrefix } from "./name";
import { disciplinaryWarningFlex, notifyToStaffGroup, sendLinePush } from "./line";
import { getPlatformChannel, isChannelReady } from "./messaging-channels";
import type { Branch } from "./db";

/** Afternoon letter run starts at this Bangkok time. */
export const LETTER_FROM_HHMM = "13:00";
/** Only lapses this recent get the afternoon letter (older ones surface at the clock-in gate instead). */
export const LETTER_WINDOW_DAYS = 3;

export type ClockInGate = {
  /** The letter the person must acknowledge. */
  warningId: number;
  workDate: string;
  /** The lapse is still open AND no certification has been filed: the person should also file one (not blocking). */
  needsCert: boolean;
};

/** Called on a fresh clock-in. Notices a dangling prior-day clock-out (issuing the letter now if it
 *  does not exist yet) and answers whether an unacknowledged missing-out letter blocks this clock-in. */
export function missingOutClockInGate(userId: number, branchId: number, todayBkk: string): ClockInGate | null {
  const dangling = priorMissingOutDay(userId, branchId, todayBkk);
  if (dangling) issueMissingOutLetter({ branchId, userId, workDate: dangling, via: "clock_in" });
  const w = blockingMissingOutLetter(userId);
  if (!w) return null;
  getDb().prepare(
    "UPDATE missing_out_lapses SET blocked_attempts = blocked_attempts + 1, last_blocked_at = CURRENT_TIMESTAMP WHERE warning_id = ?"
  ).run(w.id);
  const open = dangling === w.workDate;
  return { warningId: w.id, workDate: w.workDate, needsCert: open && !hasMissingOutCert(userId, w.workDate) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_PUBLIC_BASE_URL ?? "https://ikigaimedihealth.com").replace(/\/$/, "");

/** Afternoon run (called from the 5-minute cron): for everyone whose most recent working day ended
 *  without a clock-out and who has NO work shift today, issue the letter (if not issued yet) and send it
 *  once — so they can acknowledge it today and clock in on their next working day. People rostered today
 *  meet the gate at clock-in instead. Safe to call every tick: each lapse is sent at most once. */
export async function sendMissingOutLetters(args: { today: string; hhmm: string }): Promise<{ checked: number; sent: number }> {
  if (args.hhmm < LETTER_FROM_HHMM) return { checked: 0, sent: 0 };
  const db = getDb();
  const since = addDays(args.today, -LETTER_WINDOW_DAYS);
  const sinceIso = new Date(`${since}T00:00:00+07:00`).toISOString();
  const todayIso = new Date(`${args.today}T00:00:00+07:00`).toISOString();
  const cand = db.prepare(
    `SELECT DISTINCT e.user_id, e.branch_id FROM time_entries e JOIN users u ON u.id = e.user_id
      WHERE e.ts >= ? AND e.ts < ? AND e.branch_id IS NOT NULL
        AND u.status NOT IN ('disabled', 'resigned') AND u.role IN ('staff', 'admin') AND u.is_test_account = 0`
  ).all(sinceIso, todayIso) as Array<{ user_id: number; branch_id: number }>;
  let checked = 0, sent = 0;
  const platform = getPlatformChannel();
  for (const c of cand) {
    const day = priorMissingOutDay(c.user_id, c.branch_id, args.today);
    if (!day || day < since) continue;
    if (userHasWorkShiftOn(c.user_id, c.branch_id, args.today) || hasApprovedShiftRequestOn(c.user_id, args.today)) continue;
    checked++;
    const letter = issueMissingOutLetter({ branchId: c.branch_id, userId: c.user_id, workDate: day, via: "afternoon" });
    if (letter.acknowledged || letter.excused) continue;
    const lapse = db.prepare("SELECT letter_sent_at FROM missing_out_lapses WHERE warning_id = ?").get(letter.id) as { letter_sent_at: string | null } | undefined;
    if (lapse?.letter_sent_at) continue;
    const u = db.prepare("SELECT display_name, title_prefix, line_user_id FROM users WHERE id = ?").get(c.user_id) as { display_name: string; title_prefix: string | null; line_user_id: string | null } | undefined;
    const br = db.prepare("SELECT * FROM branches WHERE id = ?").get(c.branch_id) as Branch | undefined;
    const w = db.prepare("SELECT title, ref_no, severity FROM disciplinary_warnings WHERE id = ?").get(letter.id) as { title: string; ref_no: string | null; severity: "verbal" | "written_1" | "written_2" | "final" } | undefined;
    if (!u || !br || !w) continue;
    const flex = disciplinaryWarningFlex({
      branchName: br.name, recipientName: nameWithPrefix(u.title_prefix, u.display_name), severity: w.severity, title: w.title,
      refNo: w.ref_no, staffUrl: `${PUBLIC_BASE}/staff/persona/discipline/${letter.id}`, headerColor: br.brand_color
    });
    try {
      if (u.line_user_id && platform && isChannelReady(platform) && platform.channel_token) {
        const r = await sendLinePush(platform.channel_token, { to: u.line_user_id, messages: [flex] });
        if (!r.ok) { console.warn(`[missing-out] letter push user#${c.user_id} failed: ${r.status} ${r.error}`); continue; }
      } else {
        await notifyToStaffGroup(br, flex, "global");        // not bound to the OA → the staff group, like admin-issued letters
      }
      db.prepare("UPDATE missing_out_lapses SET letter_sent_at = CURRENT_TIMESTAMP WHERE warning_id = ?").run(letter.id);
      sent++;
    } catch (e) { console.warn("[missing-out] letter send failed:", e); }
  }
  return { checked, sent };
}

// ── Statistics ─────────────────────────────────────────────────────────────

export type MissingOutStats = {
  total: number; acknowledged: number; pending: number;
  viaClockIn: number; viaAfternoon: number; viaCertification: number;
  lettersSent: number; blockedAttempts: number;
  avgHoursToAck: number | null;
  byMonth: Array<{ month: string; count: number }>;
  byPerson: Array<{ userId: number; name: string; count: number; pending: number; last: string }>;
};

/** Lapses of one branch in the last `months` months (inclusive of the current one). */
export function missingOutStats(branchId: number, today: string, months = 6): MissingOutStats {
  const db = getDb();
  const [y, m] = today.split("-").map(Number);
  const startMonth = new Date(Date.UTC(y, m - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  const rows = db.prepare(
    `SELECT l.*, u.display_name, u.title_prefix FROM missing_out_lapses l JOIN users u ON u.id = l.user_id
      LEFT JOIN disciplinary_warnings w ON w.id = l.warning_id
      WHERE l.branch_id = ? AND l.work_date >= ? AND (w.id IS NULL OR w.voided_at IS NULL)`
  ).all(branchId, startMonth) as Array<{
    user_id: number; work_date: string; detected_via: string; detected_at: string; letter_sent_at: string | null;
    acknowledged_at: string | null; blocked_attempts: number; display_name: string; title_prefix: string | null;
  }>;
  const out: MissingOutStats = {
    total: rows.length, acknowledged: 0, pending: 0, viaClockIn: 0, viaAfternoon: 0, viaCertification: 0,
    lettersSent: 0, blockedAttempts: 0, avgHoursToAck: null, byMonth: [], byPerson: []
  };
  const hrs: number[] = [];
  const per = new Map<number, { name: string; count: number; pending: number; last: string }>();
  const mon = new Map<string, number>();
  for (let i = 0; i < months; i++) mon.set(new Date(Date.UTC(y, m - 1 - (months - 1) + i, 1)).toISOString().slice(0, 7), 0);
  for (const r of rows) {
    if (r.acknowledged_at) { out.acknowledged++; const h = (Date.parse(r.acknowledged_at.replace(" ", "T") + "Z") - Date.parse(r.detected_at.replace(" ", "T") + "Z")) / 3600_000; if (Number.isFinite(h) && h >= 0) hrs.push(h); } else out.pending++;
    if (r.detected_via === "clock_in") out.viaClockIn++; else if (r.detected_via === "afternoon") out.viaAfternoon++; else out.viaCertification++;
    if (r.letter_sent_at) out.lettersSent++;
    out.blockedAttempts += r.blocked_attempts;
    const k = r.work_date.slice(0, 7); mon.set(k, (mon.get(k) ?? 0) + 1);
    const p = per.get(r.user_id) ?? { name: nameWithPrefix(r.title_prefix, r.display_name), count: 0, pending: 0, last: "" };
    p.count++; if (!r.acknowledged_at) p.pending++; if (r.work_date > p.last) p.last = r.work_date; per.set(r.user_id, p);
  }
  out.avgHoursToAck = hrs.length ? Math.round((hrs.reduce((s, v) => s + v, 0) / hrs.length) * 10) / 10 : null;
  out.byMonth = [...mon.entries()].map(([month, count]) => ({ month, count }));
  out.byPerson = [...per.entries()].map(([userId, v]) => ({ userId, ...v })).sort((a, b) => b.count - a.count || b.last.localeCompare(a.last)).slice(0, 10);
  return out;
}
