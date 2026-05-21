import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireAdmin, getSessionUser } from "@/lib/auth";
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
    SELECT id, cycle, target, data_source, period_start, period_end, pay_date, status,
           ot_mode_snapshot, ot_flat_per_15min_snapshot,
           computed_by, computed_at, finalized_by, finalized_at, paid_by, paid_at,
           notes, created_at,
           (SELECT display_name FROM users WHERE id = computed_by) AS computed_by_name,
           (SELECT title_prefix FROM users WHERE id = computed_by) AS computed_by_prefix,
           (SELECT display_name FROM users WHERE id = finalized_by) AS finalized_by_name,
           (SELECT title_prefix FROM users WHERE id = finalized_by) AS finalized_by_prefix,
           (SELECT display_name FROM users WHERE id = paid_by) AS paid_by_name,
           (SELECT title_prefix FROM users WHERE id = paid_by) AS paid_by_prefix
    FROM payroll_periods WHERE id = ?
  `).get(id) as PeriodDetail | undefined;

  if (!period) notFound();

  const lines = db.prepare(`
    SELECT pl.id, pl.user_id, pl.employee_code, pl.display_name, pl.employment_type,
           u.title_prefix,
           pl.pay_cycle_snapshot, pl.hourly_rate_snapshot, pl.monthly_salary_snapshot,
           pl.salary_tax_mode_snapshot, pl.holiday_minutes,
           pl.shift_minutes, pl.break_deducted_minutes, pl.regular_minutes, pl.ot_minutes,
           pl.days_worked, pl.leave_days, pl.unpaired_clockins,
           pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions, pl.gross_pay,
           pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.net_pay,
           pl.overridden, pl.notes
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id = ?
    ORDER BY CASE WHEN pl.employment_type = 'ft' THEN 0 WHEN pl.employment_type = 'pt' THEN 1 ELSE 2 END,
             pl.display_name
  `).all(id) as PayrollLineRow[];

  // Staff list for "Add employee" picker — exclude those already in the period.
  // Includes all staff users (even those without employment_type set) so admin
  // can add anyone (e.g. contractors) — the line starts at zero anyway.
  const addableStaff = db.prepare(`
    SELECT id, display_name, title_prefix, employment_type
    FROM users
    WHERE role = 'staff'
      AND id NOT IN (SELECT user_id FROM payroll_lines WHERE period_id = ?)
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `).all(id) as Array<{ id: number; display_name: string; title_prefix: string | null; employment_type: "pt" | "ft" | null }>;

  // Audit history for this period — both 'unlock' (paid→finalized) and
  // 'force_open' (created early) events. Newest first.
  const unlockHistory = db.prepare(`
    SELECT pu.id, pu.reason, pu.unlocked_at, pu.action,
           u.display_name AS unlocked_by_name,
           u.title_prefix AS unlocked_by_prefix
    FROM payroll_period_unlocks pu
    LEFT JOIN users u ON pu.unlocked_by = u.id
    WHERE pu.period_id = ?
    ORDER BY pu.unlocked_at DESC
  `).all(id) as Array<{
    id: number; reason: string; unlocked_at: string; action: string;
    unlocked_by_name: string | null;
    unlocked_by_prefix: string | null;
  }>;

  // Has the current admin set their PIN? (same PIN used everywhere — no
  // separate "superadmin" PIN). Used to enable/disable the unlock UI.
  const sessionUser = getSessionUser();
  const pinSet = sessionUser ? !!(db.prepare(`
    SELECT pin_hash FROM users WHERE id = ?
  `).get(sessionUser.id) as { pin_hash: string | null } | undefined)?.pin_hash : false;

  // Stale-snapshot check — count lines whose snapshot disagrees with the
  // user's CURRENT salary_tax_mode / rates (ignoring overridden lines, since
  // admin manually picked those values).
  const staleCount = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM payroll_lines pl
    JOIN users u ON pl.user_id = u.id
    WHERE pl.period_id = ?
      AND pl.overridden = 0
      AND (
        COALESCE(pl.salary_tax_mode_snapshot, '') != COALESCE(u.salary_tax_mode, '')
        OR COALESCE(pl.hourly_rate_snapshot, -1) != COALESCE(u.hourly_rate, -1)
        OR COALESCE(pl.monthly_salary_snapshot, -1) != COALESCE(u.monthly_salary, -1)
        OR COALESCE(pl.pay_cycle_snapshot, '') != COALESCE(u.pay_cycle, '')
      )
  `).get(id) as { n: number }).n;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
      </div>
      <PeriodDetailClient
        lang={lang}
        period={period}
        lines={lines}
        addableStaff={addableStaff}
        unlockHistory={unlockHistory}
        userPinSet={pinSet}
        staleSnapshotCount={staleCount}
      />
    </div>
  );
}
