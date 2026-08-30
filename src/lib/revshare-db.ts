// Revenue-Share GP — server data layer (CRUD + settlement orchestration). Every
// function is scoped to a branch that has revshare_enabled, and every child
// (tiers/floors/rounds/settlements) is checked to belong to a partner in that
// branch. Calc always goes through lib/revshare.ts. Owner 2026-06-22.

import { getDb } from "./db";
import {
  computeSettlement, computeRoundBreakdown, opMonthFor, roundLabel, round2,
  groupDailyIntoWeeks, salesVat, salesBaseIncludesVat, partnerShopName,
  DEFAULT_TIERS, DEFAULT_FLOORS, TH_MONTHS_FULL,
  type Tier, type Floor, type SettlementResult
} from "./revshare";

export type SalesBase = "gross" | "after_discount" | "nett";

export type RsPartner = {
  id: number; branch_id: number; name: string; venue: string | null;
  start_date: string; sales_base: SalesBase; pos_categories: string[];
  vat_enabled: boolean; vat_rate: number; wht_rate: number; active: boolean; note: string | null;
  line_group_id: string | null;
  tax_id: string | null; address: string | null; branch_code: string | null;
  income_branch_id: number | null;
  /** This partner fulfils staff drink-welfare orders (จ้อจี้) — owner 2026-07-30. */
  drink_welfare: boolean;
};
export type RsRound = {
  id: number; partner_id: number; period_year: number; period_month: number;
  period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
  sent_at: string | null; bill_count: number | null;
};
export type RsSettlement = SettlementResult & {
  id: number; partner_id: number; settle_year: number; settle_month: number; op_month: number;
  span_months: number;         // count of covered months (= covered_months.length)
  covered_months: string[];    // exact set of "YYYY-MM" rolled up, includes the anchor (settle month)
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
    tax_id: r.tax_id ?? null, address: r.address ?? null, branch_code: r.branch_code ?? null,
    income_branch_id: r.income_branch_id ?? null,
    drink_welfare: !!r.drink_welfare
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
  income_branch_id?: number | null;
  drink_welfare?: boolean;
};

