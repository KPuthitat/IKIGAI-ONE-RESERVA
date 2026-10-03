// SALESA — corporate-customer analytics from the tax-invoice export (owner
// 2026-10-02). Companies that ask for a full tax invoice are the branch's
// repeat corporate customers; this answers, per company: how often they come
// (เดือนละกี่ครั้ง), how many times this year, when in the month and which
// weekday they tend to come, whether their visits cluster near a public
// holiday, how much they have spent with us so far, and who has gone quiet —
// the list the owner works from for offline marketing.
//
// A customer view only: the invoices are a subset of receipts already counted
// in salesa_daily, so nothing here feeds any sales total. The pattern maths
// lives in visit-pattern.ts (shared with INSIGNA members).

import { getDb } from "./db";
import { listTaxInvoices, listTaxInvoicesAll, getRdBranchCode, taxInvoiceRdCodes, type TaxInvoiceDbRow } from "./salesa-db";
import { visitPattern, monthsCovered, dayNum, round2, type VisitPattern, type Holiday, type MonthPhase } from "./visit-pattern";

export type { MonthPhase };
export { PHASE_TH } from "./visit-pattern";

export type CorporateCustomer = VisitPattern & {
  key: string;
  name: string;
  taxId: string | null;
  custBranchCode: string | null;      // the customer's own RD branch ("00016"), null/00000 = head office
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

const fmtBaht = (n: number) => Math.round(n).toLocaleString("th-TH");

export function isCancelledStatus(status: string | null): boolean {
  return !!status && /ยกเลิก|cancel|void/i.test(status);
}

/** The grouping key: the tax id when present, else the normalised name. */
function customerKey(r: TaxInvoiceDbRow): string {
  return r.tax_id ? `t:${r.tax_id}` : `n:${r.customer_name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

/** Public holidays around the year (±1 month either side so edge visits still
 *  find a neighbouring holiday). */
export function holidaysAround(year: number): Holiday[] {
  const rows = getDb().prepare("SELECT date, name_th FROM public_holidays WHERE date >= ? AND date <= ? ORDER BY date")
    .all(`${year - 1}-12-01`, `${year + 1}-01-31`) as Array<{ date: string; name_th: string }>;
  return rows.map((h) => ({ day: dayNum(h.date), name: h.name_th }));
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

  const covered = monthsCovered(year, coverage.from, todayIso);
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
    const p = visitPattern(list.map((r) => ({ date: r.invoice_date, total: r.total })), { year, todayIso, monthsCovered: covered, holidays });
    const g = group.get(key) ?? { visits: p.visits, spend: p.spend, branches: new Set([branchId]) };

    // Blurb — the sentence the owner asked for ("มาเดือนละสองครั้ง ปีนี้มา 4 ครั้ง …").
    const parts: string[] = [];
    parts.push(p.visitsYear > 0
      ? `ปีนี้มา ${p.visitsYear} ครั้ง (${p.cadence}) รวม ${fmtBaht(p.spendYear)} บาท`
      : `ปีนี้ยังไม่มา · รวมทุกปี ${p.visits} ครั้ง ${fmtBaht(p.spend)} บาท`);
    if (p.avgPerVisit != null) parts.push(`เฉลี่ยครั้งละ ${fmtBaht(p.avgPerVisit)} บาท`);
    const habit: string[] = [];
    if (p.phase && p.visitsYear >= 2 && p.phase.count / p.visitsYear >= 0.5) habit.push(p.phase.label);
    if (p.weekday && p.visitsYear >= 2 && p.weekday.count / p.visitsYear >= 0.5) habit.push(`วัน${p.weekday.label}`);
    if (habit.length) parts.push(`มักมา${habit.join(" ")}`);
    if (p.nearHoliday.count > 0) parts.push(`ใกล้วันหยุด ${p.nearHoliday.count} ครั้ง (${p.nearHoliday.names.slice(0, 2).join(", ")})`);
    parts.push(`ล่าสุด ${p.lastVisitLabel}${p.daysSinceLast > 0 ? ` (${p.daysSinceLast} วันก่อน)` : " (วันนี้)"}`);
    if (p.overdue) parts.push("เงียบนานกว่ารอบปกติ — ควรติดต่อ");
    if (g.branches.size > 1) parts.push(`ทุกสาขารวม ${g.visits} ครั้ง ${fmtBaht(g.spend)} บาท`);

    rows.push({
      ...p,
      key, name: latest.customer_name, taxId: latest.tax_id,
      custBranchCode: latest.cust_branch_code && latest.cust_branch_code !== "00000" ? latest.cust_branch_code : null,
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
