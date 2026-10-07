// SVC attendance criteria (owner 2026-10-07): ขาด + ลา + สาย รวมกัน ÷ จำนวนวันที่
// ลงตารางไว้ทั้งเดือน, แบ่ง 3 ขั้น — ≤20% ได้เต็ม · 21–50% ได้ครึ่ง · >50% ไม่ได้.
// Computed over the WHOLE company (every branch's roster + clock-ins), because the
// service charge is settled once for the company.
//
// What counts as one event (one per person per day per kind):
//   • ขาด  — a rostered work day (before today) with no clock-in at any company
//            branch and no approved leave covering it. Only for people who clock in.
//   • สาย  — first clock-in of a rostered day more than LATE_GRACE_MINUTES after the
//            shift start, unless that day has an approved late excusal.
//   • ลา   — a rostered day covered by an approved leave that is NOT sick leave, and
//            which is either on a restricted day (weekend / public holiday) or an
//            abnormal leave (filed on/after the leave date, judged by the day the
//            request was FILED, not the day it was approved).
// Any single event can be waived (ยกเว้น) per person/day/kind; waived events do not
// count. Early clock-out is shown nowhere here — it is not part of the criteria.

import { getDb } from "./db";
import { LATE_GRACE_MINUTES } from "./late-detection";
import { approvedExcusedDatesForMonth } from "./late-excusals";
import { SC_TIER_HALF_THRESHOLD_PCT, SC_TIER_NONE_THRESHOLD_PCT, type ScTier } from "./monthly-attendance-stats";

/** First accrual month the attendance criteria decide the SVC payout. Earlier
 *  months were already paid under the old "late minutes > 20%" rule and must keep
 *  reproducing the same figures. */
export const SVC_ATTENDANCE_START_MONTH = "2026-09";

export function svcAttendanceApplies(yearMonth: string): boolean {
  return yearMonth >= SVC_ATTENDANCE_START_MONTH;
}

export type SvcAttendanceKind = "absent" | "late" | "leave";

export type SvcAttendanceEvent = {
  date: string;                 // YYYY-MM-DD
  kind: SvcAttendanceKind;
  detail: string;               // human text, Thai
  minutes?: number;             // late: minutes late
  exempted: boolean;
  exemptReason?: string | null;
};

export type SvcAttendance = {
  userId: number;
  computable: boolean;          // has at least one rostered day
  tracksAttendance: boolean;    // false → no clock → ขาด/สาย can't be judged
  scheduledDays: number;
  absent: number;               // counted (non-waived) events per kind
  late: number;
  leave: number;
  counted: number;              // absent + late + leave
  waived: number;               // events waived by an admin
  pct: number;                  // counted ÷ scheduledDays × 100
  tier: ScTier;
  events: SvcAttendanceEvent[]; // every event, waived or not, by date
};

