// Doctor Fee — weekly payout rounds (owner 2026-09-11). The clinic pays doctors
// a WEEKLY transfer instead of through the monthly payroll. Revenue is imported
// daily into df_invoice_lines (the existing xlsx flow); a round is cut every
// Monday for the previous Mon–Sun week. Each doctor's fee — rate% of that week's
// HSC revenue, split across the doctors on each day's roster (computeDoctorFees)
// — is snapshotted into df_round_lines, WHT is withheld per doctor
// (users.df_wht_rate), the net is transferred, and the round posts to accounta as
// a labour expense + a WHT payable. Paying FREEZES the snapshot so a later
// revenue re-import never silently changes a settled round. One round per
// branch-week; model mirrors the revshare settlement lifecycle.

import { getDb } from "./db";
import { nameWithPrefix } from "./name";
import { computeDoctorFees, dfWeeklyStartMonday, eligibleDoctors, rosterHoursByDoctor } from "./df-db";
import { postDfRoundToAccounta, removeDfRoundFromAccounta } from "./accounta-db";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday (ISO week start) of the week containing `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return addDaysIso(iso, dow === 0 ? -6 : 1 - dow);
}

/** Sunday (ISO week end) of the week whose Monday is `mondayOf(iso)`. */
export function sundayOf(iso: string): string {
  return addDaysIso(mondayOf(iso), 6);
}

/** The Monday AFTER a week — when this round is transferred + booked (owner
 *  2026-09-13: "ตัดรอบ จ–อา จ่ายจันทร์ถัดไป", like part-time). */
export function payMondayFor(weekStartInput: string): string {
  return addDaysIso(mondayOf(weekStartInput), 7);
}

// ── Types ─────────────────────────────────────────────────────────

export type DfRoundStatus = "draft" | "paid";

export type DfRoundRow = {
  id: number; branch_id: number; week_start: string; week_end: string;
  status: DfRoundStatus;
  total_revenue: number; total_fee: number; total_wht: number; total_net: number;
  note: string | null;
  created_by: number | null; created_at: string;
  paid_by: number | null; paid_at: string | null;
};

export type DfRoundLine = {
  user_id: number; display_name: string; worked_days: number;
  gross_fee: number; wht_rate: number; wht_amount: number; net_fee: number;
  is_guarantee: number; guarantee_hours: number; guarantee_amount: number;
  df_earned: number; deficit_before: number; deficit_after: number;
};

export type DfRoundDoctor = {
  user_id: number; display_name: string; title_prefix: string | null;
  workedDays: number; grossFee: number; whtRate: number; whtAmount: number; netFee: number;
  // Guarantee (การันตี) breakdown (owner 2026-09-13). For a guarantee doctor,
  // grossFee is the guarantee-adjusted payout; the fields below show how it was
  // derived. For a plain-DF doctor isGuarantee=false and grossFee = dfEarned.
  isGuarantee: boolean; guaranteeHours: number; guaranteeAmount: number;
  dfEarned: number; deficitBefore: number; deficitAfter: number;
};

// One row per day of the Mon–Sun week: the day's HSC revenue pool, the DF it
// earns, and how many bills (invoices) it came from — the revshare-style daily
// view (owner 2026-09-13).
// Each day carries the rostered doctors who share that day's DF, with each one's
// equal share — so the rounds page can offer a per-doctor "ส่ง LINE" inline
// (owner 2026-09-14).
export type DfDayDoctorMini = { user_id: number; name: string; share: number };
export type DfDayRow = { date: string; pool: number; fee: number; bills: number; doctors: DfDayDoctorMini[] };

export type DfRoundPreview = {
  branchId: number; weekStart: string; weekEnd: string;
  payDate: string;                 // the Monday after — when it's transferred
  totalRevenue: number; totalFee: number; totalWht: number; totalNet: number;
  days: DfDayRow[];                // Mon–Sun daily breakdown (revshare-style)
  totalBills: number;
  doctors: DfRoundDoctor[];
  unassignedFee: number;
  unassignedDays: Array<{ date: string; pool: number; fee: number }>;
  hasRoster: boolean;
  round: DfRoundRow | null;
  // A stored round whose frozen totals no longer match a live recompute (revenue
  // re-imported after the round was cut / paid). Surfaced so the admin can revert
  // + re-cut rather than silently drift.
  stale: boolean;
  // Weeks before the weekly-transfer cutover are still paid via payroll — the UI
  // shows them read-only (cutting one would double-pay).
  cutoverDate: string;
  beforeCutover: boolean;
};

// ── Reads ─────────────────────────────────────────────────────────

export function getRound(branchId: number, weekStart: string): DfRoundRow | null {
  return (getDb().prepare(
    "SELECT * FROM df_rounds WHERE branch_id = ? AND week_start = ?"
  ).get(branchId, mondayOf(weekStart)) as DfRoundRow | undefined) ?? null;
}

export function getRoundById(id: number): DfRoundRow | null {
  return (getDb().prepare("SELECT * FROM df_rounds WHERE id = ?").get(id) as DfRoundRow | undefined) ?? null;
}

export function listRoundLines(roundId: number): DfRoundLine[] {
  return getDb().prepare(
    `SELECT user_id, display_name, worked_days, gross_fee, wht_rate, wht_amount, net_fee,
            is_guarantee, guarantee_hours, guarantee_amount, df_earned, deficit_before, deficit_after
     FROM df_round_lines WHERE round_id = ? ORDER BY net_fee DESC`
  ).all(roundId) as DfRoundLine[];
}

/**
 * The clinic's carried-forward guarantee shortfall for a doctor entering a given
 * week = the deficit_after of that doctor's most recent PAID guarantee round
 * before this week (owner 2026-09-13: the deficit rolls forward indefinitely).
 * 0 when there is no prior paid guarantee round. Draft rounds don't count — only
 * money actually transferred creates a shortfall to recover.
 */
export function guaranteeDeficitBefore(branchId: number, userId: number, weekStart: string): number {
  const row = getDb().prepare(
    `SELECT rl.deficit_after AS d
     FROM df_round_lines rl
     JOIN df_rounds r ON r.id = rl.round_id
     WHERE rl.user_id = ? AND r.branch_id = ? AND r.status = 'paid'
       AND rl.is_guarantee = 1 AND r.week_start < ?
     ORDER BY r.week_start DESC LIMIT 1`
  ).get(userId, branchId, mondayOf(weekStart)) as { d: number } | undefined;
  return row ? round2(row.d) : 0;
}

/** Recent rounds for a branch (newest first), for the list view. */
export function listRounds(branchId: number, limit = 26): DfRoundRow[] {
  return getDb().prepare(
    "SELECT * FROM df_rounds WHERE branch_id = ? ORDER BY week_start DESC LIMIT ?"
  ).all(branchId, limit) as DfRoundRow[];
}

type DfMeta = { wht: number; startedAt: string | null };
function dfMetaFor(userIds: number[]): Map<number, DfMeta> {
  const m = new Map<number, DfMeta>();
  if (userIds.length === 0) return m;
  const rows = getDb().prepare(
    `SELECT id, COALESCE(df_wht_rate, 0) AS r, df_started_at FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
  ).all(...userIds) as Array<{ id: number; r: number; df_started_at: string | null }>;
  for (const row of rows) m.set(row.id, { wht: row.r, startedAt: row.df_started_at });
  return m;
}

