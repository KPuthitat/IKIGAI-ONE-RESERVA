import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rowsToCsv, type CsvCell } from "@/lib/csv";

// GET /api/admin/persona/payroll/periods/[id]/bank-csv
// Generate a generic bank-transfer CSV from all payroll lines in the period.
// Format: bank, account, amount, employee_name, employee_code, reference
// (Each Thai bank's bulk-transfer template is slightly different, but this
//  generic shape is easy to adapt — admin can copy/paste columns.)

type Row = {
  bank_name: string | null;
  bank_account: string | null;
  net_pay: number;
  display_name: string;
  employee_code: string | null;
};

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return new Response("unauthenticated", { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return new Response("forbidden", { status: 403 });

  const periodId = Number(params.id);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    return new Response("invalid_id", { status: 400 });
  }

  const db = getDb();
  const period = db.prepare(`
    SELECT id, period_start, period_end, pay_date, status
    FROM payroll_periods WHERE id = ?
  `).get(periodId) as
    { id: number; period_start: string; period_end: string; pay_date: string; status: string } | undefined;
  if (!period) return new Response("period_not_found", { status: 404 });

  // Allow downloading for finalized + paid (not draft — numbers may still change)
  if (period.status === "draft" || period.status === "cancelled") {
    return new Response("must_be_finalized_or_paid", { status: 400 });
  }

  const rows = db.prepare(`
    SELECT u.bank_name, u.bank_account,
           pl.net_pay, pl.display_name, pl.employee_code
    FROM payroll_lines pl
    JOIN users u ON pl.user_id = u.id
    WHERE pl.period_id = ? AND pl.net_pay > 0
    ORDER BY CASE WHEN pl.employment_type = 'ft' THEN 0 WHEN pl.employment_type = 'pt' THEN 1 ELSE 2 END,
             pl.display_name
  `).all(periodId) as Row[];

  const ref = `PAY-${period.pay_date.replace(/-/g, "")}`;
  const headers = [
    "bank", "account", "amount", "employee_name", "employee_code", "reference"
  ];
  const csvRows: CsvCell[][] = rows.map((r) => [
    r.bank_name ?? "",
    r.bank_account ?? "",
    r.net_pay.toFixed(2),
    r.display_name,
    r.employee_code ?? "",
    ref
  ]);
  const csv = rowsToCsv(headers, csvRows);

  // Add UTF-8 BOM for Excel
  const body = "﻿" + csv;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv;charset=utf-8",
      "Content-Disposition": `attachment; filename="bank-transfer-${period.pay_date}.csv"`
    }
  });
}
