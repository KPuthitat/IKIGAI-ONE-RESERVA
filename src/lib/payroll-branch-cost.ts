// Per-branch labour-cost allocation for a company-wide payroll round
// (owner 2026-09-02). When a full-time employee's salary is computed ONCE across
// the whole company, the cost still has to land on each branch's books as the
// real operating cost of where the person actually worked. This splits an amount
// (base salary, OT, …) across branches by the number of days the person clocked
// in at each — a split day (two branches in one day) is divided by the minutes
// worked at each that day. Read-only: pure allocation, no writes.

import type Database from "better-sqlite3";
import { pairShifts } from "./payroll-compute";

function bkkDate(iso: string): string {
  return new Date(new Date(iso).getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

// Per-branch "day weight" for a user over [startYmd, endYmd]. A full day at one
// branch = weight 1; a split day is shared by the minute-fraction worked at each
// branch. Summed over the period, a branch's weight == the number of days worked
// there. A payroll_day_branch override reattributes an entire day to one branch.
export function laborDayWeightsByBranch(
  db: Database.Database, userId: number, startYmd: string, endYmd: string
): Map<number, number> {
  const fromIso = new Date(`${startYmd}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${endYmd}T23:59:59+07:00`).toISOString();
  const entries = db.prepare(
    "SELECT ts, type, branch_id FROM time_entries WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC"
  ).all(userId, fromIso, toIso) as Array<{ ts: string; type: "in" | "out"; branch_id: number | null }>;

  // Pair in/out PER BRANCH (a clock-out pairs with that branch's clock-in), then
  // bucket the worked minutes by (date, branch).
  const byBranch = new Map<number, Array<{ user_id: number; ts: string; type: "in" | "out" }>>();
  for (const e of entries) {
    if (e.branch_id == null) continue;
    let list = byBranch.get(e.branch_id);
    if (!list) { list = []; byBranch.set(e.branch_id, list); }
    list.push({ user_id: userId, ts: e.ts, type: e.type });
  }
  const minutesByDateBranch = new Map<string, number>();  // `${date}|${branch}` → minutes
  for (const [branch, es] of byBranch) {
    for (const s of pairShifts(es).shifts) {
      const key = `${bkkDate(s.startTs)}|${branch}`;
      minutesByDateBranch.set(key, (minutesByDateBranch.get(key) ?? 0) + s.durationMinutes);
    }
  }

  // Per-day branch reattribution — a whole day moved to a chosen branch.
  const ovByDate = new Map<string, number>();
  for (const o of db.prepare(
    "SELECT work_date, branch_id FROM payroll_day_branch WHERE user_id = ? AND work_date >= ? AND work_date <= ?"
  ).all(userId, startYmd, endYmd) as Array<{ work_date: string; branch_id: number }>) {
    ovByDate.set(o.work_date, o.branch_id);
  }

  // date → (branch → minutes), applying overrides.
  const dateMap = new Map<string, Map<number, number>>();
  for (const [key, min] of minutesByDateBranch) {
    const sep = key.indexOf("|");
    const date = key.slice(0, sep);
    const branch = ovByDate.get(date) ?? Number(key.slice(sep + 1));
    let bm = dateMap.get(date);
    if (!bm) { bm = new Map(); dateMap.set(date, bm); }
    bm.set(branch, (bm.get(branch) ?? 0) + min);
  }

  const weights = new Map<number, number>();
  for (const bm of dateMap.values()) {
    let total = 0;
    for (const m of bm.values()) total += m;
    if (total <= 0) continue;
    for (const [branch, m] of bm) weights.set(branch, (weights.get(branch) ?? 0) + m / total);
  }
  return weights;
}

// Split `amount` across branches by the day weights above. Rounding drift is
// absorbed by the largest share so the parts always sum back to `amount`.
export function allocateLaborCostByBranch(
  db: Database.Database, userId: number, startYmd: string, endYmd: string, amount: number
): Array<{ branchId: number; amount: number }> {
  if (!(amount > 0)) return [];
  const weights = laborDayWeightsByBranch(db, userId, startYmd, endYmd);
  let total = 0;
  for (const w of weights.values()) total += w;
  if (total <= 0) return [];
  const out = [...weights].map(([branchId, w]) => ({ branchId, amount: round2(amount * w / total) }));
  const drift = round2(amount - out.reduce((s, o) => s + o.amount, 0));
  if (drift !== 0 && out.length > 0) {
    out.sort((a, b) => b.amount - a.amount);
    out[0].amount = round2(out[0].amount + drift);
  }
  return out;
}
