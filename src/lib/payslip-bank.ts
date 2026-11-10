// Data for the formal A4 monthly payslip used outside the company (bank / loan /
// visa). Shared by the admin page and the staff self-service page so both print the
// exact same document. Figures come from monthlyPayrollRollup (single data set).
import type Database from "better-sqlite3";
import { nameWithPrefix } from "@/lib/name";
import { monthlyPayrollRollup } from "@/lib/payroll-month";

const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const round2 = (n: number) => Math.round(n * 100) / 100;

export function bkkToday(): string {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
export function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m - 1]} ${y + 543}`;
}

export type BankPayslip = {
  month: string; monthText: string; docNo: string; issued: string;
  company: { name_th: string; tax_id: string | null; address: string | null; phone: string | null } | null;
  name: string; employeeCode: string | null; empType: string;
  bankName: string | null; bankAccount: string | null;
  lastPay: string | null; allPaid: boolean;
  income: number; ded: number; net: number;
  incomeRows: Array<[string, number]>; dedRows: Array<[string, number]>;
};

export function buildBankPayslip(db: Database.Database, userId: number, month: string): BankPayslip | null {
  const rollup = monthlyPayrollRollup(db, month);
  const mine = rollup.people.filter((p) => p.userId === userId);
  if (mine.length === 0) return null;

  const profile = db.prepare(
    "SELECT display_name, title_prefix, employee_code, bank_name, bank_account FROM users WHERE id = ?"
  ).get(userId) as { display_name: string; title_prefix: string | null; employee_code: string | null; bank_name: string | null; bank_account: string | null } | undefined;
  if (!profile) return null;

  const sum = (f: (p: (typeof mine)[number]) => number) => round2(mine.reduce((a, p) => a + f(p), 0));
  const wage = sum((p) => p.comp);
  const svc = round2(sum((p) => p.svcGross) + sum((p) => p.mtgGross) + sum((p) => p.dutyGross));
  const income = sum((p) => p.income);
  const sso = sum((p) => p.sso);
  const tax = sum((p) => p.tax);
  const gi = sum((p) => p.gi);
  const other = round2(sum((p) => p.ded) - sso - tax - gi);
  const ded = sum((p) => p.ded);
  const net = sum((p) => p.take);

  // The paying company = the one that paid this person the most this month.
  const main = [...mine].sort((a, b) => b.income - a.income)[0];
  const company = main.companyId != null
    ? (db.prepare("SELECT name_th, tax_id, address, phone FROM companies WHERE id = ?")
        .get(main.companyId) as { name_th: string; tax_id: string | null; address: string | null; phone: string | null } | undefined)
    : undefined;

  // Pay dates + whether every round has actually been paid (a draft slip must not
  // be handed to a bank as proof of income).
  const rounds = db.prepare(`
    SELECT pp.pay_date, pp.status FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.pay_date >= ? AND pp.pay_date <= ? AND pp.branch_id IS NOT NULL AND pp.status != 'cancelled'
    ORDER BY pp.pay_date
  `).all(userId, `${month}-01`, `${month}-31`) as Array<{ pay_date: string; status: string }>;
  const allPaid = rounds.length > 0 && rounds.every((r) => r.status === "paid");
  const lastPay = rounds.length ? rounds[rounds.length - 1].pay_date : null;

  const [y, m] = month.split("-").map(Number);
  const monthText = `${TH_MONTHS[m - 1]} ${y + 543}`;
  const docNo = `PS-${month.replace("-", "")}-${(profile.employee_code ?? String(userId)).replace(/\s+/g, "")}`;
  const issued = bkkToday();
  const name = nameWithPrefix(profile.title_prefix, profile.display_name);
  const empType = main.employmentType === "ft" ? "พนักงานประจำ" : main.employmentType === "pt" ? "พนักงานรายชั่วโมง (พาร์ทไทม์)" : "—";

  const incomeRows: Array<[string, number]> = [];
  if (wage > 0) incomeRows.push(["ค่าตอบแทน / เงินเดือน (รวมค่าล่วงเวลาและรายได้อื่น)", wage]);
  if (svc > 0) incomeRows.push(["เซอร์วิสชาร์จ / เบี้ยประชุม / ค่าตอบแทนพิเศษ", svc]);
  const dedRows: Array<[string, number]> = [];
  if (sso > 0) dedRows.push(["ประกันสังคม", sso]);
  if (tax > 0) dedRows.push(["ภาษีหัก ณ ที่จ่าย", tax]);
  if (gi > 0) dedRows.push(["เบี้ยประกันกลุ่ม", gi]);
  if (other > 0) dedRows.push(["รายการหักอื่น ๆ", other]);


  return {
    month, monthText, docNo, issued, company: company ?? null, name, employeeCode: profile.employee_code, empType,
    bankName: profile.bank_name, bankAccount: profile.bank_account,
    lastPay, allPaid, income, ded, net, incomeRows, dedRows
  };
}

/** Months in which every pay round of this person is paid (staff may only print these). */
export function paidBankPayslipMonths(db: Database.Database, userId: number): string[] {
  const rows = db.prepare(`
    SELECT substr(pp.pay_date, 1, 7) AS ym,
           SUM(CASE WHEN pp.status = 'paid' THEN 0 ELSE 1 END) AS open_rounds
    FROM payroll_lines pl JOIN payroll_periods pp ON pp.id = pl.period_id
    WHERE pl.user_id = ? AND pp.branch_id IS NOT NULL AND pp.status != 'cancelled'
    GROUP BY ym ORDER BY ym DESC
  `).all(userId) as Array<{ ym: string; open_rounds: number }>;
  return rows.filter((r) => r.open_rounds === 0).map((r) => r.ym);
}