// Per-day HSC pool / DF / bill count across the Mon–Sun week (revshare-style
// daily view). Emits all 7 days, zero-filled, so the week reads like the sales
// list. DF per day = Σ line.net × the active rule's rate for its tag; bills =
// distinct invoice numbers that earned a fee.
function dailyBreakdown(branchId: number, weekStart: string): DfDayRow[] {
  const db = getDb();
  const tagRate = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT item_tags, rate FROM df_fee_rules WHERE branch_id = ? AND active = 1"
  ).all(branchId) as Array<{ item_tags: string; rate: number }>) {
    try { for (const t of JSON.parse(r.item_tags) as string[]) tagRate.set(String(t).toUpperCase(), r.rate); }
    catch { /* skip malformed */ }
  }
  const weekEnd = sundayOf(weekStart);
  const lines = db.prepare(
    "SELECT line_date, invoice_no, item_tag, net FROM df_invoice_lines WHERE branch_id = ? AND line_date >= ? AND line_date <= ?"
  ).all(branchId, weekStart, weekEnd) as Array<{ line_date: string; invoice_no: string; item_tag: string; net: number }>;
  const byDay = new Map<string, { pool: number; fee: number; bills: Set<string> }>();
  for (const l of lines) {
    const rate = tagRate.get(l.item_tag);
    if (rate === undefined) continue;
    let d = byDay.get(l.line_date);
    if (!d) { d = { pool: 0, fee: 0, bills: new Set() }; byDay.set(l.line_date, d); }
    d.pool += l.net; d.fee += l.net * rate; d.bills.add(l.invoice_no);
  }
  // Doctor(s) rostered each day + each one's equal share of the day's DF (owner
  // 2026-09-13/14: show who earned it + let the admin send the daily card inline).
  const docByDate = doctorsByDateWithNames(branchId, weekStart, weekEnd);
  const out: DfDayRow[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysIso(weekStart, i);
    const d = byDay.get(date);
    const rawFee = d?.fee ?? 0;
    const docs = docByDate.get(date) ?? [];
    const share = docs.length > 0 ? round2(rawFee / docs.length) : 0;
    out.push({
      date, pool: round2(d?.pool ?? 0), fee: round2(rawFee), bills: d?.bills.size ?? 0,
      doctors: docs.map((x) => ({ user_id: x.user_id, name: x.name, share }))
    });
  }
  return out;
}

