// Monthly per-person payroll rollup — THE single data set behind every monthly
// surface (owner 2026-10-01: "ไม่ว่าจะเปิดดูจากหน้าไหน … ต้องเป็นข้อมูลชุดเดียวกัน").
// The payroll summary page, the export document (CSV/XLSX/PDF) and the monthly
// payslip all read this; none of them aggregates on its own any more.
//
// One row per (person, company) for the month `month`:
//   • payroll  — every pay round whose pay_date falls in the month, company-scoped
//   • svc      — the PREVIOUS month's service-charge round (paid in this month's
//                pocket, ~the 20th), from the company roll-up authority
//   • mtg      — เบี้ยประชุม paid with that SVC round (per-meeting branch override
//                aware), from meetingFeeByUserCompany
//   • derived  — income / tax / deductions / take, with รวมรับจริง anchored to the
//                STORED net so it always equals what was transferred.
// A person who received only SVC or only a meeting fee (no payroll line) still
// gets a row, filed under their real employment type.

import type Database from "better-sqlite3";
import { nameWithPrefix } from "./name";
import {
  computeCompanySvcSummary, computeMonthlySvcSummary, meetingFeeByUserCompany
} from "./service-charge";

export type MonthPerson = {
  key: string;                       // `${userId}|${companyId ?? "null"}`
  userId: number;
  companyId: number | null;
  displayName: string;
  titlePrefix: string | null;
  name: string;                      // prefixed display name
  employmentType: "ft" | "pt" | null;
  taxMode: "sso" | "wht" | null;      // null = legacy line with no snapshot
  homeBranch: string | null;
  hasPayroll: boolean;               // false = synthesised SVC/meeting-only row
  // payroll (all rounds paying this month, this company)
  comp: number;                      // gross across rounds
  sso: number;
  taxWage: number;                   // WHT withheld on wages (PT / wht-mode)
  payrollNet: number;                // stored net across rounds
  periodCount: number;
  drink: number;                     // ค่าเครื่องดื่ม (capped at inRound)
  mealpass: number;                  // ค่าอาหารข้ามบริษัท (capped)
  otherDed: number;                  // remainder of inRound
  inRound: number;                   // หักระหว่างเดือน = comp − net − sso − taxWage
  unpaidDays: number;                // FT only
  unpaidCut: number;                 // FT only — engine's persisted salary cut
  // service charge (svcMonth) + meeting fee
  svcGross: number; svcWht: number; svcGi: number; svcNet: number;
  mtgGross: number; mtgWht: number; mtgNet: number;
  // derived
  income: number;                    // comp + svcGross + mtgGross
  tax: number;                       // taxWage + svcWht + mtgWht
  gi: number;                        // svcGi
  ded: number;                       // sso + tax + gi + inRound
  take: number;                      // income − ded  (= payrollNet + svcNet + mtgNet)
};

export type MonthBranch = { branchId: number; branchName: string; companyId: number | null; companyName: string | null };
export type MonthCompany = { key: number | null; name: string };

