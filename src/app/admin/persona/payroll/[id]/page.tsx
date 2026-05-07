import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import PeriodDetailClient, { type PeriodDetail, type PayrollLineRow } from "./PeriodDetailClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รอบเงินเดือน · PERSONA" };

export default function PeriodDetailPage({
  params
}: { params: { id: string } }) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const period = db.prepare(`
    SELECT id, cycle, period_start, period_end, pay_date, status,
           ot_mode_snapshot, ot_flat_per_15min_snapshot,
           computed_by, computed_at, finalized_by, finalized_at,
           notes, created_at,
           (SELECT display_name FROM users WHERE id = computed_by) AS computed_by_name,
           (SELECT display_name FROM users WHERE id = finalized_by) AS finalized_by_name
    FROM payroll_periods WHERE id = ?
  `).get(id) as PeriodDetail | undefined;

  if (!period) notFound();

  const lines = db.prepare(`
    SELECT id, user_id, employee_code, display_name, employment_type,
           pay_cycle_snapshot, hourly_rate_snapshot, monthly_salary_snapshot,
           shift_minutes, break_deducted_minutes, regular_minutes, ot_minutes,
           days_worked, leave_days, unpaired_clockins,
           base_pay, ot_pay, service_charge, other_additions, gross_pay,
           sso_amount, tax_amount, other_deductions, net_pay,
           overridden, notes
    FROM payroll_lines
    WHERE period_id = ?
    ORDER BY employment_type DESC, display_name
  `).all(id) as PayrollLineRow[];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
      </div>
      <PeriodDetailClient lang={lang} period={period} lines={lines} />
    </div>
  );
}