// date → rostered doctors (user id + display name with prefix) for the branch's
// work shifts.
function doctorsByDateWithNames(branchId: number, start: string, end: string): Map<string, Array<{ user_id: number; name: string }>> {
  const rows = getDb().prepare(
    `SELECT DISTINCT ra.assignment_date AS d, ra.user_id AS uid, u.display_name AS name, u.title_prefix AS prefix
     FROM roster_assignments ra
     JOIN shift_codes sc ON sc.id = ra.shift_code_id
     JOIN users u ON u.id = ra.user_id
     WHERE ra.branch_id = ? AND ra.assignment_date >= ? AND ra.assignment_date <= ?
       AND sc.kind = 'work'
       AND (u.clinical_role = 'doctor' OR u.df_started_at IS NOT NULL)
       AND u.status NOT IN ('disabled','resigned','terminated')
     ORDER BY u.display_name`
  ).all(branchId, start, end) as Array<{ d: string; uid: number; name: string; prefix: string | null }>;
  const m = new Map<string, Array<{ user_id: number; name: string }>>();
  for (const r of rows) {
    const a = m.get(r.d) ?? [];
    a.push({ user_id: r.uid, name: nameWithPrefix(r.prefix, r.name) });
    m.set(r.d, a);
  }
  return m;
}

export type DfDayLine = {
  invoice_no: string; item_tag: string; item_code: string | null;
  description: string | null; net: number; fee: number;
};

/** The invoice lines that made up one day's DF — the drill-down under a daily row
 *  (owner 2026-09-13: "ยอด DF ประจำวันเกิดจากยอดใด"). One row per earning line,
 *  newest bills first, with the DF it contributed. */
export function dfDayDetail(branchId: number, date: string): DfDayLine[] {
  const db = getDb();
  const tagRate = new Map<string, number>();
  for (const r of db.prepare(
    "SELECT item_tags, rate FROM df_fee_rules WHERE branch_id = ? AND active = 1"
  ).all(branchId) as Array<{ item_tags: string; rate: number }>) {
    try { for (const t of JSON.parse(r.item_tags) as string[]) tagRate.set(String(t).toUpperCase(), r.rate); }
    catch { /* skip */ }
  }
  const lines = db.prepare(
    `SELECT invoice_no, item_tag, item_code, description, net FROM df_invoice_lines
     WHERE branch_id = ? AND line_date = ? ORDER BY invoice_no`
  ).all(branchId, date) as Array<{ invoice_no: string; item_tag: string; item_code: string | null; description: string | null; net: number }>;
  const out: DfDayLine[] = [];
  for (const l of lines) {
    const rate = tagRate.get(l.item_tag);
    if (rate === undefined) continue;
    out.push({ ...l, fee: round2(l.net * rate) });
  }
  return out;
}

