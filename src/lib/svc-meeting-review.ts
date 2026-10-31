// เบี้ยประชุม review for the company service-charge page (owner 2026-10-20): who earned a meeting fee
// from the executive meetings of the month, computed from the minutes actually attended under the current
// rule (50 บาท per full 15 minutes — NOT the amount stored when the attendance ended, which may predate the
// rule), and — when nobody shows — why. Until the approver confirms the month, the amounts proposed here are
// the rule-based ones only; any earlier manual lump sum is shown beside them for reference and is replaced on
// confirm. After confirming, the confirmed (manual) amounts are what is paid.
import { getDb } from "./db";
import { MEETING_FEE_SVC_START_MONTH } from "./payroll-compute";
import { nameWithPrefix } from "./name";
import { bkkHHMM } from "./time";
import { MEETING_FEE_PER_15MIN } from "./exec-meetings";
import { isMeetingFeeConfirmed, listManualMeetingFees } from "./service-charge";

export type MeetingFeePerson = {
  userId: number; name: string; meetings: number; minutes: number;
  rule: number;     // computed from attended minutes, 50 per full 15 minutes
  manual: number;   // a manual lump sum already keyed for the month (0 = none)
  gross: number;    // the amount to pay / propose: confirmed amount, else the rule-based one
};
export type MeetingFeeMeeting = { id: number; title: string; date: string; status: string; invited: number; joined: number; finished: number; feeTotal: number };
/** One invitee's time log for a meeting — what the approver needs to judge the fee (owner 2026-11-01). */
export type MeetingLogNote = "ok" | "open" | "short" | "exempt" | "absent";
export type MeetingLogRow = {
  userId: number; name: string; joinedAt: string | null; endedAt: string | null; minutes: number | null;
  rule: number; note: MeetingLogNote;
};
export type MeetingLog = { id: number; title: string; date: string; rows: MeetingLogRow[] };
export type MeetingFeeReview = {
  confirmed: { by: string | null; at: string } | null; beforeCutover: boolean;
  people: MeetingFeePerson[]; meetings: MeetingFeeMeeting[]; logs: MeetingLog[]; totalGross: number; hasManualToReplace: boolean;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function meetingFeeReview(yearMonth: string, companyId: number): MeetingFeeReview {
  const db = getDb();
  const inCompany = `EXISTS (SELECT 1 FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE ub.user_id = u.id AND b.company_id = ?)`;
  const confirmedOn = isMeetingFeeConfirmed(yearMonth);

  const stats = new Map<number, { meetings: number; minutes: number; rule: number }>();
  try {
    for (const r of db.prepare(`
      SELECT a.user_id AS uid, COUNT(*) AS n, COALESCE(SUM(a.minutes), 0) AS mins, COALESCE(SUM((a.minutes / 15) * ${MEETING_FEE_PER_15MIN}), 0) AS fee
        FROM exec_meeting_attendance a JOIN exec_meetings m ON m.id = a.meeting_id JOIN users u ON u.id = a.user_id
       WHERE a.ended_at IS NOT NULL AND COALESCE(a.minutes, 0) >= 15 AND COALESCE(u.meeting_fee_exempt, 0) = 0
         AND substr(m.meeting_date, 1, 7) = ? AND ${inCompany}
       GROUP BY a.user_id`).all(yearMonth, companyId) as Array<{ uid: number; n: number; mins: number; fee: number }>)
      stats.set(r.uid, { meetings: r.n, minutes: r.mins, rule: round2(r.fee) });
  } catch { /* exec-meeting tables may not exist yet */ }

  const manual = new Map<number, number>();
  const manualAll = listManualMeetingFees(yearMonth);
  if (manualAll.size > 0) {
    const ids = [...manualAll.keys()];
    for (const r of db.prepare(`SELECT u.id FROM users u WHERE u.id IN (${ids.map(() => "?").join(",")}) AND ${inCompany}`).all(...ids, companyId) as Array<{ id: number }>)
      manual.set(r.id, manualAll.get(r.id)!.amount);
  }

  const ids = new Set<number>([...stats.keys(), ...manual.keys()]);
  const nameOf = db.prepare("SELECT display_name, title_prefix FROM users WHERE id = ?");
  const people: MeetingFeePerson[] = [];
  for (const uid of ids) {
    const s = stats.get(uid);
    const man = manual.get(uid) ?? 0;
    const gross = confirmedOn ? man : (s?.rule ?? 0);
    if (gross <= 0 && man <= 0) continue;
    const u = nameOf.get(uid) as { display_name: string; title_prefix: string | null } | undefined;
    people.push({ userId: uid, name: nameWithPrefix(u?.title_prefix ?? null, u?.display_name ?? ""), meetings: s?.meetings ?? 0, minutes: s?.minutes ?? 0, rule: s?.rule ?? 0, manual: man, gross });
  }
  people.sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name, "th"));

  let meetings: MeetingFeeMeeting[] = [];
  try {
    meetings = db.prepare(`
      SELECT m.id, m.title, m.meeting_date AS date, m.status,
             (SELECT COUNT(*) FROM exec_meeting_invitees i WHERE i.meeting_id = m.id) AS invited,
             (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id) AS joined,
             (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id AND a.ended_at IS NOT NULL) AS finished,
             COALESCE((SELECT SUM((a.minutes / 15) * ${MEETING_FEE_PER_15MIN}) FROM exec_meeting_attendance a JOIN users eu ON eu.id = a.user_id
                        WHERE a.meeting_id = m.id AND a.ended_at IS NOT NULL AND COALESCE(a.minutes, 0) >= 15 AND COALESCE(eu.meeting_fee_exempt, 0) = 0), 0) AS feeTotal
        FROM exec_meetings m
       WHERE substr(m.meeting_date, 1, 7) = ?
       ORDER BY m.meeting_date, m.id`).all(yearMonth) as MeetingFeeMeeting[];
  } catch { /* exec-meeting tables may not exist yet */ }

  // Per-person time log of each meeting: everyone invited or who joined, in this company only.
  const logs: MeetingLog[] = [];
  try {
    const att = db.prepare(`
      SELECT a.user_id AS uid, a.joined_at, a.ended_at, a.minutes, COALESCE(u.meeting_fee_exempt, 0) AS exempt
        FROM exec_meeting_attendance a JOIN users u ON u.id = a.user_id
       WHERE a.meeting_id = ? AND ${inCompany}`);
    const inv = db.prepare(`SELECT i.user_id AS uid FROM exec_meeting_invitees i JOIN users u ON u.id = i.user_id WHERE i.meeting_id = ? AND ${inCompany}`);
    for (const m of meetings) {
      const rows = new Map<number, MeetingLogRow>();
      for (const r of att.all(m.id, companyId) as Array<{ uid: number; joined_at: string | null; ended_at: string | null; minutes: number | null; exempt: number }>) {
        const mins = r.minutes ?? null;
        const rule = r.ended_at && !r.exempt && (mins ?? 0) >= 15 ? Math.floor((mins as number) / 15) * MEETING_FEE_PER_15MIN : 0;
        const note: MeetingLogNote = !r.ended_at ? "open" : r.exempt ? "exempt" : (mins ?? 0) < 15 ? "short" : "ok";
        rows.set(r.uid, { userId: r.uid, name: "", joinedAt: r.joined_at, endedAt: r.ended_at, minutes: mins, rule, note });
      }
      for (const r of inv.all(m.id, companyId) as Array<{ uid: number }>)
        if (!rows.has(r.uid)) rows.set(r.uid, { userId: r.uid, name: "", joinedAt: null, endedAt: null, minutes: null, rule: 0, note: "absent" });
      const nm = db.prepare("SELECT display_name, title_prefix FROM users WHERE id = ?");
      const list = [...rows.values()].map((r) => {
        const u = nm.get(r.userId) as { display_name: string; title_prefix: string | null } | undefined;
        return { ...r, name: nameWithPrefix(u?.title_prefix ?? null, u?.display_name ?? "") };
      });
      const order: Record<MeetingLogNote, number> = { ok: 0, short: 1, exempt: 2, open: 3, absent: 4 };
      list.sort((a, b) => order[a.note] - order[b.note] || a.name.localeCompare(b.name, "th"));
      if (list.length > 0) logs.push({ id: m.id, title: m.title, date: m.date, rows: list });
    }
  } catch { /* exec-meeting tables may not exist yet */ }

  let confirmed: MeetingFeeReview["confirmed"] = null;
  if (confirmedOn) {
    const c = db.prepare("SELECT c.confirmed_at AS at, u.display_name AS by FROM svc_meeting_fee_confirmed c LEFT JOIN users u ON u.id = c.confirmed_by WHERE c.year_month = ?").get(yearMonth) as { at: string; by: string | null };
    confirmed = { by: c.by, at: c.at };
  }
  return {
    confirmed, beforeCutover: yearMonth < MEETING_FEE_SVC_START_MONTH,
    people, meetings, logs,
    totalGross: round2(people.reduce((s, p) => s + p.gross, 0)),
    hasManualToReplace: !confirmedOn && people.some((p) => p.manual > 0)
  };
}

/** "HH:MM" in Bangkok for a stored attendance timestamp ("" when none). */
export function logTime(ts: string | null): string { return ts ? bkkHHMM(ts) : ""; }
