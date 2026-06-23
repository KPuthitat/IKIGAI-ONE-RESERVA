// Revenue-Share GP — server data layer (CRUD + settlement orchestration). Every
// function is scoped to a branch that has revshare_enabled, and every child
// (tiers/floors/rounds/settlements) is checked to belong to a partner in that
// branch. Calc always goes through lib/revshare.ts. Owner 2026-06-22.

import { getDb } from "./db";
import {
  computeSettlement, computeRoundBreakdown, opMonthFor, roundLabel, round2,
  groupDailyIntoWeeks, DEFAULT_TIERS, DEFAULT_FLOORS,
  type Tier, type Floor, type SettlementResult
} from "./revshare";

export type SalesBase = "gross" | "after_discount" | "nett";

export type RsPartner = {
  id: number; branch_id: number; name: string; venue: string | null;
  start_date: string; sales_base: SalesBase; pos_categories: string[];
  vat_enabled: boolean; vat_rate: number; wht_rate: number; active: boolean; note: string | null;
  line_group_id: string | null;
  tax_id: string | null; address: string | null; branch_code: string | null;
};
export type RsRound = {
  id: number; partner_id: number; period_year: number; period_month: number;
  period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
};
export type RsSettlement = SettlementResult & {
  id: number; partner_id: number; settle_year: number; settle_month: number; op_month: number;
  status: "draft" | "issued" | "paid"; invoice_no: string | null;
  issued_at: string | null; paid_at: string | null;
};

// ── scope guards ────────────────────────────────────────────────────
/** True when the branch can use Revenue-Share. Owner 2026-06-23: opened to ALL
 *  branches (was gated to HYPOPLARAEMIA via revshare_enabled) — data is still
 *  scoped per branch, so each branch keeps its own partners. */
export function isRevshareBranch(branchId: number): boolean {
  return !!getDb().prepare("SELECT 1 FROM branches WHERE id = ?").get(branchId);
}
/** Returns the partner row only if it lives in this (enabled) branch. */
function partnerGuard(partnerId: number, branchId: number): { id: number } | null {
  if (!isRevshareBranch(branchId)) return null;
  return getDb().prepare(
    "SELECT id FROM revshare_partners WHERE id = ? AND branch_id = ?"
  ).get(partnerId, branchId) as { id: number } | undefined ?? null;
}

