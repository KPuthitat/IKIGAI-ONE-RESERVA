// INSIGNA — member visit analytics (owner 2026-10-03: the same questions as
// ANALYTICA's corporate customers, asked of members). Visits come from the
// POS bills staff tied to the member at checkout (insigna_customer_bills ⋈
// salesa_receipts); bills on the same day merge into one visit. Everything is
// keyed by the pseudonym and shown by member code — no name exists.

import { getDb } from "../db";
import { visitPattern, monthsCovered, dayNum, round2, type VisitPattern, type Holiday } from "../visit-pattern";
import { listMembers, type MemberProfile } from "./members";

export type MemberRow = {
  customer_hash: string;
  member_code: string;
  gender: "M" | "F" | "X" | null;
  ageBand: string | null;             // "30–39" from birth_year, null when unknown
  birthday: { day: number; month: number } | null;
  birthdayThisMonth: boolean;
  home_area: string | null;
  source: string | null;
  consent_marketing: boolean;
  member_since: string | null;        // YYYY-MM-DD
  signup_branch_id: number | null;
  pendingBills: number;
  pattern: VisitPattern | null;       // null = no linked bills yet
};

export type MemberReport = {
  year: number;
  month: number;                      // the "this month" used for birthdays / new members
  branchId: number | null;            // visit filter (null = every branch)
  summary: {
    members: number; newThisMonth: number; withVisits: number; consented: number;
    birthdaysThisMonth: number; overdue: number; visitsYear: number; spendYear: number;
    genders: { F: number; M: number; X: number; unknown: number };
    sources: Array<{ key: string; n: number }>;
    areas: Array<{ area: string; n: number }>;
  };
  birthdays: Array<{ member_code: string; day: number; consent: boolean }>;   // this month, by day
  rows: MemberRow[];                  // by this year's spend desc, members without visits last
};

function holidaysAround(year: number): Holiday[] {
  const rows = getDb().prepare("SELECT date, name_th FROM public_holidays WHERE date >= ? AND date <= ? ORDER BY date")
    .all(`${year - 1}-12-01`, `${year + 1}-01-31`) as Array<{ date: string; name_th: string }>;
  return rows.map((h) => ({ day: dayNum(h.date), name: h.name_th }));
}

export function ageBandOf(birthYear: number | null, todayIso: string): string | null {
  if (!birthYear) return null;
  const age = Number(todayIso.slice(0, 4)) - birthYear;
  if (age < 0 || age > 120) return null;
  if (age < 20) return "ต่ำกว่า 20";
  if (age >= 70) return "70 ขึ้นไป";
  const lo = Math.floor(age / 10) * 10;
  return `${lo}–${lo + 9}`;
}

/** One visit per member per day (sum of that day's linked bills). */
function memberVisits(branchId: number | null): Map<string, Array<{ date: string; total: number }>> {
  const rows = getDb().prepare(`
    SELECT l.customer_hash AS h, r.sale_date AS d, ROUND(SUM(r.nett), 2) AS total
    FROM insigna_customer_bills l
    JOIN salesa_receipts r ON r.branch_id = l.branch_id AND r.sale_date = l.sale_date AND r.bill_no = l.bill_no
    WHERE (? IS NULL OR l.branch_id = ?)
    GROUP BY l.customer_hash, r.sale_date
    ORDER BY r.sale_date
  `).all(branchId, branchId) as Array<{ h: string; d: string; total: number }>;
  const out = new Map<string, Array<{ date: string; total: number }>>();
  for (const r of rows) {
    const list = out.get(r.h) ?? [];
    list.push({ date: r.d, total: r.total });
    out.set(r.h, list);
  }
  return out;
}

export function memberReport(opts: { year: number; todayIso: string; branchId?: number | null }): MemberReport {
  const { year, todayIso } = opts;
  const branchId = opts.branchId ?? null;
  const month = Number(todayIso.slice(5, 7));
  const todayYm = todayIso.slice(0, 7);
  const members: MemberProfile[] = listMembers({ limit: 5000 });
  const visits = memberVisits(branchId);
  const pendingByHash = new Map<string, number>(
    (getDb().prepare("SELECT customer_hash AS h, COUNT(*) AS n FROM insigna_pending_bills GROUP BY customer_hash").all() as Array<{ h: string; n: number }>).map((r) => [r.h, r.n])
  );
  // Coverage = the first linked visit anywhere (the denominator for cadence).
  let coverageFrom: string | null = null;
  for (const list of visits.values()) if (list.length && (!coverageFrom || list[0].date < coverageFrom)) coverageFrom = list[0].date;
  const covered = monthsCovered(year, coverageFrom, todayIso);
  const holidays = holidaysAround(year);

  const rows: MemberRow[] = members.map((m) => {
    const v = visits.get(m.customer_hash) ?? [];
    return {
      customer_hash: m.customer_hash,
      member_code: m.member_code as string,
      gender: m.gender,
      ageBand: ageBandOf(m.birth_year, todayIso),
      birthday: m.birth_day && m.birth_month ? { day: m.birth_day, month: m.birth_month } : null,
      birthdayThisMonth: m.birth_month === month,
      home_area: m.home_area,
      source: m.acquisition_source,
      consent_marketing: m.consent_marketing === 1,
      member_since: m.member_since ? m.member_since.slice(0, 10) : null,
      signup_branch_id: m.signup_branch_id,
      pendingBills: pendingByHash.get(m.customer_hash) ?? 0,
      pattern: v.length ? visitPattern(v, { year, todayIso, monthsCovered: covered, holidays }) : null
    };
  });
  rows.sort((a, b) =>
    (b.pattern?.spendYear ?? -1) - (a.pattern?.spendYear ?? -1) ||
    (b.pattern?.spend ?? -1) - (a.pattern?.spend ?? -1) ||
    (b.member_since ?? "").localeCompare(a.member_since ?? ""));

  const genders = { F: 0, M: 0, X: 0, unknown: 0 };
  const sourceCount = new Map<string, number>();
  const areaCount = new Map<string, number>();
  for (const r of rows) {
    if (r.gender === "F" || r.gender === "M" || r.gender === "X") genders[r.gender]++; else genders.unknown++;
    if (r.source) sourceCount.set(r.source, (sourceCount.get(r.source) ?? 0) + 1);
    if (r.home_area) areaCount.set(r.home_area, (areaCount.get(r.home_area) ?? 0) + 1);
  }
  const birthdays = rows.filter((r) => r.birthdayThisMonth && r.birthday)
    .map((r) => ({ member_code: r.member_code, day: r.birthday!.day, consent: r.consent_marketing }))
    .sort((a, b) => a.day - b.day);

  return {
    year, month, branchId,
    summary: {
      members: rows.length,
      newThisMonth: rows.filter((r) => (r.member_since ?? "").startsWith(todayYm)).length,
      withVisits: rows.filter((r) => r.pattern).length,
      consented: rows.filter((r) => r.consent_marketing).length,
      birthdaysThisMonth: birthdays.length,
      overdue: rows.filter((r) => r.pattern?.overdue).length,
      visitsYear: rows.reduce((s, r) => s + (r.pattern?.visitsYear ?? 0), 0),
      spendYear: round2(rows.reduce((s, r) => s + (r.pattern?.spendYear ?? 0), 0)),
      genders,
      sources: [...sourceCount.entries()].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n),
      areas: [...areaCount.entries()].map(([area, n]) => ({ area, n })).sort((a, b) => b.n - a.n).slice(0, 10)
    },
    birthdays,
    rows
  };
}
