import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requirePayrollAccess, getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import PeriodDetailClient, { type PeriodDetail, type PayrollLineRow } from "./PeriodDetailClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รอบค่าตอบแทน · PERSONA" };

export default function PeriodDetailPage({
  params
}: { params: { id: string } }) {
  const user = requirePayrollAccess();
  const lang = getLang();
  const db = getDb();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) notFound();

  const period = db.prepare(`
    SELECT id, cycle, target, data_source, period_start, period_end, pay_date, status,
           ot_mode_snapshot, ot_flat_per_15min_snapshot,
           computed_by, computed_at, finalized_by, finalized_at, paid_by, paid_at,
           posted_by, posted_at,
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

  const periodBranchId = (db.prepare("SELECT branch_id FROM payroll_periods WHERE id = ?")
    .get(id) as { branch_id: number | null }).branch_id;

  const lines = db.prepare(`
    SELECT pl.id, pl.user_id, pl.employee_code, pl.display_name, pl.employment_type,
           u.title_prefix,
           pl.pay_cycle_snapshot, pl.hourly_rate_snapshot, pl.monthly_salary_snapshot,
           pl.salary_tax_mode_snapshot, pl.holiday_minutes,
           pl.shift_minutes, pl.break_deducted_minutes, pl.regular_minutes, pl.ot_minutes,
           pl.days_worked, pl.leave_days, pl.unpaid_leave_days, pl.unpaired_clockins,
           pl.base_pay, pl.ot_pay, pl.service_charge, pl.other_additions, pl.gross_pay,
           pl.sso_amount, pl.tax_amount, pl.other_deductions, pl.drink_deductions, pl.net_pay,
           pl.overridden, pl.notes, pl.reviewed_at,
           (SELECT display_name FROM users WHERE id = pl.reviewed_by) AS reviewed_by_name
    FROM payroll_lines pl
    LEFT JOIN users u ON u.id = pl.user_id
    WHERE pl.period_id = @pid
      -- Hide FT rows with no salary set (owner 2026-07-12: e.g. accounts that
      -- haven't been configured shouldn't clutter the payroll table).
      AND NOT (pl.employment_type = 'ft' AND COALESCE(pl.monthly_salary_snapshot, 0) = 0)
      -- Hide an FT's all-zero line at a branch that ISN'T their home branch
      -- (owner 2026-07-27: ธนโชติ ผู้บริหารโผล่สองสาขา). FT salary pays only at
      -- the home branch, so a non-home line with no OT/service charge (gross 0)
      -- is pure noise. Kept when it carries real money earned at that branch.
      AND NOT (
        pl.employment_type = 'ft' AND COALESCE(pl.gross_pay, 0) = 0
        AND @pbranch IS NOT NULL
        AND @pbranch != COALESCE(
          (SELECT branch_id FROM user_branches WHERE user_id = pl.user_id AND is_primary = 1 LIMIT 1),
          (SELECT MIN(branch_id) FROM user_branches WHERE user_id = pl.user_id)
        )
      )
    ORDER BY CASE WHEN pl.employment_type = 'ft' THEN 0 WHEN pl.employment_type = 'pt' THEN 1 ELSE 2 END,
             pl.display_name
  `).all({ pid: id, pbranch: periodBranchId }) as PayrollLineRow[];

  // Staff list for "Add employee" picker — scoped to admin's active
  // branch so AT-HOME admin doesn't see NAMA staff in the picker.
  // Excludes those already in the period. Includes all staff users
  // (even those without employment_type set) so admin can add anyone
  // (e.g. contractors) — the line starts at zero anyway.
  // (super_admin sees all branches' staff since they manage the
  // whole company; falls back to no branch filter for them.)
  const branchFilter = user.role === "super_admin"
    ? ""
    : "AND id IN (SELECT user_id FROM user_branches WHERE branch_id = ?)";
  const addableParams: Array<number> = [id];
  if (user.role !== "super_admin" && user.activeBranchId) {
    addableParams.push(user.activeBranchId);
  }
  const addableStaff = db.prepare(`
    SELECT id, display_name, title_prefix, employment_type
    FROM users
    WHERE role IN ('staff', 'admin')
      AND is_test_account = 0
      AND id NOT IN (SELECT user_id FROM payroll_lines WHERE period_id = ?)
      ${branchFilter}
    ORDER BY CASE WHEN employment_type = 'ft' THEN 0 WHEN employment_type = 'pt' THEN 1 ELSE 2 END,
             display_name
  `).all(...addableParams) as Array<{ id: number; display_name: string; title_prefix: string | null; employment_type: "pt" | "ft" | null }>;

  // "พนักงานที่ตกหล่นจากรอบ" — employees who match THIS period's type + branch
  // but aren't in the payroll_lines snapshot yet (owner 2026-07-27: พนักงานใหม่
  // หายไปจากรอบ). A period is computed ONCE at creation, so anyone added later
  // (a new hire) is invisible until a recompute / manual add. This surfaces
  // them so the admin can pull them in before finalizing. Mirrors the engine's
  // eligibility (type by cycle, branch membership, FT-with-salary, live status)
  // and flags anyone whose hire_date lands after the period end (won't be
  // auto-added by a full recompute — needs a manual add).
  const missingStaff = db.prepare(`
    WITH p AS (SELECT branch_id, cycle, period_start, period_end FROM payroll_periods WHERE id = @pid)
    SELECT u.id, u.display_name, u.title_prefix, u.employment_type, u.hire_date,
           0 AS hire_after_period
    FROM users u
    WHERE u.role IN ('staff', 'admin')
      AND u.is_test_account = 0
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND u.employment_type = CASE WHEN (SELECT cycle FROM p) = 'monthly' THEN 'ft' ELSE 'pt' END
      AND NOT (u.employment_type = 'ft' AND COALESCE(u.monthly_salary, 0) = 0)
      -- A future hire (starts AFTER this round ended) never belongs in a past
      -- round (owner 2026-07-31: หิรัญญา เข้า 1/08 ไม่ควรถูก flag ในรอบ ก.ค.).
      -- Mirrors the engine's own eligibility (hire_date <= period_end).
      AND (u.hire_date IS NULL OR u.hire_date <= (SELECT period_end FROM p))
      AND u.id NOT IN (SELECT user_id FROM payroll_lines WHERE period_id = @pid)
      AND (
        (SELECT branch_id FROM p) IS NULL
        OR u.id IN (SELECT user_id FROM user_branches WHERE branch_id = (SELECT branch_id FROM p))
      )
      -- Only nudge to add someone who was actually ROSTERED at this branch during
      -- the period (owner 2026-08-01: เช็คตารางเวรก่อน ไม่มีเวร = ไม่ต้องพูดถึง).
      -- อนุธิดา สังกัดไฮโปแต่ไม่มีเวรที่ไฮโปในรอบนี้ → ไม่ต้อง flag. Legacy
      -- NULL-branch periods count a work shift at any branch.
      AND EXISTS (
        SELECT 1 FROM roster_assignments ra
        JOIN shift_codes sc ON sc.id = ra.shift_code_id
        WHERE ra.user_id = u.id
          AND ra.assignment_date >= (SELECT period_start FROM p)
          AND ra.assignment_date <= (SELECT period_end FROM p)
          AND sc.kind = 'work'
          AND ((SELECT branch_id FROM p) IS NULL OR ra.branch_id = (SELECT branch_id FROM p))
      )
    ORDER BY u.display_name
  `).all({ pid: id }) as Array<{
    id: number; display_name: string; title_prefix: string | null;
    employment_type: "pt" | "ft" | null; hire_date: string | null; hire_after_period: number;
  }>;

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
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/admin/persona/payroll" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.payroll.backToHub")}
        </Link>
        <Link href={`/admin/persona/payroll/${id}/summary`}
          className="text-sm text-brand hover:underline ml-auto">
          สรุปทั้งรอบ (PDF สำหรับบัญชี) →
        </Link>
      </div>
      <PeriodDetailClient
        lang={lang}
        period={period}
        lines={lines}
        addableStaff={addableStaff}
        missingStaff={missingStaff}
        unlockHistory={unlockHistory}
        userPinSet={pinSet}
        staleSnapshotCount={staleCount}
      />
    </div>
  );
}
