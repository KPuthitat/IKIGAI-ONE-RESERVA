import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rowsToCsv, type CsvCell } from "@/lib/csv";
import { nameWithPrefix } from "@/lib/name";

// GET /api/admin/persona/payroll/summary/csv?m=YYYY-MM
// Per-employee monthly payroll summary as CSV — one row per employee with the
// totals across every pay round whose pay_date falls in the month. For making
// downstream documents (ภ.ง.ด.1 / SSO / bank records). Includes รหัส + เลขบัตร +
// gross / SSO / WHT / net so the sheet feeds those forms directly.

type Row = {
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

export async function GET(req: Request) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (!userCanViewPayroll(user)) return new Response("forbidden", { status: 403 });

  const m = new URL(req.url).searchParams.get("m") ?? "";
  if (!/^\d{4}-\d{2}$/.test(m)) return new Response("invalid_month", { status: 400 });
  const { from, to } = monthRange(m);

  const rows = getDb().prepare(`
    SELECT pl.display_name,
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

  const headers = [
    "ชื่อ-นามสกุล", "รหัสพนักงาน", "เลขบัตรประชาชน", "ประเภทจ้าง", "รูปแบบภาษี",
    "เงินได้รวม", "ประกันสังคม", "ภาษีหัก ณ ที่จ่าย", "เงินสุทธิที่รับ", "จำนวนรอบจ่าย"
  ];
  const typeLabel = (t: string | null) => (t === "ft" ? "รายเดือน (FT)" : t === "pt" ? "รายวัน (PT)" : "");
  const taxLabel = (t: string | null) => (t === "sso" ? "ประกันสังคม" : t === "wht" ? "หัก ณ ที่จ่าย" : "");

  const body: CsvCell[][] = rows.map((r) => [
    nameWithPrefix(r.title_prefix, r.display_name),
    r.employee_code ?? "",
    r.national_id ?? "",
    typeLabel(r.employment_type),
    taxLabel(r.salary_tax_mode_snapshot),
    (r.total_gross ?? 0).toFixed(2),
    (r.total_sso ?? 0).toFixed(2),
    (r.total_tax ?? 0).toFixed(2),
    (r.total_net ?? 0).toFixed(2),
    String(r.period_count ?? 0)
  ]);

  // Totals row
  const sum = (k: keyof Row) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  body.push([
    "รวมทั้งหมด", "", "", "", "",
    sum("total_gross").toFixed(2), sum("total_sso").toFixed(2),
    sum("total_tax").toFixed(2), sum("total_net").toFixed(2), ""
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
