// SALESA — corporate-customer analytics from the tax-invoice export (owner
// 2026-10-02). Companies that ask for a full tax invoice are the branch's
// repeat corporate customers; this answers, per company: how often they come
// (เดือนละกี่ครั้ง), how many times this year, when in the month and which
// weekday they tend to come, whether their visits cluster near a public
// holiday, how much they have spent with us so far, and who has gone quiet —
// the list the owner works from for offline marketing.
//
// A customer view only: the invoices are a subset of receipts already counted
// in salesa_daily, so nothing here feeds any sales total.

import { getDb } from "./db";
import { listTaxInvoices, listTaxInvoicesAll, getRdBranchCode, taxInvoiceRdCodes, type TaxInvoiceDbRow } from "./salesa-db";
import { thaiDate } from "./revshare";

const TH_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_MS = 86_400_000;
const HOLIDAY_WINDOW_DAYS = 3;     // a visit within ±3 days of a public holiday counts as "near" it

export type MonthPhase = "early" | "mid" | "late";
export const PHASE_TH: Record<MonthPhase, string> = { early: "ต้นเดือน", mid: "กลางเดือน", late: "ปลายเดือน" };

export type CorporateCustomer = {
  key: string;
  name: string;
  taxId: string | null;
  custBranchCode: string | null;      // the customer's own RD branch ("00016"), null/00000 = head office
  visits: number;                     // all time, this branch, issued invoices
  spend: number;
  visitsYear: number;                 // the viewed year
  spendYear: number;
  avgPerVisit: number | null;         // this year's, else all-time
  perMonth: number | null;            // visits per covered month this year
  cadence: string;                    // "เดือนละ ~2 ครั้ง" / "ทุก ~2 เดือน" / "มาครั้งเดียว"
  avgGapDays: number | null;          // mean days between consecutive visits (all time)
  firstVisit: string;
  lastVisit: string;
  lastVisitLabel: string;
  daysSinceLast: number;
  overdue: boolean;                   // quiet for longer than 1.5× their usual gap
  months: number[];                   // 12 cells — visits per month of the viewed year
  phase: { key: MonthPhase; label: string; count: number } | null;   // most common part of the month (year)
  weekday: { dow: number; label: string; count: number } | null;    // most common weekday (year)
  nearHoliday: { count: number; names: string[] };                   // visits within ±3 days of a holiday (year)
  groupVisits: number;                // every branch, all time
  groupSpend: number;
  otherBranches: boolean;             // also invoiced at another branch
  blurb: string;                      // one-line Thai summary
};

export type CorporateReport = {
  year: number;
  hasData: boolean;
  coverage: { from: string | null; to: string | null; invoices: number; cancelled: number; persons: number; personInvoices: number };
  companies: number;                  // distinct companies (all time)
  repeatCompanies: number;            // ≥ 2 visits (all time)
  invoicesYear: number;
  spendYear: number;
  spendAll: number;
  newThisMonth: string[];             // first-ever visit in the current month
  overdue: string[];                  // repeat customers gone quiet
  rows: CorporateCustomer[];          // companies, by this year's spend desc
  rdCodes: { expected: string | null; seen: string[] };
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;
const dayNum = (iso: string) => Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / DAY_MS);
const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const fmtBaht = (n: number) => Math.round(n).toLocaleString("th-TH");

export function isCancelledStatus(status: string | null): boolean {
  return !!status && /ยกเลิก|cancel|void/i.test(status);
}

