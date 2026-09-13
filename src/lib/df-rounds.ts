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
import { computeDoctorFees, dfWeeklyStartMonday } from "./df-db";
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
};

export type DfRoundDoctor = {
  user_id: number; display_name: string; title_prefix: string | null;
  workedDays: number; grossFee: number; whtRate: number; whtAmount: number; netFee: number;
};

// One row per day of the Mon–Sun week: the day's HSC revenue pool, the DF it
// earns, and how many bills (invoices) it came from — the revshare-style daily
// view (owner 2026-09-13).
export type DfDayRow = { date: string; pool: number; fee: number; bills: number };

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
    `SELECT user_id, display_name, worked_days, gross_fee, wht_rate, wht_amount, net_fee
     FROM df_round_lines WHERE round_id = ? ORDER BY net_fee DESC`
  ).all(roundId) as DfRoundLine[];
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
  const out: DfDayRow[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDaysIso(weekStart, i);
    const d = byDay.get(date);
    out.push({ date, pool: round2(d?.pool ?? 0), fee: round2(d?.fee ?? 0), bills: d?.bills.size ?? 0 });
  }
  return out;
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

// ── Preview (live compute) ────────────────────────────────────────

export function previewDfRound(branchId: number, weekStartInput: string): DfRoundPreview {
  const weekStart = mondayOf(weekStartInput);
  const weekEnd = sundayOf(weekStart);
  const res = computeDoctorFees(branchId, weekStart, weekEnd);
  const meta = dfMetaFor(res.doctors.map((d) => d.user_id));

  // Only pay doctors who are actually on DF compensation for this week.
  // computeDoctorFees also surfaces clinic doctors who are NOT on DF (still
  // salaried / paid ค่าเวร in payroll) — paying those here would double-pay, since
  // payroll only zeroes base pay for df_started_at doctors. Gate on the same
  // MONTH granularity as payroll's dfActive (period month >= df_started_at month)
  // so a doctor is paid in exactly one place with no boundary gap or overlap.
  const weekMonth = weekStart.slice(0, 7);
  const doctors: DfRoundDoctor[] = res.doctors
    .filter((d) => { const s = meta.get(d.user_id)?.startedAt; return s != null && s.slice(0, 7) <= weekMonth; })
    .map((d) => {
      const whtRate = meta.get(d.user_id)?.wht ?? 0;
      const grossFee = round2(d.totalFee);
      const whtAmount = round2(grossFee * whtRate);
      const netFee = round2(grossFee - whtAmount);
      return {
        user_id: d.user_id, display_name: d.display_name, title_prefix: d.title_prefix,
        workedDays: d.workedDays, grossFee, whtRate, whtAmount, netFee
      };
    });

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
      ? frozen.map((l) => ({ user_id: l.user_id, display_name: l.display_name, title_prefix: null, workedDays: l.worked_days, grossFee: l.gross_fee, whtRate: l.wht_rate, whtAmount: l.wht_amount, netFee: l.net_fee }))
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
      `INSERT INTO df_round_lines (round_id, user_id, display_name, worked_days, gross_fee, wht_rate, wht_amount, net_fee)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const d of p.doctors) {
      insL.run(roundId, d.user_id, nameWithPrefix(d.title_prefix, d.display_name), d.workedDays, d.grossFee, d.whtRate, d.whtAmount, d.netFee);
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
