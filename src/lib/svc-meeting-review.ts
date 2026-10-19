// เบี้ยประชุม review for the company service-charge page (owner 2026-10-20): who earned a meeting fee
// from the executive meetings of the month, and — when nobody shows — why (meeting not ended, nobody
// finished their minutes, month before the cutover). Money comes from meetingFeeByUserCompany so the
// screen, the PDF and the payroll summary can never disagree.
import { getDb } from "./db";
import { MEETING_FEE_SVC_START_MONTH } from "./payroll-compute";
import { meetingFeeByUserCompany } from "./service-charge";

export type MeetingFeePerson = { userId: number; name: string; meetings: number; minutes: number; gross: number; wht: number; net: number };
export type MeetingFeeMeeting = { id: number; title: string; date: string; status: string; invited: number; joined: number; finished: number; feeTotal: number };
export type MeetingFeeReview = { beforeCutover: boolean; people: MeetingFeePerson[]; meetings: MeetingFeeMeeting[]; totalGross: number; totalNet: number };

export function meetingFeeReview(yearMonth: string, companyId: number): MeetingFeeReview {
  const db = getDb();
  const people: MeetingFeePerson[] = [];
  const stats = new Map<number, { meetings: number; minutes: number }>();
  try {
    for (const r of db.prepare(`
      SELECT a.user_id AS uid, COUNT(*) AS n, COALESCE(SUM(a.minutes), 0) AS mins
        FROM exec_meeting_attendance a JOIN exec_meetings m ON m.id = a.meeting_id
       WHERE a.ended_at IS NOT NULL AND a.fee_amount > 0 AND substr(m.meeting_date, 1, 7) = ?
       GROUP BY a.user_id`).all(yearMonth) as Array<{ uid: number; n: number; mins: number }>) stats.set(r.uid, { meetings: r.n, minutes: r.mins });
  } catch { /* exec-meeting tables may not exist yet */ }
  for (const m of meetingFeeByUserCompany(yearMonth).values()) {
    if (m.companyId !== companyId) continue;
    const s = stats.get(m.userId);
    people.push({ userId: m.userId, name: m.displayName, meetings: s?.meetings ?? 0, minutes: s?.minutes ?? 0, gross: m.mtgGross, wht: m.mtgWht, net: m.mtgNet });
  }
  people.sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name, "th"));

  let meetings: MeetingFeeMeeting[] = [];
  try {
    meetings = db.prepare(`
      SELECT m.id, m.title, m.meeting_date AS date, m.status,
             (SELECT COUNT(*) FROM exec_meeting_invitees i WHERE i.meeting_id = m.id) AS invited,
             (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id) AS joined,
             (SELECT COUNT(*) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id AND a.ended_at IS NOT NULL) AS finished,
             COALESCE((SELECT SUM(a.fee_amount) FROM exec_meeting_attendance a WHERE a.meeting_id = m.id AND a.ended_at IS NOT NULL), 0) AS feeTotal
        FROM exec_meetings m
       WHERE substr(m.meeting_date, 1, 7) = ?
       ORDER BY m.meeting_date, m.id`).all(yearMonth) as MeetingFeeMeeting[];
  } catch { /* exec-meeting tables may not exist yet */ }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    beforeCutover: yearMonth < MEETING_FEE_SVC_START_MONTH,
    people, meetings,
    totalGross: round2(people.reduce((s, p) => s + p.gross, 0)),
    totalNet: round2(people.reduce((s, p) => s + p.net, 0))
  };
}