/** The grouping key: the tax id when present, else the normalised name. */
function customerKey(r: TaxInvoiceDbRow): string {
  return r.tax_id ? `t:${r.tax_id}` : `n:${r.customer_name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function phaseOf(iso: string): MonthPhase {
  const dom = Number(iso.slice(8, 10));
  return dom <= 10 ? "early" : dom <= 20 ? "mid" : "late";
}

function modeOf<K>(counts: Map<K, number>): { key: K; count: number } | null {
  let best: { key: K; count: number } | null = null;
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
  return best;
}

/** Public holidays around the year (±1 month either side so edge visits still
 *  find a neighbouring holiday). */
function holidaysAround(year: number): Array<{ day: number; name: string }> {
  const rows = getDb().prepare("SELECT date, name_th FROM public_holidays WHERE date >= ? AND date <= ? ORDER BY date")
    .all(`${year - 1}-12-01`, `${year + 1}-01-31`) as Array<{ date: string; name_th: string }>;
  return rows.map((h) => ({ day: dayNum(h.date), name: h.name_th }));
}

/** Half-step rounding for the cadence wording: 0.9 → "เดือนละ ~1 ครั้ง",
 *  1.3 → "~1.5", 2.1 → "~2" — a decimal like 0.9 reads oddly for a person. */
const half = (n: number) => String(Math.max(0.5, Math.round(n * 2) / 2));

function cadenceLabel(visitsYear: number, perMonth: number | null): string {
  if (visitsYear === 0) return "ปีนี้ยังไม่มา";
  if (visitsYear === 1 || perMonth == null) return "มาครั้งเดียว";
  if (perMonth >= 0.8) return `เดือนละ ~${half(perMonth)} ครั้ง`;
  return `ทุก ~${half(1 / perMonth)} เดือน`;
}

export function corporateCustomers(branchId: number, year: number, todayIso: string): CorporateReport {
  const all = listTaxInvoices(branchId);
  const rdCodes = { expected: getRdBranchCode(branchId), seen: taxInvoiceRdCodes(branchId) };
  const empty: CorporateReport = {
    year, hasData: false,
    coverage: { from: null, to: null, invoices: 0, cancelled: 0, persons: 0, personInvoices: 0 },
    companies: 0, repeatCompanies: 0, invoicesYear: 0, spendYear: 0, spendAll: 0, newThisMonth: [], overdue: [], rows: [], rdCodes
  };
  if (!all.length) return empty;

  const issued = all.filter((r) => !isCancelledStatus(r.status));
  const cancelled = all.length - issued.length;
  const personRows = issued.filter((r) => r.customer_kind === "person");
  const persons = new Set(personRows.map(customerKey)).size;
  const companyRows = issued.filter((r) => r.customer_kind !== "person");
  const coverage = {
    from: all[0]?.invoice_date ?? null,
    to: all[all.length - 1]?.invoice_date ?? null,
    invoices: all.length, cancelled, persons, personInvoices: personRows.length
  };
  if (!companyRows.length) return { ...empty, coverage, hasData: false };

  // Months of this year the data covers (for "เดือนละกี่ครั้ง"): from the first
  // imported invoice (or Jan 1) to today (or Dec 31), in 30.44-day months.
  const yStart = `${year}-01-01`, yEnd = `${year}-12-31`;
  const covFrom = coverage.from && coverage.from > yStart ? coverage.from : yStart;
  const covTo = todayIso < yEnd ? todayIso : yEnd;
  const monthsCovered = Math.max(0.5, (dayNum(covTo) - dayNum(covFrom) + 1) / 30.44);
  const todayDay = dayNum(todayIso);
  const todayYm = todayIso.slice(0, 7);
  const holidays = holidaysAround(year);

  // Cross-branch totals per customer (all time, issued, companies).
  const group = new Map<string, { visits: number; spend: number; branches: Set<number> }>();
  for (const r of listTaxInvoicesAll()) {
    if (isCancelledStatus(r.status) || r.customer_kind === "person") continue;
    const k = customerKey(r);
    const g = group.get(k) ?? { visits: 0, spend: 0, branches: new Set<number>() };
    g.visits++; g.spend = round2(g.spend + r.total); g.branches.add(r.branch_id);
    group.set(k, g);
  }

  const byKey = new Map<string, TaxInvoiceDbRow[]>();
  for (const r of companyRows) {
    const k = customerKey(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }

  const rows: CorporateCustomer[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_no.localeCompare(b.invoice_no));
    const latest = list[list.length - 1];
    const visits = list.length;
    const spend = round2(list.reduce((s, r) => s + r.total, 0));
    const inYear = list.filter((r) => r.invoice_date.startsWith(`${year}-`));
    const visitsYear = inYear.length;
    const spendYear = round2(inYear.reduce((s, r) => s + r.total, 0));
    const avgPerVisit = visitsYear > 0 ? round2(spendYear / visitsYear) : visits > 0 ? round2(spend / visits) : null;
    const perMonth = visitsYear > 0 ? round2(visitsYear / monthsCovered) : null;
    // Mean gap between consecutive visit DAYS (two invoices on one day = one visit).
    const visitDays = [...new Set(list.map((r) => r.invoice_date))].map(dayNum);
    let avgGapDays: number | null = null;
    if (visitDays.length >= 2) {
      let sum = 0;
      for (let i = 1; i < visitDays.length; i++) sum += visitDays[i] - visitDays[i - 1];
      avgGapDays = Math.round(sum / (visitDays.length - 1));
    }
    const daysSinceLast = todayDay - dayNum(latest.invoice_date);
    const overdue = avgGapDays != null && daysSinceLast > Math.max(avgGapDays * 1.5, 21);

    const months = Array<number>(12).fill(0);
    const phaseCounts = new Map<MonthPhase, number>();
    const dowCounts = new Map<number, number>();
    let nearCount = 0;
    const nearNames = new Set<string>();
    for (const r of inYear) {
      months[Number(r.invoice_date.slice(5, 7)) - 1]++;
      const ph = phaseOf(r.invoice_date);
      phaseCounts.set(ph, (phaseCounts.get(ph) ?? 0) + 1);
      const dw = dowOf(r.invoice_date);
      dowCounts.set(dw, (dowCounts.get(dw) ?? 0) + 1);
      const d = dayNum(r.invoice_date);
      let nearest: { name: string; dist: number } | null = null;
      for (const h of holidays) {
        const dist = Math.abs(h.day - d);
        if (dist <= HOLIDAY_WINDOW_DAYS && (!nearest || dist < nearest.dist)) nearest = { name: h.name, dist };
      }
      if (nearest) { nearCount++; nearNames.add(nearest.name); }
    }
    const phaseMode = modeOf(phaseCounts);
    const dowMode = modeOf(dowCounts);
    const phase = phaseMode ? { key: phaseMode.key, label: PHASE_TH[phaseMode.key], count: phaseMode.count } : null;
    const weekday = dowMode ? { dow: dowMode.key, label: TH_WEEKDAYS[dowMode.key], count: dowMode.count } : null;
    const g = group.get(key) ?? { visits, spend, branches: new Set([branchId]) };

    // Blurb — the sentence the owner asked for ("มาเดือนละสองครั้ง ปีนี้มา 4 ครั้ง …").
    const parts: string[] = [];
    parts.push(visitsYear > 0
      ? `ปีนี้มา ${visitsYear} ครั้ง (${cadenceLabel(visitsYear, perMonth)}) รวม ${fmtBaht(spendYear)} บาท`
      : `ปีนี้ยังไม่มา · รวมทุกปี ${visits} ครั้ง ${fmtBaht(spend)} บาท`);
    if (avgPerVisit != null) parts.push(`เฉลี่ยครั้งละ ${fmtBaht(avgPerVisit)} บาท`);
    const habit: string[] = [];
    if (phase && visitsYear >= 2 && phase.count / visitsYear >= 0.5) habit.push(phase.label);
    if (weekday && visitsYear >= 2 && weekday.count / visitsYear >= 0.5) habit.push(`วัน${weekday.label}`);
    if (habit.length) parts.push(`มักมา${habit.join(" ")}`);
    if (nearCount > 0) parts.push(`ใกล้วันหยุด ${nearCount} ครั้ง (${[...nearNames].slice(0, 2).join(", ")})`);
    parts.push(`ล่าสุด ${thaiDate(latest.invoice_date)}${daysSinceLast > 0 ? ` (${daysSinceLast} วันก่อน)` : " (วันนี้)"}`);
    if (overdue) parts.push("เงียบนานกว่ารอบปกติ — ควรติดต่อ");
    if (g.branches.size > 1) parts.push(`ทุกสาขารวม ${g.visits} ครั้ง ${fmtBaht(g.spend)} บาท`);

    rows.push({
      key, name: latest.customer_name, taxId: latest.tax_id,
      custBranchCode: latest.cust_branch_code && latest.cust_branch_code !== "00000" ? latest.cust_branch_code : null,
      visits, spend, visitsYear, spendYear, avgPerVisit, perMonth, cadence: cadenceLabel(visitsYear, perMonth), avgGapDays,
      firstVisit: list[0].invoice_date, lastVisit: latest.invoice_date, lastVisitLabel: thaiDate(latest.invoice_date), daysSinceLast, overdue,
      months, phase, weekday, nearHoliday: { count: nearCount, names: [...nearNames] },
      groupVisits: g.visits, groupSpend: g.spend, otherBranches: g.branches.size > 1,
      blurb: parts.join(" · ")
    });
  }
  rows.sort((a, b) => b.spendYear - a.spendYear || b.spend - a.spend || b.visits - a.visits || a.name.localeCompare(b.name, "th"));

  const invoicesYear = rows.reduce((s, r) => s + r.visitsYear, 0);
  return {
    year, hasData: true, coverage,
    companies: rows.length,
    repeatCompanies: rows.filter((r) => r.visits >= 2).length,
    invoicesYear,
    spendYear: round2(rows.reduce((s, r) => s + r.spendYear, 0)),
    spendAll: round2(rows.reduce((s, r) => s + r.spend, 0)),
    newThisMonth: year === Number(todayYm.slice(0, 4)) ? rows.filter((r) => r.firstVisit.startsWith(todayYm)).map((r) => r.name) : [],
    overdue: rows.filter((r) => r.overdue).sort((a, b) => b.spend - a.spend).map((r) => r.name),
    rows, rdCodes
  };
}