/** Create a partner + seed the default Groggy tiers/floors (editable after). */
export function createPartner(branchId: number, d: PartnerInput): number | null {
  if (!isRevshareBranch(branchId)) return null;
  const db = getDb();
  const tx = db.transaction(() => {
    const id = Number(db.prepare(`
      INSERT INTO revshare_partners (branch_id, name, venue, start_date, sales_base, pos_categories,
        vat_enabled, vat_rate, wht_rate, note, line_group_id, tax_id, address, branch_code, income_branch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      branchId, d.name.trim(), d.venue ?? null, d.start_date,
      d.sales_base ?? "gross", JSON.stringify(d.pos_categories ?? []),
      d.vat_enabled === false ? 0 : 1, d.vat_rate ?? 0.07, d.wht_rate ?? 0.03, d.note ?? null, d.line_group_id ?? null,
      d.tax_id ?? null, d.address ?? null, d.branch_code ?? null, d.income_branch_id ?? null
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
  if (d.income_branch_id !== undefined) put("income_branch_id", d.income_branch_id);
  if (d.drink_welfare !== undefined) put("drink_welfare", d.drink_welfare ? 1 : 0);
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
    sales_amount: r.sales_amount, source: r.source, source_filename: r.source_filename,
    sent_at: r.sent_at ?? null, bill_count: r.bill_count ?? null
  };
}

/** Stamp a round as sent (idempotent) when its daily card goes out to the
 *  partner group — locks it for edit/delete (owner 2026-07-25). */
export function markRoundSent(roundId: number, partnerId: number, branchId: number, userId: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  return getDb().prepare(
    "UPDATE revshare_rounds SET sent_at = CURRENT_TIMESTAMP, sent_by = ? WHERE id = ? AND partner_id = ?"
  ).run(userId, roundId, partnerId).changes > 0;
}
export function listRounds(partnerId: number, branchId: number, year: number, month: number): RsRound[] {
  if (!partnerGuard(partnerId, branchId)) return [];
  return (getDb().prepare(
    "SELECT * FROM revshare_rounds WHERE partner_id = ? AND period_year = ? AND period_month = ? ORDER BY period_start"
  ).all(partnerId, year, month) as any[]).map(shapeRound);
}

// ── Flexible transfer round (owner 2026-08-01) ──────────────────────────
// The weekly (Mon–Sun) buckets are auto-grouped, but the owner sometimes
// settles a custom span: e.g. a 2-day tail (25–26) is merged with the next
// days and transferred once on the 31st, so the round is 25–31 — possibly
// crossing a month. This settles by an explicit [start, end] date range over
// the DAILY rows (period_start), independent of the calendar-month scope, and
// marks the days transferred so the next round starts from the day after.

/** Latest day already transferred (sent_at stamped) — the cursor for the next
 *  flexible round. null when nothing has been transferred yet. */
export function lastTransferEnd(partnerId: number, branchId: number): string | null {
  if (!partnerGuard(partnerId, branchId)) return null;
  const r = getDb().prepare(
    "SELECT MAX(period_end) AS d FROM revshare_rounds WHERE partner_id = ? AND sent_at IS NOT NULL"
  ).get(partnerId) as { d: string | null } | undefined;
  return r?.d ?? null;
}

/** The most recent daily row's date for this partner (transferred or not). */
export function latestRoundDate(partnerId: number, branchId: number): string | null {
  if (!partnerGuard(partnerId, branchId)) return null;
  const r = getDb().prepare(
    "SELECT MAX(period_end) AS d FROM revshare_rounds WHERE partner_id = ?"
  ).get(partnerId) as { d: string | null } | undefined;
  return r?.d ?? null;
}

/** Daily rows whose day falls in [startIso, endIso] — can cross months. */
export function listRoundsRange(partnerId: number, branchId: number, startIso: string, endIso: string): RsRound[] {
  if (!partnerGuard(partnerId, branchId)) return [];
  return (getDb().prepare(
    "SELECT * FROM revshare_rounds WHERE partner_id = ? AND period_start >= ? AND period_start <= ? ORDER BY period_start"
  ).all(partnerId, startIso, endIso) as any[]).map(shapeRound);
}

export type TransferRoundPreview = {
  partnerName: string; shop: string; label: string;
  start: string; end: string; dayCount: number;
  rows: Array<{ date: string; sales: number; sent: boolean; billCount: number | null }>;
  totalSales: number;
  vatEnabled: boolean;
  vat: { base: number; vat: number; total: number };
  alreadySentCount: number;
  /** Suggested next range = day after the last transferred day → latest data. */
  suggestedStart: string | null;
  suggestedEnd: string | null;
};

/** Live summary of a flexible transfer round for [start, end] — sums the daily
 *  sales and splits the sales-side VAT (honouring the partner's sales_base).
 *  No writes. */
export function previewTransferRound(
  partnerId: number, branchId: number, startIso: string, endIso: string
): TransferRoundPreview | null {
  const partner = getPartner(partnerId, branchId);
  if (!partner) return null;
  const rows = listRoundsRange(partnerId, branchId, startIso, endIso);
  const totalSales = round2(rows.reduce((s, r) => s + r.sales_amount, 0));
  const vatRate = partner.vat_enabled ? partner.vat_rate : 0;
  const vat = salesVat(totalSales, vatRate, salesBaseIncludesVat(partner.sales_base));
  const lastSent = lastTransferEnd(partnerId, branchId);
  const latest = latestRoundDate(partnerId, branchId);
  return {
    partnerName: partner.name, shop: partnerShopName(partner),
    label: roundLabel(startIso, endIso), start: startIso, end: endIso,
    dayCount: Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86400000) + 1,
    rows: rows.map((r) => ({ date: r.period_start, sales: r.sales_amount, sent: !!r.sent_at, billCount: r.bill_count })),
    totalSales, vatEnabled: partner.vat_enabled, vat,
    alreadySentCount: rows.filter((r) => r.sent_at).length,
    suggestedStart: lastSent ? addDaysIso(lastSent, 1) : null,
    suggestedEnd: latest
  };
}

/** Mark every daily row in [start, end] as transferred (keeps an earlier
 *  sent_at when already stamped). Returns how many rows were newly stamped. */
export function sendTransferRound(
  partnerId: number, branchId: number, startIso: string, endIso: string, userId: number
): number {
  if (!partnerGuard(partnerId, branchId)) return 0;
  return getDb().prepare(`
    UPDATE revshare_rounds
    SET sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP), sent_by = COALESCE(sent_by, ?)
    WHERE partner_id = ? AND period_start >= ? AND period_start <= ?
  `).run(userId, partnerId, startIso, endIso).changes;
}

export type RoundInput = {
  period_start: string; period_end: string; sales_amount: number;
  source?: "manual" | "pos_import"; source_filename?: string | null; label?: string | null;
  bill_count?: number | null;
};
export function createRound(partnerId: number, branchId: number, d: RoundInput, userId: number): number | null {
  if (!partnerGuard(partnerId, branchId)) return null;
  const [y, m] = d.period_start.split("-").map(Number);
  return Number(getDb().prepare(`
    INSERT INTO revshare_rounds (partner_id, period_year, period_month, period_start, period_end,
      label, sales_amount, source, source_filename, bill_count, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    partnerId, y, m, d.period_start, d.period_end,
    d.label ?? roundLabel(d.period_start, d.period_end), round2(d.sales_amount),
    d.source ?? "manual", d.source_filename ?? null, d.bill_count ?? null, userId
  ).lastInsertRowid);
}
export function updateRound(roundId: number, partnerId: number, branchId: number, d: { sales_amount?: number; period_start?: string; period_end?: string; bill_count?: number | null }, userId: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  if (d.sales_amount !== undefined) { sets.push("sales_amount = ?"); vals.push(round2(d.sales_amount)); }
  if (d.bill_count !== undefined) { sets.push("bill_count = ?"); vals.push(d.bill_count); }
  if (d.period_start !== undefined && d.period_end !== undefined) {
    const [y, m] = d.period_start.split("-").map(Number);
    sets.push("period_start = ?", "period_end = ?", "period_year = ?", "period_month = ?", "label = ?");
    vals.push(d.period_start, d.period_end, y, m, roundLabel(d.period_start, d.period_end));
  }
  if (!sets.length) return false;
  sets.push("updated_by = ?"); vals.push(userId);
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
  months: string[];             // covered "YYYY-MM" (ascending, always includes the anchor)
  stored: RsSettlement | null;
  stale: boolean;   // a snapshot exists but no longer matches current rounds / covered set
};

// ── month-key helpers (owner 2026-08 redesign) ──────────────────────
// A settlement covers an explicit SET of months, keyed on the anchor (settle
// month) but able to roll up any chosen still-unsettled preceding months. Month
// keys are "YYYY-MM".
function monthKey(y: number, m: number): string { return `${y}-${pad2(m)}`; }
function parseMonthKey(k: string): { y: number; m: number } | null {
  const mm = /^(\d{4})-(\d{2})$/.exec(k);
  if (!mm) return null;
  const y = Number(mm[1]), m = Number(mm[2]);
  return m >= 1 && m <= 12 ? { y, m } : null;
}
function monthsBefore(y: number, m: number, n: number): { y: number; m: number } {
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function sameKeySet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((k) => sb.has(k));
}
/** The set of months a stored row covers: the covered_months JSON when present,
 *  otherwise derived from settle_month + span_months (old contiguous rows). */
function coveredKeysOfRow(r: { settle_year: number; settle_month: number; span_months: number | null; covered_months: string | null }): string[] {
  if (r.covered_months) {
    try {
      const a = JSON.parse(r.covered_months);
      if (Array.isArray(a)) {
        const keys = a.filter((x) => typeof x === "string" && parseMonthKey(x));
        if (keys.length) return keys;
      }
    } catch { /* fall through to span derivation */ }
  }
  const span = Math.max(1, r.span_months ?? 1);
  const keys: string[] = [];
  for (let i = 0; i < span; i++) { const b = monthsBefore(r.settle_year, r.settle_month, i); keys.push(monthKey(b.y, b.m)); }
  return keys;
}

/** Months already rolled up by SOME settlement of this partner (draft/issued/
 *  paid) — the ones that must NOT be re-selectable. Pass the anchor to exclude
 *  its own row so the anchor's current selection isn't blocked against itself. */
export function settledMonthKeys(partnerId: number, branchId: number, exclYear?: number, exclMonth?: number): Set<string> {
  const set = new Set<string>();
  if (!partnerGuard(partnerId, branchId)) return set;
  const rows = getDb().prepare(
    "SELECT settle_year, settle_month, span_months, covered_months FROM revshare_settlements WHERE partner_id = ?"
  ).all(partnerId) as any[];
  for (const row of rows) {
    if (exclYear != null && row.settle_year === exclYear && row.settle_month === exclMonth) continue;
    for (const k of coveredKeysOfRow(row)) set.add(k);
  }
  return set;
}

export type MonthOption = {
  ym: string; year: number; month: number; label: string;
  sales: number;      // this month's total rounds
  settled: boolean;   // already rolled up by another settlement → not selectable
  isAnchor: boolean;  // the current settle month (always included, always checked)
};
/** Choices for the "combine which preceding months" checklist: the anchor plus
 *  `lookback` months before it, each with its sales total and whether another
 *  settlement already covers it. Newest (anchor) first. */
export function monthPickerOptions(
  partnerId: number, branchId: number, anchorY: number, anchorM: number, lookback = 6
): MonthOption[] {
  if (!partnerGuard(partnerId, branchId)) return [];
  const blocked = settledMonthKeys(partnerId, branchId, anchorY, anchorM);
  const opts: MonthOption[] = [];
  for (let i = 0; i <= lookback; i++) {
    const b = monthsBefore(anchorY, anchorM, i);
    const ym = monthKey(b.y, b.m);
    const sales = round2(listRounds(partnerId, branchId, b.y, b.m).reduce((s, r) => s + r.sales_amount, 0));
    opts.push({
      ym, year: b.y, month: b.m, label: `${TH_MONTHS_FULL[b.m]} ${b.y + 543}`,
      sales, settled: i > 0 && blocked.has(ym), isAnchor: i === 0
    });
  }
  return opts;
}

/** Normalise a requested covered set: force-in the anchor, drop invalid /
 *  future-of-anchor keys, dedup, ascending. */
function normalizeCoveredSet(anchorY: number, anchorM: number, months: string[]): string[] {
  const anchorKey = monthKey(anchorY, anchorM);
  const set = new Set(months);
  set.add(anchorKey);
  return [...set]
    .map((k) => parseMonthKey(k))
    .filter((x): x is { y: number; m: number } => !!x)
    .map((x) => monthKey(x.y, x.m))
    .filter((k) => k <= anchorKey)
    .sort();
}

/** Live-compute the settlement from current rounds over the covered set (no
 *  write). `months` = the exact months to roll up (defaults to the stored
 *  snapshot's set, else just the anchor month). Also returns any stored
 *  snapshot + whether it's stale (rounds/covered set changed since it saved). */
export function previewSettlement(
  partnerId: number, branchId: number, year: number, month: number, months?: string[]
): SettlementPreview | null {
  const partner = getPartner(partnerId, branchId);
  if (!partner) return null;
  const tiers = getTiers(partnerId);
  const floors = getFloors(partnerId);
  const stored = getStoredSettlement(partnerId, branchId, year, month);
  // Resolve the covered set: explicit request → stored snapshot → anchor only.
  const requested = months && months.length ? months
    : stored ? stored.covered_months
    : [monthKey(year, month)];
  const covered = normalizeCoveredSet(year, month, requested);   // ascending
  // The minimum bill (floor) is per BILLING ROUND, not per calendar month
  // (owner 2026-08). A settlement is ONE bill = ONE round, whatever months it
  // rolls up — so ก.ค.+ส.ค. รวมกัน = "รอบบิลที่ 1" (ของ ก.ค.), ไม่ใช่ผลรวมขั้นต่ำสองเดือน.
  // The round is the op-month of the EARLIEST covered month; computeSettlement
  // then applies that single floor (no summing across months).
  const first = parseMonthKey(covered[0])!;
  const opMonth = opMonthFor(partner.start_date, first.y, first.m);
  // Gather rounds across every covered month.
  const rounds: RsRound[] = [];
  for (const k of covered) { const p = parseMonthKey(k)!; rounds.push(...listRounds(partnerId, branchId, p.y, p.m)); }
  rounds.sort((a, b) => (a.period_start < b.period_start ? -1 : 1));
  const totalSales = rounds.reduce((sum, r) => sum + r.sales_amount, 0);
  // Staff drink welfare is NOT part of the monthly GP settlement (owner
  // 2026-07-30) — it is its own report/card read from the redemptions, on the
  // weekly-transfer cadence. So this settlement stays GP-only (no drink line).
  const result = computeSettlement({
    totalSales, opMonth, tiers, floors,
    vatEnabled: partner.vat_enabled, vatRate: partner.vat_rate, whtRate: partner.wht_rate
  });
  // Group the covered daily entries into ISO weeks (= the weekly transfer),
  // then split GP per week via cumulative-difference so weeks sum to the
  // combined tier GP.
  const weeks = groupDailyIntoWeeks(rounds.map((r) => ({ date: r.period_start, amount: r.sales_amount })));
  const rb = computeRoundBreakdown(weeks.map((w) => w.sales), tiers);
  const breakdown: WeekBreakdown[] = rb.map((row, i) => ({
    label: weeks[i].label, start: weeks[i].start, end: weeks[i].end,
    sales: row.sales, roundGP: row.roundGP, gpPct: row.gpPct
  }));
  const stale = !!stored &&
    (round2(stored.totalSales) !== result.totalSales || !sameKeySet(stored.covered_months, covered));
  return { result, breakdown, opMonth, months: covered, stored, stale };
}

function shapeSettlement(r: any): RsSettlement {
  const netAmount = r.net_amount;
  const drinkPassthrough = round2(r.drink_passthrough ?? 0);
  return {
    id: r.id, partner_id: r.partner_id, settle_year: r.settle_year, settle_month: r.settle_month, op_month: r.op_month,
    span_months: r.span_months ?? 1,
    covered_months: coveredKeysOfRow(r),
    totalSales: r.total_sales, tierGP: r.tier_gp, floorApplied: r.floor_applied, topup: r.topup,
    billedGP: r.billed_gp, avgGpPct: r.avg_gp_pct, vatAmount: r.vat_amount, whtAmount: r.wht_amount, netAmount,
    drinkPassthrough,
    // VAT embedded in the VAT-inclusive drink amount (TH VAT 7%) — info only.
    drinkInputVat: round2(drinkPassthrough * 7 / 107),
    netAfterDrinks: round2(netAmount - drinkPassthrough),
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
export function saveSettlement(partnerId: number, branchId: number, year: number, month: number, months?: string[]): RsSettlement | null {
  const preview = previewSettlement(partnerId, branchId, year, month, months);
  if (!preview) return null;
  // Guard: a non-anchor covered month must not already belong to ANOTHER
  // settlement — no month may be settled twice (owner 2026-08 redesign).
  const anchorKey = monthKey(year, month);
  const blocked = settledMonthKeys(partnerId, branchId, year, month);
  if (preview.months.some((k) => k !== anchorKey && blocked.has(k))) return null;
  const coveredJson = JSON.stringify(preview.months);
  const spanCount = preview.months.length;
  const db = getDb();
  const r = preview.result;
  const existing = getStoredSettlement(partnerId, branchId, year, month);
  if (existing) {
    db.prepare(`
      UPDATE revshare_settlements SET op_month = ?, span_months = ?, covered_months = ?, total_sales = ?, tier_gp = ?, floor_applied = ?, topup = ?,
        billed_gp = ?, avg_gp_pct = ?, vat_amount = ?, wht_amount = ?, net_amount = ?, drink_passthrough = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(preview.opMonth, spanCount, coveredJson, r.totalSales, r.tierGP, r.floorApplied, r.topup, r.billedGP, r.avgGpPct,
      r.vatAmount, r.whtAmount, r.netAmount, r.drinkPassthrough, existing.id);
  } else {
    db.prepare(`
      INSERT INTO revshare_settlements (partner_id, settle_year, settle_month, op_month, span_months, covered_months, total_sales, tier_gp,
        floor_applied, topup, billed_gp, avg_gp_pct, vat_amount, wht_amount, net_amount, drink_passthrough)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(partnerId, year, month, preview.opMonth, spanCount, coveredJson, r.totalSales, r.tierGP, r.floorApplied, r.topup,
      r.billedGP, r.avgGpPct, r.vatAmount, r.whtAmount, r.netAmount, r.drinkPassthrough);
  }
  return getStoredSettlement(partnerId, branchId, year, month);
}

export function issueSettlement(partnerId: number, branchId: number, year: number, month: number, invoiceNo: string | null, when: string, months?: string[]): boolean {
  const saved = saveSettlement(partnerId, branchId, year, month, months);   // always recompute on issue
  if (!saved) return false;
  return getDb().prepare(
    "UPDATE revshare_settlements SET status = 'issued', invoice_no = ?, issued_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(invoiceNo, when, saved.id).changes > 0;
}
// ── GP → ACCOUNTA income (owner 2026-08) ─────────────────────────────
// The settled GP (billedGP, before VAT/WHT) is the shop's own revenue-share
// earning. On "paid" it is recorded as ACCOUNTA income under a dedicated
// channel so it shows in the daybook/reports as the shop's ส่วนแบ่งยอดขาย.
// source='revshare_gp' is owned by this flow: delete-then-insert keyed by
// (branch, source, channel, income_date) so re-paying never doubles, and
// revert removes it.
function settlementGpChannel(partnerName: string): string {
  return `ส่วนแบ่งยอดขาย · ${partnerName}`;
}
function monthEndIso(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}
export function postSettlementGpIncome(partnerId: number, branchId: number, year: number, month: number, userId: number): void {
  const partner = getPartner(partnerId, branchId);
  const stored = getStoredSettlement(partnerId, branchId, year, month);
  if (!partner || !stored) return;
  const db = getDb();
  const channel = settlementGpChannel(partner.name);
  const incomeDate = monthEndIso(year, month);
  const amount = round2(stored.billedGP);
  const companyId = (db.prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(branchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  const txn = db.transaction(() => {
    db.prepare(
      "DELETE FROM accounta_income WHERE branch_id = ? AND source = 'revshare_gp' AND channel IS ? AND income_date = ?"
    ).run(branchId, channel, incomeDate);
    if (amount <= 0) return;
    db.prepare(
      `INSERT INTO accounta_income (branch_id, company_id, income_date, channel, amount, note, created_by, source, is_vat, is_revenue)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'revshare_gp', ?, 1)`
    ).run(branchId, companyId, incomeDate, channel, amount,
      `ส่วนแบ่งยอดขาย (GP) · ${partner.name}${stored.span_months > 1 ? ` · รวม ${stored.span_months} เดือน` : ""}`,
      userId, partner.vat_enabled ? 1 : 0);
  });
  txn();
}
export function removeSettlementGpIncome(partnerId: number, branchId: number, year: number, month: number): void {
  const partner = getPartner(partnerId, branchId);
  if (!partner) return;
  getDb().prepare(
    "DELETE FROM accounta_income WHERE branch_id = ? AND source = 'revshare_gp' AND channel IS ? AND income_date = ?"
  ).run(branchId, settlementGpChannel(partner.name), monthEndIso(year, month));
}

export function markPaidSettlement(partnerId: number, branchId: number, year: number, month: number, when: string, userId: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  const done = getDb().prepare(
    "UPDATE revshare_settlements SET status = 'paid', paid_at = ?, updated_at = CURRENT_TIMESTAMP WHERE partner_id = ? AND settle_year = ? AND settle_month = ? AND status = 'issued'"
  ).run(when, partnerId, year, month).changes > 0;
  // Auto-post the GP into ACCOUNTA the moment it's marked paid (owner 2026-08).
  if (done) postSettlementGpIncome(partnerId, branchId, year, month, userId);
  return done;
}
export function revertSettlement(partnerId: number, branchId: number, year: number, month: number): boolean {
  if (!partnerGuard(partnerId, branchId)) return false;
  const done = getDb().prepare(
    "UPDATE revshare_settlements SET status = 'draft', invoice_no = NULL, issued_at = NULL, paid_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE partner_id = ? AND settle_year = ? AND settle_month = ?"
  ).run(partnerId, year, month).changes > 0;
  // Reverting to draft un-posts any GP income that a prior "paid" recorded.
  if (done) removeSettlementGpIncome(partnerId, branchId, year, month);
  return done;
}