export function tierOfPct(pct: number): ScTier {
  if (pct > SC_TIER_NONE_THRESHOLD_PCT) return "none";
  if (pct > SC_TIER_HALF_THRESHOLD_PCT) return "half";
  return "full";
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function hhmmToMin(s: string | null | undefined): number | null {
  const m = s ? /^(\d{1,2}):(\d{2})/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const bkkDate = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const bkkMin = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 7 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const isWeekend = (iso: string) => { const k = new Date(`${iso}T00:00:00Z`).getUTCDay(); return k === 0 || k === 6; };

// ── exemptions (per event) ────────────────────────────────────────────────

export function listSvcAttendanceExemptions(yearMonth: string): Map<string, { reason: string | null }> {
  const rows = getDb().prepare(
    "SELECT user_id, event_date, kind, reason FROM svc_attendance_exemptions WHERE year_month = ?"
  ).all(yearMonth) as Array<{ user_id: number; event_date: string; kind: string; reason: string | null }>;
  return new Map(rows.map((r) => [`${r.user_id}:${r.event_date}:${r.kind}`, { reason: r.reason }]));
}

export function setSvcAttendanceExemption(args: {
  userId: number; date: string; kind: SvcAttendanceKind; exempted: boolean; byUserId: number; reason?: string | null;
}): void {
  const db = getDb();
  if (args.exempted) {
    db.prepare(`
      INSERT INTO svc_attendance_exemptions (user_id, event_date, kind, year_month, reason, exempted_by_user_id, exempted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, event_date, kind) DO UPDATE SET
        reason = excluded.reason, exempted_by_user_id = excluded.exempted_by_user_id, exempted_at = excluded.exempted_at
    `).run(args.userId, args.date, args.kind, args.date.slice(0, 7), args.reason ?? null, args.byUserId, new Date().toISOString());
  } else {
    db.prepare("DELETE FROM svc_attendance_exemptions WHERE user_id = ? AND event_date = ? AND kind = ?")
      .run(args.userId, args.date, args.kind);
  }
}

// ── the computation ───────────────────────────────────────────────────────

export function computeSvcAttendance(opts: {
  branchIds: number[];
  yearMonth: string;
  userIds: number[];
  todayIso?: string;            // BKK "today" — ขาด is only judged for days BEFORE it (tests pin this)
}): Map<number, SvcAttendance> {
  const out = new Map<number, SvcAttendance>();
  const { branchIds, yearMonth, userIds } = opts;
  if (branchIds.length === 0 || userIds.length === 0) return out;
  const db = getDb();
  const [yy, mm] = yearMonth.split("-").map(Number);
  const from = `${yearMonth}-01`;
  const to = `${yearMonth}-${String(new Date(Date.UTC(yy, mm, 0)).getUTCDate()).padStart(2, "0")}`;
  const todayIso = opts.todayIso ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const lastAbsentDay = addDays(todayIso, -1) < to ? addDays(todayIso, -1) : to;
  const bph = branchIds.map(() => "?").join(",");
  const uph = userIds.map(() => "?").join(",");

  // Rostered work days (earliest shift start of the day across branches).
  const rosterByUser = new Map<number, Map<string, number | null>>();
  for (const r of db.prepare(`
    SELECT ra.user_id AS uid, ra.assignment_date AS d, MIN(sc.start_time) AS st
      FROM roster_assignments ra JOIN shift_codes sc ON sc.id = ra.shift_code_id
     WHERE sc.kind = 'work' AND ra.branch_id IN (${bph})
       AND ra.assignment_date >= ? AND ra.assignment_date <= ? AND ra.user_id IN (${uph})
     GROUP BY ra.user_id, ra.assignment_date
  `).all(...branchIds, from, to, ...userIds) as Array<{ uid: number; d: string; st: string | null }>) {
    let m = rosterByUser.get(r.uid); if (!m) { m = new Map(); rosterByUser.set(r.uid, m); }
    m.set(r.d, hhmmToMin(r.st));
  }

  const userMeta = new Map<number, { tracks: boolean; hire: string | null }>();
  for (const r of db.prepare(`SELECT id, COALESCE(track_attendance, 1) AS t, hire_date AS h FROM users WHERE id IN (${uph})`)
    .all(...userIds) as Array<{ id: number; t: number; h: string | null }>) {
    userMeta.set(r.id, { tracks: r.t !== 0, hire: r.h ? r.h.slice(0, 10) : null });
  }

  // First clock-in of each day.
  const firstIn = new Map<number, Map<string, string>>();
  const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59.999+07:00`).toISOString();
  for (const r of db.prepare(`
    SELECT user_id AS uid, ts FROM time_entries
     WHERE type = 'in' AND branch_id IN (${bph}) AND ts >= ? AND ts <= ? AND user_id IN (${uph})
     ORDER BY ts
  `).all(...branchIds, fromIso, toIso, ...userIds) as Array<{ uid: number; ts: string }>) {
    let m = firstIn.get(r.uid); if (!m) { m = new Map(); firstIn.set(r.uid, m); }
    const d = bkkDate(r.ts);
    if (!m.has(d)) m.set(d, r.ts);
  }

  // Leave (approved → counts / covers; pending → only a hint on an absent day).
  type Lv = { id: number; type: string; df: string; dt: string; filed: string; status: string };
  const leaveByUser = new Map<number, Lv[]>();
  for (const r of db.prepare(`
    SELECT id, user_id AS uid, type, date_from, date_to, created_at, status FROM leave_requests
     WHERE status IN ('approved', 'pending') AND NOT (date_to < ? OR date_from > ?) AND user_id IN (${uph})
  `).all(from, to, ...userIds) as Array<{ id: number; uid: number; type: string; date_from: string; date_to: string; created_at: string; status: string }>) {
    let a = leaveByUser.get(r.uid); if (!a) { a = []; leaveByUser.set(r.uid, a); }
    a.push({ id: r.id, type: r.type, df: r.date_from.slice(0, 10), dt: r.date_to.slice(0, 10), filed: r.created_at.slice(0, 10), status: r.status });
  }

  const holidays = new Set((db.prepare("SELECT date FROM public_holidays WHERE date >= ? AND date <= ? AND is_workday = 0")
    .all(from, to) as Array<{ date: string }>).map((h) => h.date));
  const excused = approvedExcusedDatesForMonth(db, yearMonth);
  const exemptions = listSvcAttendanceExemptions(yearMonth);

  for (const uid of userIds) {
    const roster = rosterByUser.get(uid) ?? new Map<string, number | null>();
    const meta = userMeta.get(uid) ?? { tracks: true, hire: null };
    const events: SvcAttendanceEvent[] = [];
    const ins = firstIn.get(uid) ?? new Map<string, string>();
    const leaves = leaveByUser.get(uid) ?? [];
    const approved = leaves.filter((l) => l.status === "approved");

    const approvedCover = (d: string) => approved.find((l) => d >= l.df && d <= l.dt);
    const pendingCover = (d: string) => leaves.find((l) => l.status === "pending" && d >= l.df && d <= l.dt);

    for (const [d, startMin] of roster) {
      // ลา — approved, non-sick, restricted day or filed on/after the leave date.
      const cover = approvedCover(d);
      if (cover && cover.type !== "sick") {
        const reasons: string[] = [];
        if (isWeekend(d) || holidays.has(d)) reasons.push("วันที่ขอความร่วมมือไม่ลา (เสาร์-อาทิตย์/วันหยุด)");
        if (cover.filed >= cover.df) reasons.push(`ยื่นลาวันที่ ${cover.filed} (ลากระทันหัน)`);
        if (reasons.length) events.push({ date: d, kind: "leave", detail: `ลา (${cover.type}) · ${reasons.join(" · ")}`, exempted: false });
        continue;                                  // a leave day is never also ขาด/สาย
      }
      if (cover) continue;                          // sick leave: covers the day, counts for nothing
      if (!meta.tracks) continue;                   // no clock → ขาด/สาย cannot be judged
      if (meta.hire && d < meta.hire) continue;
      const inTs = ins.get(d);
      if (!inTs) {
        if (d <= lastAbsentDay) {
          const pend = pendingCover(d);
          events.push({
            date: d, kind: "absent",
            detail: pend ? `ขาด · มีใบลา (${pend.type}) ที่ยังไม่อนุมัติ ยื่นวันที่ ${pend.filed}` : "ขาด · ไม่มีการลงเวลาและไม่มีใบลา",
            exempted: false
          });
        }
      } else if (startMin != null && !excused.get(uid)?.has(d)) {
        const diff = bkkMin(inTs) - startMin;
        if (diff > LATE_GRACE_MINUTES) events.push({ date: d, kind: "late", detail: `สาย ${diff} นาที`, minutes: diff, exempted: false });
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
    for (const e of events) {
      const ex = exemptions.get(`${uid}:${e.date}:${e.kind}`);
      if (ex) { e.exempted = true; e.exemptReason = ex.reason; }
    }
    const counted = events.filter((e) => !e.exempted);
    const scheduledDays = roster.size;
    const rawPct = scheduledDays > 0 ? (counted.length / scheduledDays) * 100 : 0;   // the tier uses the exact value, not the rounded one
    const pct = round1(rawPct);
    out.set(uid, {
      userId: uid,
      computable: scheduledDays > 0,
      tracksAttendance: meta.tracks,
      scheduledDays,
      absent: counted.filter((e) => e.kind === "absent").length,
      late: counted.filter((e) => e.kind === "late").length,
      leave: counted.filter((e) => e.kind === "leave").length,
      counted: counted.length,
      waived: events.length - counted.length,
      pct,
      tier: scheduledDays > 0 ? tierOfPct(rawPct) : "full",
      events
    });
  }
  return out;
}
