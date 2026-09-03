import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rowsToCsv, type CsvCell } from "@/lib/csv";
import { nameWithPrefix } from "@/lib/name";
import { computeMonthlySvcSummary, computeCompanySvcSummary } from "@/lib/service-charge";

// GET /api/admin/persona/payroll/summary/csv?m=YYYY-MM
// Per-employee monthly payroll summary as CSV — one row per employee with the
// totals across every pay round whose pay_date falls in the month, PLUS the
// service charge that hit their pocket that month (owner 2026-09-03: the sheet
// feeds the ใบหัก ณ ที่จ่าย, which MUST include SVC income + its 3% WHT). For
// making downstream documents (ภ.ง.ด.1 / SSO / bank). Includes รหัส + เลขบัตร +
// ค่าตอบแทน / เซอร์วิสชาร์จ / เงินได้รวม / ปกส. / ภาษี / ประกันกลุ่ม / สุทธิ.

type Row = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  employee_code: string | null;
  national_id: string | null;
  employment_type: "pt" | "ft" | null;
  salary_tax_mode_snapshot: "sso" | "wht" | null;
  total_gross: number;
  total_sso: number;
  total_tax: number;
  total_net: number;
  period_count: number;
};

function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });

  const m = new URL(req.url).searchParams.get("m") ?? "";
  if (!/^\d{4}-\d{2}$/.test(m)) return new Response("invalid_month", { status: 400 });
  const { from, to } = monthRange(m);
  const db = getDb();

  const rows = db.prepare(`
    SELECT pl.user_id,
           pl.display_name,
           u.title_prefix,
           MAX(pl.employee_code) AS employee_code,
           u.national_id,
           MAX(pl.employment_type) AS employment_type,
           MAX(pl.salary_tax_mode_snapshot) AS salary_tax_mode_snapshot,
           SUM(pl.gross_pay)  AS total_gross,
           SUM(pl.sso_amount) AS total_sso,
           SUM(pl.tax_amount) AS total_tax,
           SUM(pl.net_pay)    AS total_net,
           COUNT(*)            AS period_count
    FROM payroll_lines pl
    JOIN payroll_periods pp ON pl.period_id = pp.id
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pp.pay_date >= ? AND pp.pay_date <= ?
    GROUP BY pl.user_id
    ORDER BY (MAX(pl.employment_type) = 'ft') DESC,
             (MAX(pl.employment_type) = 'pt') DESC,
             pl.display_name
  `).all(from, to) as Row[];

  // Service charge landing in THIS month = the PREVIOUS month's accrual, paid ~the
  // 20th (owner 2026-08-02) — same rule as the summary page and the payslip. Source
  // it from the SAME engine as the real payout (computeCompanySvcSummary: shared-
  // pool + gross-override aware) so the certificate ties out to the pocket. Summed
  // per USER across companies for this flat per-employee sheet.
  const svcMonth = shiftMonth(m, -1);
  type SvcAgg = { gross: number; wht: number; gi: number; net: number;
    displayName: string; employmentType: string | null; taxMode: "sso" | "wht" };
  const svcByUser = new Map<number, SvcAgg>();
  const addSvc = (r: { userId: number; displayName: string; employmentType: string | null; taxMode: "sso" | "wht";
    netAllocation: number; whtAmount: number; groupInsurance: number; netPayout: number }) => {
    if (!r.netAllocation && !r.netPayout) return;
    const cur = svcByUser.get(r.userId)
      ?? { gross: 0, wht: 0, gi: 0, net: 0, displayName: r.displayName, employmentType: r.employmentType, taxMode: r.taxMode };
    cur.gross += r.netAllocation; cur.wht += r.whtAmount; cur.gi += r.groupInsurance; cur.net += r.netPayout;
    svcByUser.set(r.userId, cur);
  };
  // Branches = payroll periods paying this month ∪ SVC activity in svcMonth, so a
  // person/company with only service charge (e.g. ศาลาชิลล์) isn't dropped from the
  // tax sheet (owner 2026-09-03).
  const companyBranches = db.prepare(`
    SELECT DISTINCT branch_id, company_id FROM (
      SELECT b.id AS branch_id, b.company_id AS company_id
      FROM payroll_periods pp JOIN branches b ON b.id = pp.branch_id
      WHERE pp.pay_date >= @from AND pp.pay_date <= @to AND pp.branch_id IS NOT NULL
      UNION
      SELECT b.id AS branch_id, b.company_id AS company_id
      FROM branches b
      WHERE b.id IN (SELECT DISTINCT branch_id FROM daily_service_charge WHERE substr(date, 1, 7) = @svc)
    )
  `).all({ from, to, svc: svcMonth }) as Array<{ branch_id: number; company_id: number | null }>;
  const seenCompany = new Set<number>();
  for (const cb of companyBranches) {
    if (cb.company_id == null || seenCompany.has(cb.company_id)) continue;
    seenCompany.add(cb.company_id);
    try { for (const r of computeCompanySvcSummary(cb.company_id, svcMonth).rows) addSvc(r); }
    catch { /* svc data may be absent for a company */ }
  }
  for (const cb of companyBranches) {
    if (cb.company_id != null) continue; // pre-migration NULL-company branch
    try { for (const r of computeMonthlySvcSummary(cb.branch_id, svcMonth).rows) addSvc(r); }
    catch { /* no svc for this branch */ }
  }
  const svcFor = (userId: number): SvcAgg =>
    svcByUser.get(userId) ?? { gross: 0, wht: 0, gi: 0, net: 0, displayName: "", employmentType: null, taxMode: "sso" };

  // SVC-only people (received service charge but no payroll round this month) —
  // synthesise a zero-wage Row so the sheet + the ใบหัก ณ ที่จ่าย include them.
  const payrollUserIds = new Set(rows.map((r) => r.user_id));
  const svcOnlyIds = [...svcByUser.keys()].filter((id) => !payrollUserIds.has(id));
  if (svcOnlyIds.length > 0) {
    const ph = svcOnlyIds.map(() => "?").join(",");
    const extra = db.prepare(`
      SELECT id AS user_id, display_name, title_prefix, employee_code, national_id,
             employment_type, salary_tax_mode
      FROM users WHERE id IN (${ph})
    `).all(...svcOnlyIds) as Array<{
      user_id: number; display_name: string; title_prefix: string | null;
      employee_code: string | null; national_id: string | null;
      employment_type: "pt" | "ft" | null; salary_tax_mode: "sso" | "wht" | null;
    }>;
    const byId = new Map(extra.map((e) => [e.user_id, e]));
    for (const id of svcOnlyIds) {
      const s = svcByUser.get(id)!;
      const u = byId.get(id);
      rows.push({
        user_id: id,
        display_name: u?.display_name ?? s.displayName,
        title_prefix: u?.title_prefix ?? null,
        employee_code: u?.employee_code ?? null,
        national_id: u?.national_id ?? null,
        employment_type: u?.employment_type ?? ((s.employmentType === "ft" || s.employmentType === "pt") ? s.employmentType : null),
        salary_tax_mode_snapshot: u?.salary_tax_mode ?? s.taxMode,
        total_gross: 0, total_sso: 0, total_tax: 0, total_net: 0, period_count: 0
      });
    }
  }

  const headers = [
    "ชื่อ-นามสกุล", "รหัสพนักงาน", "เลขบัตรประชาชน", "ประเภทจ้าง", "รูปแบบภาษี",
    "ค่าตอบแทน", "เซอร์วิสชาร์จ", "เงินได้รวม",
    "ประกันสังคม", "ภาษีหัก ณ ที่จ่าย", "ประกันกลุ่ม", "เงินสุทธิที่รับ", "จำนวนรอบจ่าย"
  ];
  const typeLabel = (t: string | null) => (t === "ft" ? "รายเดือน (FT)" : t === "pt" ? "รายวัน (PT)" : "");
  const taxLabel = (t: string | null) => (t === "sso" ? "ประกันสังคม" : t === "wht" ? "หัก ณ ที่จ่าย" : "");

  // Per-employee figures in the page's statement order: ค่าตอบแทน + SVC gross =
  // เงินได้รวม; ภาษี = wage WHT + SVC WHT; สุทธิ = income − (ปกส. + ภาษี + ประกันกลุ่ม).
  const figures = (r: Row) => {
    const svc = svcFor(r.user_id);
    const comp = r.total_gross ?? 0;
    const income = comp + svc.gross;
    const sso = r.total_sso ?? 0;
    const tax = (r.total_tax ?? 0) + svc.wht;
    const gi = svc.gi;
    return { comp, svcGross: svc.gross, income, sso, tax, gi, take: income - sso - tax - gi };
  };

  const body: CsvCell[][] = rows.map((r) => {
    const f = figures(r);
    return [
      nameWithPrefix(r.title_prefix, r.display_name),
      r.employee_code ?? "",
      r.national_id ?? "",
      typeLabel(r.employment_type),
      taxLabel(r.salary_tax_mode_snapshot),
      f.comp.toFixed(2),
      f.svcGross.toFixed(2),
      f.income.toFixed(2),
      f.sso.toFixed(2),
      f.tax.toFixed(2),
      f.gi.toFixed(2),
      f.take.toFixed(2),
      String(r.period_count ?? 0)
    ];
  });

  // Totals row
  const tot = rows.reduce(
    (a, r) => {
      const f = figures(r);
      return {
        comp: a.comp + f.comp, svcGross: a.svcGross + f.svcGross, income: a.income + f.income,
        sso: a.sso + f.sso, tax: a.tax + f.tax, gi: a.gi + f.gi, take: a.take + f.take
      };
    },
    { comp: 0, svcGross: 0, income: 0, sso: 0, tax: 0, gi: 0, take: 0 }
  );
  body.push([
    "รวมทั้งหมด", "", "", "", "",
    tot.comp.toFixed(2), tot.svcGross.toFixed(2), tot.income.toFixed(2),
    tot.sso.toFixed(2), tot.tax.toFixed(2), tot.gi.toFixed(2), tot.take.toFixed(2), ""
  ]);

  const csv = "﻿" + rowsToCsv(headers, body); // BOM for Excel Thai
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="payroll-summary-${m}.csv"`
    }
  });
}