export type DfDayDoctor = {
  user_id: number; display_name: string; title_prefix: string | null;
  dayPool: number; doctorCount: number; share: number;
};

/** Per-doctor DF split for a single day — who was on the roster and each one's
 *  share of that day's DF (owner 2026-09-13, for the daily LINE card). Used by
 *  the day drill-down and the notify route. */
export function dfDayDoctorSplit(branchId: number, date: string): DfDayDoctor[] {
  const res = computeDoctorFees(branchId, date, date);
  return res.doctors.map((d) => {
    const day = d.days.find((x) => x.date === date);
    return {
      user_id: d.user_id, display_name: d.display_name, title_prefix: d.title_prefix,
      dayPool: round2(day?.dayPool ?? 0), doctorCount: day?.doctorCount ?? 1, share: round2(day?.share ?? d.totalFee)
    };
  });
}

// ── Preview (live compute) ────────────────────────────────────────

export function previewDfRound(branchId: number, weekStartInput: string): DfRoundPreview {
  const weekStart = mondayOf(weekStartInput);
  const weekEnd = sundayOf(weekStart);
  const res = computeDoctorFees(branchId, weekStart, weekEnd);

  // Raw DF earned per doctor this week (roster-split), keyed by user id.
  const dfByUser = new Map<number, { D: number; workedDays: number; display_name: string; title_prefix: string | null }>();
  for (const d of res.doctors) {
    dfByUser.set(d.user_id, { D: round2(d.totalFee), workedDays: d.workedDays, display_name: d.display_name, title_prefix: d.title_prefix });
  }

  // Guarantee settings + names for the eligible doctors, and their rostered hours
  // this week (the guarantee is rate/hr × ชั่วโมงตามตารางเวร).
  const elig = eligibleDoctors();
  const eligById = new Map(elig.map((e) => [e.user_id, e]));
  const rosterHours = rosterHoursByDoctor(branchId, weekStart, weekEnd);

  // Who gets paid this week: every doctor who earned DF, PLUS any guarantee doctor
  // rostered this week (they are owed the guarantee even on a zero-revenue week).
  const candidateIds = new Set<number>(dfByUser.keys());
  for (const e of elig) {
    if (e.guarantee_enabled && (rosterHours.get(e.user_id)?.total ?? 0) > 0) candidateIds.add(e.user_id);
  }

  // Only pay doctors who are actually on the weekly DF program for this week.
  // computeDoctorFees also surfaces clinic doctors who are NOT on DF (still
  // salaried / paid ค่าเวร in payroll) — paying those here would double-pay, since
  // payroll only zeroes base pay for df_started_at doctors. Gate on the same
  // MONTH granularity as payroll's dfActive (period month >= df_started_at month)
  // so a doctor is paid in exactly one place with no boundary gap or overlap.
  const weekMonth = weekStart.slice(0, 7);
  const meta = dfMetaFor([...candidateIds]);
  const doctors: DfRoundDoctor[] = [];
  for (const uid of candidateIds) {
    const startedAt = meta.get(uid)?.startedAt;
    if (!(startedAt != null && startedAt.slice(0, 7) <= weekMonth)) continue;
    const e = eligById.get(uid);
    const df = dfByUser.get(uid);
    const D = round2(df?.D ?? 0);
    const display_name = df?.display_name ?? e?.display_name ?? ("#" + uid);
    const title_prefix = df?.title_prefix ?? e?.title_prefix ?? null;

    if (e?.guarantee_enabled) {
      // Guarantee scheme: pay MAX(guarantee, DF), fronting/recovering the deficit.
      const hrs = rosterHours.get(uid);
      const guaranteeHours = round2(hrs?.total ?? 0);
      const guaranteeAmount = round2((e.guarantee_rate || 0) * guaranteeHours);
      const deficitBefore = guaranteeDeficitBefore(branchId, uid, weekStart);
      let grossFee: number, deficitAfter: number;
      if (D >= guaranteeAmount) {
        // DF beat the guarantee — the surplus repays the clinic's earlier support
        // first; only what's left over lands above the guarantee.
        const repay = Math.min(round2(D - guaranteeAmount), deficitBefore);
        grossFee = round2(D - repay);
        deficitAfter = round2(deficitBefore - repay);
      } else {
        // DF fell short — the clinic tops up to the guarantee and carries the gap.
        grossFee = guaranteeAmount;
        deficitAfter = round2(deficitBefore + (guaranteeAmount - D));
      }
      const whtRate = e.guarantee_wht ? (meta.get(uid)?.wht ?? 0) : 0;
      const whtAmount = round2(grossFee * whtRate);
      const netFee = round2(grossFee - whtAmount);
      doctors.push({
        user_id: uid, display_name, title_prefix,
        workedDays: hrs?.byDate.size ?? df?.workedDays ?? 0,
        grossFee, whtRate, whtAmount, netFee,
        isGuarantee: true, guaranteeHours, guaranteeAmount, dfEarned: D,
        deficitBefore, deficitAfter
      });
    } else {
      // Plain DF doctor — unchanged behaviour.
      if (!df) continue;
      const whtRate = meta.get(uid)?.wht ?? 0;
      const grossFee = D;
      const whtAmount = round2(grossFee * whtRate);
      const netFee = round2(grossFee - whtAmount);
      doctors.push({
        user_id: uid, display_name, title_prefix, workedDays: df.workedDays,
        grossFee, whtRate, whtAmount, netFee,
        isGuarantee: false, guaranteeHours: 0, guaranteeAmount: 0, dfEarned: D,
        deficitBefore: 0, deficitAfter: 0
      });
    }
  }
  doctors.sort((a, b) => b.netFee - a.netFee);

  const totalFee = round2(doctors.reduce((s, d) => s + d.grossFee, 0));
  const totalWht = round2(doctors.reduce((s, d) => s + d.whtAmount, 0));
  const totalNet = round2(doctors.reduce((s, d) => s + d.netFee, 0));

  // stale = the stored round's frozen totals no longer match a live recompute —
  // usually a revenue re-import, but also a WHT-rate / df_started_at change. Any
  // of these means the paid figures are out of date; the fix is the same (revert
  // + re-cut), so the flag covers them all.
  const round = getRound(branchId, weekStart);
  const stale = round != null && (
    Math.abs(round.total_fee - totalFee) > 0.005 || Math.abs(round.total_net - totalNet) > 0.005
  );

  const days = dailyBreakdown(branchId, weekStart);
  const totalBills = days.reduce((s, d) => s + d.bills, 0);

  return {
    branchId, weekStart, weekEnd, payDate: payMondayFor(weekStart),
    totalRevenue: round2(res.totalPool), totalFee, totalWht, totalNet,
    days, totalBills,
    doctors,
    unassignedFee: res.unassignedFee, unassignedDays: res.unassignedDays,
    hasRoster: res.hasRoster,
    round, stale,
    cutoverDate: dfWeeklyStartMonday(), beforeCutover: weekStart < dfWeeklyStartMonday()
  };
}