function shapePartner(r: any): RsPartner {
  return {
    id: r.id, branch_id: r.branch_id, name: r.name, venue: r.venue,
    start_date: r.start_date, sales_base: r.sales_base,
    pos_categories: safeJsonArr(r.pos_categories),
    vat_enabled: !!r.vat_enabled, vat_rate: r.vat_rate, wht_rate: r.wht_rate,
    active: !!r.active, note: r.note, line_group_id: r.line_group_id ?? null,
    tax_id: r.tax_id ?? null, address: r.address ?? null, branch_code: r.branch_code ?? null
  };
}
function safeJsonArr(s: string | null): string[] {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

// ── partners ────────────────────────────────────────────────────────
export function listPartners(branchId: number): RsPartner[] {
  if (!isRevshareBranch(branchId)) return [];
  return (getDb().prepare(
    "SELECT * FROM revshare_partners WHERE branch_id = ? ORDER BY active DESC, name COLLATE NOCASE"
  ).all(branchId) as any[]).map(shapePartner);
}

export function getPartner(partnerId: number, branchId: number): RsPartner | null {
  if (!isRevshareBranch(branchId)) return null;
  const r = getDb().prepare(
    "SELECT * FROM revshare_partners WHERE id = ? AND branch_id = ?"
  ).get(partnerId, branchId) as any;
  return r ? shapePartner(r) : null;
}

export type PartnerInput = {
  name: string; venue?: string | null; start_date: string;
  sales_base?: SalesBase; pos_categories?: string[];
  vat_enabled?: boolean; vat_rate?: number; wht_rate?: number; note?: string | null;
  line_group_id?: string | null;
  tax_id?: string | null; address?: string | null; branch_code?: string | null;
};

/** Create a partner + seed the default Groggy tiers/floors (editable after). */
export function createPartner(branchId: number, d: PartnerInput): number | null {
  if (!isRevshareBranch(branchId)) return null;
  const db = getDb();
  const tx = db.transaction(() => {
    const id = Number(db.prepare(`
      INSERT INTO revshare_partners (branch_id, name, venue, start_date, sales_base, pos_categories,
        vat_enabled, vat_rate, wht_rate, note, line_group_id, tax_id, address, branch_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      branchId, d.name.trim(), d.venue ?? null, d.start_date,
      d.sales_base ?? "gross", JSON.stringify(d.pos_categories ?? []),
      d.vat_enabled === false ? 0 : 1, d.vat_rate ?? 0.07, d.wht_rate ?? 0.03, d.note ?? null, d.line_group_id ?? null,
      d.tax_id ?? null, d.address ?? null, d.branch_code ?? null
    ).lastInsertRowid);
    writeTiers(db, id, DEFAULT_TIERS);
    writeFloors(db, id, DEFAULT_FLOORS);
    return id;
  });
  return tx();
}

export function updatePartner(partnerId: number, branchId: number, d: Partial<PartnerInput> & { active?: boolean }): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); vals.push(v); };
  if (d.name !== undefined) put("name", d.name.trim());
  if (d.venue !== undefined) put("venue", d.venue);
  if (d.start_date !== undefined) put("start_date", d.start_date);
  if (d.sales_base !== undefined) put("sales_base", d.sales_base);
  if (d.pos_categories !== undefined) put("pos_categories", JSON.stringify(d.pos_categories));
  if (d.vat_enabled !== undefined) put("vat_enabled", d.vat_enabled ? 1 : 0);
  if (d.vat_rate !== undefined) put("vat_rate", d.vat_rate);
  if (d.wht_rate !== undefined) put("wht_rate", d.wht_rate);
  if (d.note !== undefined) put("note", d.note);
  if (d.line_group_id !== undefined) put("line_group_id", d.line_group_id);
  if (d.tax_id !== undefined) put("tax_id", d.tax_id);
  if (d.address !== undefined) put("address", d.address);
  if (d.branch_code !== undefined) put("branch_code", d.branch_code);
  if (d.active !== undefined) put("active", d.active ? 1 : 0);
  if (!sets.length) return false;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(partnerId);
  return getDb().prepare(`UPDATE revshare_partners SET ${sets.join(", ")} WHERE id = ?`).run(...vals).changes > 0;
}

// ── tiers & floors (replace-all per partner) ────────────────────────
function writeTiers(db: ReturnType<typeof getDb>, partnerId: number, tiers: Tier[]): void {
  db.prepare("DELETE FROM revshare_tiers WHERE partner_id = ?").run(partnerId);
  const ins = db.prepare("INSERT INTO revshare_tiers (partner_id, lower_bound, upper_bound, rate, sort_order) VALUES (?, ?, ?, ?, ?)");
  tiers.forEach((t, i) => ins.run(partnerId, t.lower, t.upper, t.rate, i));
}
function writeFloors(db: ReturnType<typeof getDb>, partnerId: number, floors: Floor[]): void {
  db.prepare("DELETE FROM revshare_floors WHERE partner_id = ?").run(partnerId);
  const ins = db.prepare("INSERT INTO revshare_floors (partner_id, month_from, month_to, floor_amount) VALUES (?, ?, ?, ?)");
  floors.forEach((f) => ins.run(partnerId, f.monthFrom, f.monthTo, f.amount));
}
export function getTiers(partnerId: number): Tier[] {
  return (getDb().prepare(
    "SELECT lower_bound, upper_bound, rate FROM revshare_tiers WHERE partner_id = ? ORDER BY sort_order, lower_bound"
  ).all(partnerId) as any[]).map((r) => ({ lower: r.lower_bound, upper: r.upper_bound, rate: r.rate }));
}
export function getFloors(partnerId: number): Floor[] {
  return (getDb().prepare(
    "SELECT month_from, month_to, floor_amount FROM revshare_floors WHERE partner_id = ? ORDER BY month_from"
  ).all(partnerId) as any[]).map((r) => ({ monthFrom: r.month_from, monthTo: r.month_to, amount: r.floor_amount }));
}
export function replaceTiers(partnerId: number, branchId: number, tiers: Tier[]): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  writeTiers(getDb(), partnerId, tiers);
  return true;
}
export function replaceFloors(partnerId: number, branchId: number, floors: Floor[]): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  writeFloors(getDb(), partnerId, floors);
  return true;
}

// ── rounds ──────────────────────────────────────────────────────────
function shapeRound(r: any): RsRound {
  return {
    id: r.id, partner_id: r.partner_id, period_year: r.period_year, period_month: r.period_month,
    period_start: r.period_start, period_end: r.period_end, label: r.label,
    sales_amount: r.sales_amount, source: r.source, source_filename: r.source_filename
  };
}
export function listRounds(partnerId: number, branchId: number, year: number, month: number): RsRound[] {
  if (!partnerGuard(partnerId, branchId)) return [];
  return (getDb().prepare(
    "SELECT * FROM revshare_rounds WHERE partner_id = ? AND period_year = ? AND period_month = ? ORDER BY period_start"
  ).all(partnerId, year, month) as any[]).map(shapeRound);
}

export type RoundInput = {
  period_start: string; period_end: string; sales_amount: number;
  source?: "manual" | "pos_import"; source_filename?: string | null; label?: string | null;
};
export function createRound(partnerId: number, branchId: number, d: RoundInput, userId: number): number | null {
  if (!partnerGuard(partnerId, branchId)) return null;
  const [y, m] = d.period_start.split("-").map(Number);
  return Number(getDb().prepare(`
    INSERT INTO revshare_rounds (partner_id, period_year, period_month, period_start, period_end,
      label, sales_amount, source, source_filename, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    partnerId, y, m, d.period_start, d.period_end,
    d.label ?? roundLabel(d.period_start, d.period_end), round2(d.sales_amount),
    d.source ?? "manual", d.source_filename ?? null, userId
  ).lastInsertRowid);
}
export function updateRound(roundId: number, partnerId: number, branchId: number, d: { sales_amount?: number; period_start?: string; period_end?: string }): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  const sets: string[] = []; const vals: Array<string | number> = [];
  if (d.sales_amount !== undefined) { sets.push("sales_amount = ?"); vals.push(round2(d.sales_amount)); }
  if (d.period_start !== undefined && d.period_end !== undefined) {
    const [y, m] = d.period_start.split("-").map(Number);
    sets.push("period_start = ?", "period_end = ?", "period_year = ?", "period_month = ?", "label = ?");
    vals.push(d.period_start, d.period_end, y, m, roundLabel(d.period_start, d.period_end));
  }
  if (!sets.length) return false;
  vals.push(roundId, partnerId);
  return getDb().prepare(`UPDATE revshare_rounds SET ${sets.join(", ")} WHERE id = ? AND partner_id = ?`).run(...vals).changes > 0;
}
export function deleteRound(roundId: number, partnerId: number, branchId: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  return getDb().prepare("DELETE FROM revshare_rounds WHERE id = ? AND partner_id = ?").run(roundId, partnerId).changes > 0;
}

function pad2(n: number): string { return String(n).padStart(2, "0"); }
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** Auto weekly rounds (Mon–Sun) clamped to the month, so they partition the
 *  month exactly + the tail becomes the "month-end" round. Skips any round
 *  whose start already exists (idempotent). Returns count created. */
export function generateAutoRounds(partnerId: number, branchId: number, year: number, month: number, userId: number): number {
  if (!partnerGuard(partnerId, branchId)) return 0;
  const db = getDb();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthStart = `${year}-${pad2(month)}-01`;
  const monthEnd = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const existing = new Set((db.prepare(
    "SELECT period_start FROM revshare_rounds WHERE partner_id = ? AND period_year = ? AND period_month = ?"
  ).all(partnerId, year, month) as Array<{ period_start: string }>).map((r) => r.period_start));
  let cur = monthStart;
  let made = 0;
  const tx = db.transaction(() => {
    while (cur <= monthEnd) {
      const dow = new Date(`${cur}T00:00:00Z`).getUTCDay();   // 0=Sun..6=Sat
      const daysToSun = (7 - dow) % 7;
      const weekSun = addDaysIso(cur, daysToSun);
      const end = weekSun <= monthEnd ? weekSun : monthEnd;
      if (!existing.has(cur)) {
        createRound(partnerId, branchId, { period_start: cur, period_end: end, sales_amount: 0, source: "manual" }, userId);
        made++;
      }
      cur = addDaysIso(end, 1);
    }
  });
  tx();
  return made;
}

// ── settlement ──────────────────────────────────────────────────────
export type WeekBreakdown = { label: string; start: string; end: string; sales: number; roundGP: number; gpPct: number };
export type SettlementPreview = {
  result: SettlementResult;
  breakdown: WeekBreakdown[];   // weekly transfer + GP (owner 2026-06-23: daily → weekly → monthly)
  opMonth: number;
  stored: RsSettlement | null;
  stale: boolean;   // a snapshot exists but no longer matches current rounds
};

/** Live-compute the month from current rounds (no write). Also returns any
 *  stored snapshot + whether it's stale (rounds changed since it was saved). */
export function previewSettlement(partnerId: number, branchId: number, year: number, month: number): SettlementPreview | null {
  const partner = getPartner(partnerId, branchId);
  if (!partner) return null;
  const rounds = listRounds(partnerId, branchId, year, month);
  const tiers = getTiers(partnerId);
  const floors = getFloors(partnerId);
  const opMonth = opMonthFor(partner.start_date, year, month);
  const totalSales = rounds.reduce((s, r) => s + r.sales_amount, 0);
  const result = computeSettlement({
    totalSales, opMonth, tiers, floors,
    vatEnabled: partner.vat_enabled, vatRate: partner.vat_rate, whtRate: partner.wht_rate
  });
  // Group the month's daily entries into ISO weeks (= the weekly transfer),
  // then split GP per week via cumulative-difference so weeks sum to the
  // monthly tier GP.
  const weeks = groupDailyIntoWeeks(rounds.map((r) => ({ date: r.period_start, amount: r.sales_amount })));
  const rb = computeRoundBreakdown(weeks.map((w) => w.sales), tiers);
  const breakdown: WeekBreakdown[] = rb.map((row, i) => ({
    label: weeks[i].label, start: weeks[i].start, end: weeks[i].end,
    sales: row.sales, roundGP: row.roundGP, gpPct: row.gpPct
  }));
  const stored = getStoredSettlement(partnerId, branchId, year, month);
  const stale = !!stored && round2(stored.totalSales) !== result.totalSales;
  return { result, breakdown, opMonth, stored, stale };
}

function shapeSettlement(r: any): RsSettlement {
  return {
    id: r.id, partner_id: r.partner_id, settle_year: r.settle_year, settle_month: r.settle_month, op_month: r.op_month,
    totalSales: r.total_sales, tierGP: r.tier_gp, floorApplied: r.floor_applied, topup: r.topup,
    billedGP: r.billed_gp, avgGpPct: r.avg_gp_pct, vatAmount: r.vat_amount, whtAmount: r.wht_amount, netAmount: r.net_amount,
    status: r.status, invoice_no: r.invoice_no, issued_at: r.issued_at, paid_at: r.paid_at
  };
}
export function getStoredSettlement(partnerId: number, branchId: number, year: number, month: number): RsSettlement | null {
  if (!partnerGuard(partnerId, branchId)) return null;
  const r = getDb().prepare(
    "SELECT * FROM revshare_settlements WHERE partner_id = ? AND settle_year = ? AND settle_month = ?"
  ).get(partnerId, year, month) as any;
  return r ? shapeSettlement(r) : null;
}

/** Upsert the snapshot from current rounds. Keeps existing status/invoice when
 *  the row is already issued/paid (just refreshes the numbers — the page warns
 *  before this). A fresh row starts 'draft'. */
export function saveSettlement(partnerId: number, branchId: number, year: number, month: number): RsSettlement | null {
  const preview = previewSettlement(partnerId, branchId, year, month);
  if (!preview) return null;
  const db = getDb();
  const r = preview.result;
  const existing = getStoredSettlement(partnerId, branchId, year, month);
  if (existing) {
    db.prepare(`
      UPDATE revshare_settlements SET op_month = ?, total_sales = ?, tier_gp = ?, floor_applied = ?, topup = ?,
        billed_gp = ?, avg_gp_pct = ?, vat_amount = ?, wht_amount = ?, net_amount = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(preview.opMonth, r.totalSales, r.tierGP, r.floorApplied, r.topup, r.billedGP, r.avgGpPct,
      r.vatAmount, r.whtAmount, r.netAmount, existing.id);
  } else {
    db.prepare(`
      INSERT INTO revshare_settlements (partner_id, settle_year, settle_month, op_month, total_sales, tier_gp,
        floor_applied, topup, billed_gp, avg_gp_pct, vat_amount, wht_amount, net_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(partnerId, year, month, preview.opMonth, r.totalSales, r.tierGP, r.floorApplied, r.topup,
      r.billedGP, r.avgGpPct, r.vatAmount, r.whtAmount, r.netAmount);
  }
  return getStoredSettlement(partnerId, branchId, year, month);
}

export function issueSettlement(partnerId: number, branchId: number, year: number, month: number, invoiceNo: string | null, when: string): boolean {
  const saved = saveSettlement(partnerId, branchId, year, month);   // always recompute on issue
  if (!saved) return false;
  return getDb().prepare(
    "UPDATE revshare_settlements SET status = 'issued', invoice_no = ?, issued_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(invoiceNo, when, saved.id).changes > 0;
}
export function markPaidSettlement(partnerId: number, branchId: number, year: number, month: number, when: string): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  return getDb().prepare(
    "UPDATE revshare_settlements SET status = 'paid', paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE partner_id = ? AND settle_year = ? AND settle_month = ? AND status = 'issued'"
  ).run(when, partnerId, year, month).changes > 0;
}
export function revertSettlement(partnerId: number, branchId: number, year: number, month: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  return getDb().prepare(
    "UPDATE revshare_settlements SET status = 'draft', invoice_no = NULL, issued_at = NULL, paid_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE partner_id = ? AND settle_year = ? AND settle_month = ?"
  ).run(partnerId, year, month).changes > 0;
}