export type MonthRollup = {
  month: string;
  svcMonth: string;
  from: string; to: string;
  branches: MonthBranch[];           // payroll ∪ svc ∪ meeting-fee branches, company-sorted
  companies: MonthCompany[];
  people: MonthPerson[];             // every (person, company) row
  byCompany: Map<number | null, MonthPerson[]>;
  byKey: Map<string, MonthPerson>;
  homeByUser: Map<number, string | null>;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function monthRange(yearMonth: string): { from: string; to: string } {
  const [y, m] = yearMonth.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${yearMonth}-01`, to: `${yearMonth}-${String(last).padStart(2, "0")}` };
}

type PayrollAgg = {
  user_id: number; display_name: string; title_prefix: string | null; company_id: number | null;
  employment_type: "pt" | "ft" | null; salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number; total_sso: number; total_tax: number; total_net: number; period_count: number;
  total_drink: number; total_mealpass: number; total_unpaid_days: number; total_base_cut: number;
};

export function monthlyPayrollRollup(db: Database.Database, month: string): MonthRollup {
  const { from, to } = monthRange(month);
  const svcMonth = shiftMonth(month, -1);

  // สังกัด (home branch) per user — is_primary=1, else lowest branch_id.
  const homeByUser = new Map<number, string | null>();
  for (const r of db.prepare(`
    SELECT ub.user_id,
           (SELECT name FROM branches WHERE id = COALESCE(
              (SELECT branch_id FROM user_branches WHERE user_id = ub.user_id AND is_primary = 1 LIMIT 1),
              (SELECT MIN(branch_id) FROM user_branches WHERE user_id = ub.user_id))) AS home_branch_name
    FROM (SELECT DISTINCT user_id FROM user_branches) ub
  `).all() as Array<{ user_id: number; home_branch_name: string | null }>) {
    homeByUser.set(r.user_id, r.home_branch_name);
  }

  // Branch set = payroll periods paying this month ∪ SVC activity in svcMonth ∪
  // branches carrying a meeting fee (owner 2026-09-03 / 2026-10-01: anyone who
  // received money from a company that had transactions must appear).
  const meetingFees = meetingFeeByUserCompany(svcMonth);
  const branchRows = db.prepare(`
    SELECT b.id AS branchId, b.name AS branchName, b.company_id AS companyId, c.name_th AS companyName
    FROM branches b LEFT JOIN companies c ON c.id = b.company_id
    WHERE b.id IN (SELECT pp.branch_id FROM payroll_periods pp WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL)
       OR b.id IN (SELECT DISTINCT branch_id FROM daily_service_charge WHERE substr(date, 1, 7) = ?)
  `).all(from, to, svcMonth) as MonthBranch[];
  const branchMap = new Map<number, MonthBranch>(branchRows.map((b) => [b.branchId, b]));
  // Meeting-fee companies not yet represented by a branch: pull one branch of that company.
  for (const m of meetingFees.values()) {
    if (m.companyId == null || [...branchMap.values()].some((b) => b.companyId === m.companyId)) continue;
    const b = db.prepare(`
      SELECT b.id AS branchId, b.name AS branchName, b.company_id AS companyId, c.name_th AS companyName
      FROM branches b LEFT JOIN companies c ON c.id = b.company_id WHERE b.company_id = ? ORDER BY b.id LIMIT 1
    `).get(m.companyId) as MonthBranch | undefined;
    if (b) branchMap.set(b.branchId, b);
  }
  const branches = [...branchMap.values()].sort((a, b) =>
    (a.companyId == null ? 1 : 0) - (b.companyId == null ? 1 : 0)
    || (a.companyId ?? 0) - (b.companyId ?? 0)
    || a.branchId - b.branchId);
  const companies: MonthCompany[] = [];
  for (const b of branches) {
    if (!companies.some((c) => c.key === b.companyId)) companies.push({ key: b.companyId, name: b.companyName ?? "ไม่ระบุบริษัท" });
  }

  // Per (user, company) payroll aggregate — branch-stamped periods only.
  const payroll = db.prepare(`
    SELECT pl.user_id, pl.display_name, u.title_prefix, b.company_id AS company_id,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count,
           SUM(pl.drink_deductions)    AS total_drink,
           SUM(pl.mealpass_deductions) AS total_mealpass,
           SUM(CASE WHEN pl.employment_type = 'ft' THEN pl.unpaid_leave_days ELSE 0 END) AS total_unpaid_days,
           SUM(pl.unpaid_leave_deduction) AS total_base_cut
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    JOIN branches b ON b.id = pp.branch_id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL
    GROUP BY pl.user_id, b.company_id
  `).all(from, to) as PayrollAgg[];

  // SVC from the company roll-up authority (รวมกอง + overrides), per company once;
  // a NULL-company branch falls back to its own per-branch summary.
  type SvcAgg = { gross: number; wht: number; gi: number; net: number; displayName: string; employmentType: string | null; taxMode: "sso" | "wht" };
  const svcByKey = new Map<string, SvcAgg>();
  const addSvc = (companyId: number | null, row: { userId: number; displayName: string; employmentType: string | null; taxMode: "sso" | "wht"; netAllocation: number; whtAmount: number; groupInsurance: number; netPayout: number }) => {
    if (!row.netAllocation && !row.netPayout) return;
    const k = `${row.userId}|${companyId ?? "null"}`;
    const cur = svcByKey.get(k) ?? { gross: 0, wht: 0, gi: 0, net: 0, displayName: row.displayName, employmentType: row.employmentType, taxMode: row.taxMode };
    cur.gross += row.netAllocation; cur.wht += row.whtAmount; cur.gi += row.groupInsurance; cur.net += row.netPayout;
    svcByKey.set(k, cur);
  };
  const seenCompany = new Set<number>();
  for (const b of branches) {
    if (b.companyId == null) {
      try { for (const row of computeMonthlySvcSummary(b.branchId, svcMonth).rows) addSvc(null, row); } catch { /* no svc */ }
    } else if (!seenCompany.has(b.companyId)) {
      seenCompany.add(b.companyId);
      try { for (const row of computeCompanySvcSummary(b.companyId, svcMonth).rows) addSvc(b.companyId, row); } catch { /* no svc */ }
    }
  }

  // Assemble people = payroll rows ∪ SVC-only ∪ meeting-fee-only.
  const byKey = new Map<string, MonthPerson>();
  const empType = (t: string | null | undefined): "ft" | "pt" | null => (t === "ft" || t === "pt" ? t : null);
  const blank = (userId: number, companyId: number | null, displayName: string, titlePrefix: string | null, employmentType: string | null, taxMode: "sso" | "wht" | null): MonthPerson => ({
    key: `${userId}|${companyId ?? "null"}`, userId, companyId, displayName, titlePrefix,
    name: nameWithPrefix(titlePrefix, displayName), employmentType: empType(employmentType), taxMode,
    homeBranch: homeByUser.get(userId) ?? null, hasPayroll: false,
    comp: 0, sso: 0, taxWage: 0, payrollNet: 0, periodCount: 0,
    drink: 0, mealpass: 0, otherDed: 0, inRound: 0, unpaidDays: 0, unpaidCut: 0,
    svcGross: 0, svcWht: 0, svcGi: 0, svcNet: 0, mtgGross: 0, mtgWht: 0, mtgNet: 0,
    income: 0, tax: 0, gi: 0, ded: 0, take: 0
  });
  for (const r of payroll) {
    const p = blank(r.user_id, r.company_id, r.display_name, r.title_prefix, r.employment_type, r.salary_tax_mode_snapshot ?? null);
    p.hasPayroll = true;
    p.comp = round2(r.total_gross ?? 0); p.sso = round2(r.total_sso ?? 0); p.taxWage = round2(r.total_tax ?? 0);
    p.payrollNet = round2(r.total_net ?? 0); p.periodCount = r.period_count ?? 0;
    // หักระหว่างเดือน from the STORED net (round2 at every step); itemised parts are
    // capped at the total since the welfare floor can clamp a net to 0 while the
    // ledger columns keep their full value.
    p.inRound = round2(Math.max(0, p.comp - p.payrollNet - p.sso - p.taxWage));
    p.drink = round2(Math.min(r.total_drink ?? 0, p.inRound));
    p.mealpass = round2(Math.min(r.total_mealpass ?? 0, p.inRound - p.drink));
    p.otherDed = round2(Math.max(0, p.inRound - p.drink - p.mealpass));
    p.unpaidDays = r.total_unpaid_days ?? 0; p.unpaidCut = round2(r.total_base_cut ?? 0);
    byKey.set(p.key, p);
  }
  for (const [k, s] of svcByKey) {
    const [uid, co] = k.split("|");
    const p = byKey.get(k) ?? blank(Number(uid), co === "null" ? null : Number(co), s.displayName, null, s.employmentType, s.taxMode);
    p.svcGross = round2(s.gross); p.svcWht = round2(s.wht); p.svcGi = round2(s.gi); p.svcNet = round2(s.net);
    byKey.set(k, p);
  }
  for (const m of meetingFees.values()) {
    const k = `${m.userId}|${m.companyId ?? "null"}`;
    const p = byKey.get(k) ?? blank(m.userId, m.companyId, m.displayName, null, m.employmentType, m.taxMode);
    p.mtgGross = round2(p.mtgGross + m.mtgGross); p.mtgWht = round2(p.mtgWht + m.mtgWht); p.mtgNet = round2(p.mtgNet + m.mtgNet);
    byKey.set(k, p);
  }
  // Synthesised rows carry no title_prefix from the SVC/meeting source — look it up.
  const prefixOf = db.prepare("SELECT title_prefix FROM users WHERE id = ?");
  for (const p of byKey.values()) {
    if (!p.hasPayroll) {
      p.titlePrefix = (prefixOf.get(p.userId) as { title_prefix: string | null } | undefined)?.title_prefix ?? null;
      p.name = nameWithPrefix(p.titlePrefix, p.displayName);
    }
    p.income = round2(p.comp + p.svcGross + p.mtgGross);
    p.tax = round2(p.taxWage + p.svcWht + p.mtgWht);
    p.gi = p.svcGi;
    p.ded = round2(p.sso + p.tax + p.gi + p.inRound);
    p.take = round2(p.income - p.ded);
  }

  const rank = (t: string | null) => (t === "ft" ? 0 : t === "pt" ? 1 : 2);
  const people = [...byKey.values()].sort((a, b) =>
    (a.companyId == null ? 1 : 0) - (b.companyId == null ? 1 : 0)
    || (a.companyId ?? 0) - (b.companyId ?? 0)
    || rank(a.employmentType) - rank(b.employmentType)
    || a.displayName.localeCompare(b.displayName, "th"));
  const byCompany = new Map<number | null, MonthPerson[]>();
  for (const p of people) {
    if (!byCompany.has(p.companyId)) byCompany.set(p.companyId, []);
    byCompany.get(p.companyId)!.push(p);
  }
  // A company that only appears through people (e.g. meeting-fee-only) still gets a group.
  for (const key of byCompany.keys()) {
    if (!companies.some((c) => c.key === key)) {
      const name = key == null ? "ไม่ระบุบริษัท"
        : ((db.prepare("SELECT name_th FROM companies WHERE id = ?").get(key) as { name_th: string } | undefined)?.name_th ?? "ไม่ระบุบริษัท");
      companies.push({ key, name });
    }
  }

  return { month, svcMonth, from, to, branches, companies, people, byCompany, byKey, homeByUser };
}