// ── Month view (revshare-style: daily rows + weekly rounds) ───────────

export type DfMonthWeek = {
  weekStart: string; weekEnd: string; payDate: string;
  days: DfDayRow[];                 // this month's days in the week (revenue present)
  shownFee: number; shownRevenue: number; shownBills: number;  // in-month totals (revshare-style subtotal)
  roundFee: number; roundNet: number; roundWht: number;        // FULL Mon–Sun round (what's paid)
  spansMonth: boolean;              // week has days outside the selected month
  unassignedFee: number;            // week has DF revenue on days with no rostered doctor
  doctors: DfRoundDoctor[];
  round: DfRoundRow | null; status: "none" | "draft" | "paid"; stale: boolean; beforeCutover: boolean;
};
export type DfMonthView = {
  year: number; month: number;
  weeks: DfMonthWeek[];
  monthRevenue: number; monthFee: number; monthBills: number;
  cutoverDate: string;
};

/**
 * The whole month as daily rows grouped into Mon–Sun weekly rounds — mirrors the
 * revshare rounds page (owner 2026-09-13). A week is shown when it has a DF day
 * in the month or a stored round touching it; the weekly subtotal is the
 * in-month days (like revshare's transfer subtotal), while the round pays the
 * full Mon–Sun week.
 */
