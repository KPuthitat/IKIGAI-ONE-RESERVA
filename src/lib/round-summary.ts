// Whole-round compensation summary (owner 2026-06-18) — the data behind both the on-screen page and the PDF
// (owner 2026-11-24: a real PDF, not the browser print dialog), so the two always show the same numbers.

import type Database from "better-sqlite3";

export type RoundPeriod = {
  id: number; cycle: "weekly" | "monthly"; target: "pt" | "ft" | "all";
  period_start: string; period_end: string; pay_date: string;
  status: "draft" | "finalized" | "paid" | "cancelled"; branch_id: number | null;
};

export type RoundLine = {
  user_id: number; employee_code: string | null; display_name: string; title_prefix: string | null;
  employment_type: "pt" | "ft" | null; bank_name: string | null; bank_account: string | null;
  days_worked: number; base_pay: number; ot_pay: number; service_charge: number; other_additions: number;
  gross_pay: number; sso_amount: number; tax_amount: number; other_deductions: number;
  drink_deductions: number; mealpass_deductions: number; net_pay: number; special_payment: number; special_paid_out: number;
};

export type RoundCompany = { name_th: string; name_en: string | null; tax_id: string | null; address: string | null; phone: string | null };
export type RoundBranch = { name: string; tax_branch_code: string | null; reg_address: string | null };

export type RoundSummary = {
  period: RoundPeriod; lines: RoundLine[]; company: RoundCompany | null; branch: RoundBranch | null;
  companyCount: number; branchCount: number; addressToShow: string | null;
  tot: { base: number; ot: number; svc: number; add: number; gross: number; sso: number; tax: number; ded: number; welfare: number; net: number };
  totalDeductions: number;
};

export const STATUS_TH: Record<RoundPeriod["status"], string> = { draft: "ฉบับร่าง", finalized: "ยืนยันแล้ว", paid: "จ่ายแล้ว", cancelled: "ยกเลิก" };

export function maskAccount(acc: string | null): string {
  if (!acc) return "—";
  const digits = acc.replace(/\D/g, "");
  if (digits.length < 8) return acc;
  return `${digits.slice(0, 3)}-x-xxxxx-${digits.slice(-1)}`;
}

export const branchTaxLabel = (code: string | null): string => {
  const c = (code ?? "").trim();
  return !c || c === "00000" ? "สำนักงานใหญ่ (00000)" : `สาขาที่ ${c}`;
};

export function buildRoundSummary(db: Database.Database, id: number): RoundSummary | null {
  const period = db.prepare("SELECT id, cycle, target, period_start, period_end, pay_date, status, branch_id FROM payroll_periods WHERE id = ?").get(id) as RoundPeriod | undefined;
  if (!period) return null;

  const lines = db.prepare(`
    SELECT pl.user_id, pl.employee_code, pl.display_name, u.title_prefix, pl.employment_type,
           u.bank_name, u.bank_account,
           pl.days_worked, pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions,
           pl.gross_pay, pl.sso_amount, pl.tax_amount, pl.other_deductions,
           pl.drink_deductions, pl.mealpass_deductions, pl.net_pay, pl.special_payment, pl.special_paid_out
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id = ?
    ORDER BY CASE WHEN pl.employment_type = 'ft' THEN 0 WHEN pl.employment_type = 'pt' THEN 1 ELSE 2 END,
             pl.display_name
  `).all(id) as RoundLine[];
  // เงินช่วยเหลือพิเศษ shows with the other additions, and what was already paid out early (aid + advances) with the
  // other deductions, so every row and the footer tie out to net.
  for (const l of lines) { l.other_additions += l.special_payment; l.other_deductions += l.special_paid_out; }

  // Company on the letterhead = the one the run's employees belong to (owner 2026-06-18), the most common one.
  let company = db.prepare(`
    SELECT c.name_th, c.name_en, c.tax_id, c.address, c.phone
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    JOIN companies c ON c.id = b.company_id
    WHERE pl.period_id = ?
    GROUP BY c.id
    ORDER BY COUNT(*) DESC, c.id ASC
    LIMIT 1
  `).get(id) as RoundCompany | undefined;
  if (!company) {
    company = db.prepare("SELECT name_th, name_en, tax_id, address, phone FROM companies WHERE active = 1 ORDER BY id LIMIT 1").get() as RoundCompany | undefined;
  }
  const companyCount = (db.prepare(`
    SELECT COUNT(DISTINCT b.company_id) AS n
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    WHERE pl.period_id = ? AND b.company_id IS NOT NULL
  `).get(id) as { n: number }).n;

  // Tax establishment (สาขา) the run's employees belong to — "สาขานามะ มัน 00001"; head office = 00000.
  const branch = db.prepare(`
    SELECT b.name, b.tax_branch_code, b.reg_address
    FROM payroll_lines pl
    JOIN user_branches ub ON ub.user_id = pl.user_id
    JOIN branches b ON b.id = ub.branch_id
    WHERE pl.period_id = ?
    GROUP BY b.id
    ORDER BY COUNT(*) DESC, b.id ASC
    LIMIT 1
  `).get(id) as RoundBranch | undefined;
  const branchCount = (db.prepare(`
    SELECT COUNT(DISTINCT ub.branch_id) AS n
    FROM payroll_lines pl JOIN user_branches ub ON ub.user_id = pl.user_id
    WHERE pl.period_id = ?
  `).get(id) as { n: number }).n;
  const addressToShow = branch?.reg_address?.trim() || company?.address || null;

  // Column totals — summed in code so the footer ties out exactly to the rows (never recomputed from rounded strings).
  const tot = lines.reduce((a, l) => ({
    base: a.base + l.base_pay, ot: a.ot + l.ot_pay, svc: a.svc + l.service_charge,
    add: a.add + l.other_additions, gross: a.gross + l.gross_pay,
    sso: a.sso + l.sso_amount, tax: a.tax + l.tax_amount, ded: a.ded + l.other_deductions,
    welfare: a.welfare + l.drink_deductions + l.mealpass_deductions,
    net: a.net + l.net_pay
  }), { base: 0, ot: 0, svc: 0, add: 0, gross: 0, sso: 0, tax: 0, ded: 0, welfare: 0, net: 0 });
  // welfare deductions (drink + cross-company meal) included so the footer ties out to net_pay
  const totalDeductions = tot.sso + tot.tax + tot.ded + tot.welfare;

  return { period, lines, company: company ?? null, branch: branch ?? null, companyCount, branchCount, addressToShow, tot, totalDeductions };
}
