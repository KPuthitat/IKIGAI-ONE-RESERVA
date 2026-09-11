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
import { computeDoctorFees } from "./df-db";
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

export type DfRoundPreview = {
  branchId: number; weekStart: string; weekEnd: string;
  totalRevenue: number; totalFee: number; totalWht: number; totalNet: number;
  doctors: DfRoundDoctor[];
  unassignedFee: number;
  unassignedDays: Array<{ date: string; pool: number; fee: number }>;
  hasRoster: boolean;
  round: DfRoundRow | null;
  // A stored round whose frozen totals no longer match a live recompute (revenue
  // re-imported after the round was cut / paid). Surfaced so the admin can revert
  // + re-cut rather than silently drift.
  stale: boolean;
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

function whtRatesFor(userIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  if (userIds.length === 0) return m;
  const rows = getDb().prepare(
    `SELECT id, COALESCE(df_wht_rate, 0) AS r FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
  ).all(...userIds) as Array<{ id: number; r: number }>;
  for (const row of rows) m.set(row.id, row.r);
  return m;
}

// ── Preview (live compute) ────────────────────────────────────────

export function previewDfRound(branchId: number, weekStartInput: string): DfRoundPreview {
  const weekStart = mondayOf(weekStartInput);
  const weekEnd = sundayOf(weekStart);
  const res = computeDoctorFees(branchId, weekStart, weekEnd);
  const rates = whtRatesFor(res.doctors.map((d) => d.user_id));

  const doctors: DfRoundDoctor[] = res.doctors.map((d) => {
    const whtRate = rates.get(d.user_id) ?? 0;
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

  const round = getRound(branchId, weekStart);
  const stale = round != null && (
    Math.abs(round.total_fee - totalFee) > 0.005 || Math.abs(round.total_net - totalNet) > 0.005
  );

  return {
    branchId, weekStart, weekEnd,
    totalRevenue: round2(res.totalPool), totalFee, totalWht, totalNet,
    doctors,
    unassignedFee: res.unassignedFee, unassignedDays: res.unassignedDays,
    hasRoster: res.hasRoster,
    round, stale
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