export function buildDfMonthRounds(branchId: number, year: number, month: number): DfMonthView {
  const mm = String(month).padStart(2, "0");
  const first = `${year}-${mm}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
  const db = getDb();

  const mondays = new Set<string>();
  for (const r of db.prepare(
    "SELECT DISTINCT line_date FROM df_invoice_lines WHERE branch_id = ? AND line_date >= ? AND line_date <= ?"
  ).all(branchId, first, last) as Array<{ line_date: string }>) mondays.add(mondayOf(r.line_date));
  for (const r of db.prepare(
    "SELECT week_start FROM df_rounds WHERE branch_id = ? AND week_start >= ? AND week_start <= ?"
  ).all(branchId, mondayOf(first), last) as Array<{ week_start: string }>) mondays.add(r.week_start);

  const weeks: DfMonthWeek[] = [];
  let monthRevenue = 0, monthFee = 0, monthBills = 0;
  for (const wk of [...mondays].sort()) {
    const p = previewDfRound(branchId, wk);
    // Include any day with revenue from a ruled tag (pool > 0), so a 0%-rate day
    // still reconciles the revenue column.
    const inMonth = p.days.filter((d) => d.date >= first && d.date <= last && d.pool > 0);
    const shownFee = round2(inMonth.reduce((s, d) => s + d.fee, 0));
    const shownRevenue = round2(inMonth.reduce((s, d) => s + d.pool, 0));
    const shownBills = inMonth.reduce((s, d) => s + d.bills, 0);
    monthRevenue += shownRevenue; monthFee += shownFee; monthBills += shownBills;
    const spansMonth = p.weekStart < first || p.weekEnd > last;
    // A PAID round shows its FROZEN snapshot (what was actually transferred), not
    // a live recompute — so a later revenue re-import can't change a settled
    // round's displayed figures (the `stale` flag warns of the drift instead).
    const paid = p.round?.status === "paid";
    const frozen = paid ? listRoundLines(p.round!.id) : [];
    const doctors: DfRoundDoctor[] = paid
      ? frozen.map((l) => ({
          user_id: l.user_id, display_name: l.display_name, title_prefix: null,
          workedDays: l.worked_days, grossFee: l.gross_fee, whtRate: l.wht_rate, whtAmount: l.wht_amount, netFee: l.net_fee,
          isGuarantee: l.is_guarantee === 1, guaranteeHours: l.guarantee_hours, guaranteeAmount: l.guarantee_amount,
          dfEarned: l.df_earned, deficitBefore: l.deficit_before, deficitAfter: l.deficit_after
        }))
      : p.doctors;
    weeks.push({
      weekStart: p.weekStart, weekEnd: p.weekEnd, payDate: p.payDate,
      days: inMonth, shownFee, shownRevenue, shownBills,
      roundFee: paid ? p.round!.total_fee : p.totalFee,
      roundNet: paid ? p.round!.total_net : p.totalNet,
      roundWht: paid ? p.round!.total_wht : p.totalWht,
      spansMonth, unassignedFee: p.unassignedFee, doctors,
      round: p.round, status: p.round ? p.round.status : "none", stale: p.stale, beforeCutover: p.beforeCutover
    });
  }
  return {
    year, month, weeks,
    monthRevenue: round2(monthRevenue), monthFee: round2(monthFee), monthBills,
    cutoverDate: dfWeeklyStartMonday()
  };
}

// ── Mutations ─────────────────────────────────────────────────────

/**
 * Cut / re-cut a DRAFT round from the live compute: upsert the df_rounds row and
 * rebuild its per-doctor snapshot. Refuses to touch a round that is already paid
 * (revert it first). Returns the stored round.
 */
export function saveDfRound(branchId: number, weekStartInput: string, userId: number, note?: string | null): DfRoundRow {
  const p = previewDfRound(branchId, weekStartInput);
  // Weekly transfer only covers weeks on/after the cutover; before it the DF is
  // still paid through payroll, so cutting a round would double-pay (owner
  // 2026-09-11). previewDfRound stays available for viewing.
  if (p.weekStart < dfWeeklyStartMonday()) throw new Error("df_before_cutover");
  const db = getDb();
  const existing = getRound(branchId, p.weekStart);
  if (existing && existing.status === "paid") throw new Error("df_round_paid");

  const tx = db.transaction(() => {
    let roundId: number;
    if (existing) {
      db.prepare(
        `UPDATE df_rounds SET week_end = ?, total_revenue = ?, total_fee = ?, total_wht = ?, total_net = ?,
           note = ?, created_by = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(p.weekEnd, p.totalRevenue, p.totalFee, p.totalWht, p.totalNet,
        note !== undefined ? note : existing.note, userId, existing.id);
      roundId = existing.id;
      db.prepare("DELETE FROM df_round_lines WHERE round_id = ?").run(roundId);
    } else {
      const info = db.prepare(
        `INSERT INTO df_rounds (branch_id, week_start, week_end, status, total_revenue, total_fee, total_wht, total_net, note, created_by)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`
      ).run(branchId, p.weekStart, p.weekEnd, p.totalRevenue, p.totalFee, p.totalWht, p.totalNet, note ?? null, userId);
      roundId = Number(info.lastInsertRowid);
    }
    const insL = db.prepare(
      `INSERT INTO df_round_lines
         (round_id, user_id, display_name, worked_days, gross_fee, wht_rate, wht_amount, net_fee,
          is_guarantee, guarantee_hours, guarantee_amount, df_earned, deficit_before, deficit_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of p.doctors) {
      insL.run(roundId, d.user_id, nameWithPrefix(d.title_prefix, d.display_name), d.workedDays,
        d.grossFee, d.whtRate, d.whtAmount, d.netFee,
        d.isGuarantee ? 1 : 0, d.guaranteeHours, d.guaranteeAmount, d.dfEarned, d.deficitBefore, d.deficitAfter);
    }
    return roundId;
  });
  const id = tx();
  return getRoundById(id)!;
}

/**
 * Pay a round: freeze a fresh snapshot, mark it paid, and post it to accounta
 * (labour expense per doctor + WHT payable). Idempotent — paying an already-paid
 * round just re-posts the existing snapshot. Returns the paid round.
 */
export function payDfRound(branchId: number, weekStartInput: string, userId: number): DfRoundRow {
  const weekStart = mondayOf(weekStartInput);
  const db = getDb();
  let round = getRound(branchId, weekStart);

  if (!round || round.status !== "paid") {
    // (Re)build the snapshot from live data, then flip to paid.
    saveDfRound(branchId, weekStart, userId);
    round = getRound(branchId, weekStart)!;
    db.prepare("UPDATE df_rounds SET status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(userId, round.id);
  }
  // Post (or re-post) from the frozen snapshot. Delete-then-insert is idempotent.
  postDfRoundToAccounta(round.id, userId);
  return getRoundById(round.id)!;
}

/**
 * Revert a paid round back to draft and un-post its accounta entries, so it can
 * be re-cut against corrected revenue. No-op-safe if the round is missing.
 */
export function revertDfRound(branchId: number, weekStartInput: string): DfRoundRow | null {
  const round = getRound(branchId, weekStartInput);
  if (!round) return null;
  removeDfRoundFromAccounta(round.id);
  getDb().prepare("UPDATE df_rounds SET status = 'draft', paid_by = NULL, paid_at = NULL WHERE id = ?").run(round.id);
  return getRoundById(round.id);
}
