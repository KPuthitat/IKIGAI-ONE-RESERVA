import Link from "next/link";
import { requireAdmin, userCanViewPayroll } from "@/lib/auth";
import { getDb, listRbacRoles, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import EmployeesClient, { type EmployeeRow } from "./EmployeesClient";
import AccountActions from "./AccountActions";

export const dynamic = "force-dynamic";

// Per-branch since 2026-05 (Phase 2): the list shows only employees
// assigned to the admin's currently-active branch (via user_branches).
// One employee can sit in multiple branches and will appear in each.
export default function AdminEmployeesPage({
  searchParams
}: {
  searchParams: { show_test?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();
  // Show test accounts only when explicitly toggled via ?show_test=1.
  // Default: hide them so the list shows only operational staff.
  const showTest = searchParams.show_test === "1";

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  // Excludes `status='disabled'` so soft-deleted accounts don't clutter
  // the list. They still exist in the DB (audit + payroll history) but
  // can't log in and aren't manageable from this UI. Active and
  // pending_invite both show up — pending shows the "ดูลิงก์เชิญ"
  // affordance to retrieve the link.
  const employees = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.status,
           u.title_prefix, u.nickname_th,
           u.gender, u.dob, u.employment_type, u.hire_date, u.weekly_off_days,
           u.employee_code, u.national_id, u.bank_name, u.bank_account,
           u.tax_id, u.sso_id, u.hourly_rate, u.monthly_salary, u.pay_cycle,
           u.salary_tax_mode, u.group_insurance_start_month, u.ft_started_at, u.pt_started_at, u.df_started_at, u.line_user_id, u.shift_start_time,
           u.reports_to_user_id, u.escalation_hours, u.is_test_account,
           u.can_view_payroll, u.track_attendance, u.receives_service_charge,
           u.clinical_role, u.license_no, u.is_hr_analytics, u.meeting_fee_exempt,
           CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,
           CASE WHEN u.resignation_unlocked_at IS NULL THEN 0 ELSE 1 END AS resign_unlocked
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
      ${showTest ? "" : "AND u.is_test_account = 0"}
    ORDER BY
      -- Sort by employee_code (admin uses this as the canonical staff
      -- key in payroll). Empty / NULL codes drop to the bottom so the
      -- list is stable as new hires get codes assigned later.
      CASE WHEN u.employee_code IS NULL OR u.employee_code = '' THEN 1 ELSE 0 END,
      u.employee_code COLLATE NOCASE,
      u.display_name COLLATE NOCASE
  `).all(branch.id) as EmployeeRow[];

  // PDPA (2026-05-30): admins without payroll access see profile data
  // but not salary. We blank the four salary-shaped fields here at
  // the data source rather than threading a flag through every render
  // path — anything that tries to read them downstream just sees
  // null, exactly like an unset employee.
  const canSeePayroll = userCanViewPayroll(user);
  const safeEmployees: EmployeeRow[] = canSeePayroll
    ? employees
    : employees.map((e) => ({
        ...e,
        hourly_rate: null,
        monthly_salary: null,
        pay_cycle: null,
        salary_tax_mode: null,
        group_insurance_start_month: null,
        ft_started_at: null
      }));

  // Quick count of hidden test accounts so admin knows they exist.
  const testCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.status NOT IN ('disabled', 'resigned', 'terminated') AND u.is_test_account = 1
  `).get(branch.id) as { n: number }).n;

  // All branches + every listed employee's memberships — drives the
  // "สิทธิ์เข้าสาขา" editor in the edit modal. editableBranchIds
  // limits what THIS admin may toggle (super_admin → all; sub-admin
  // → only branches they administer).
  const allBranches = db.prepare(
    "SELECT id, name FROM branches ORDER BY display_order, name"
  ).all() as Array<{ id: number; name: string }>;

  const empIds = employees.map((e) => e.id);
  const grants =
    empIds.length > 0
      ? (db.prepare(
          `SELECT user_id, branch_id, is_primary, hourly_rate, daily_rate FROM user_branches
           WHERE user_id IN (${empIds.map(() => "?").join(",")})`
        ).all(...empIds) as Array<{ user_id: number; branch_id: number; is_primary: number; hourly_rate: number | null; daily_rate: number | null }>)
          // PDPA: per-branch rate is pay data — blank it for admins without
          // payroll access, same as the salary fields on the employee rows.
          .map((g) => canSeePayroll ? g : { ...g, hourly_rate: null, daily_rate: null })
      : [];

  const editableBranchIds =
    user.role === "super_admin"
      ? allBranches.map((b) => b.id)
      : user.adminBranchIds;

  // RBAC role assignment (2026-06-04) — only super_admin manages roles,
  // so we only fetch the catalog + current grants for them. Everyone
  // else gets empty arrays (the assignment section is hidden anyway).
  const allRoles =
    user.role === "super_admin"
      ? listRbacRoles().map((r) => ({
          id: r.id,
          name: r.name,
          permissions: r.permissions
        }))
      : [];
  const roleIdsByUser: Record<number, number[]> = {};
  if (user.role === "super_admin" && empIds.length > 0) {
    const roleGrants = db.prepare(
      `SELECT user_id, role_id FROM rbac_user_roles
       WHERE user_id IN (${empIds.map(() => "?").join(",")})`
    ).all(...empIds) as Array<{ user_id: number; role_id: number }>;
    for (const g of roleGrants) {
      (roleIdsByUser[g.user_id] ??= []).push(g.role_id);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.employees.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.employees.subtitle")}
        </p>
      </div>
      <AccountActions
        branchId={branch.id}
        canCreateAdmin={user.role === "super_admin"}
      />
      {/* Test-account visibility toggle. Hidden by default so the
          operational list stays clean; admin can flip the link to
          show + manage test accounts when needed. Count gives a hint
          they exist even when hidden. */}
      {(testCount > 0 || showTest) && (
        <div className="text-xs text-slate-500 flex items-center gap-2">
          {showTest ? (
            <>
              <span className="text-amber-700 font-semibold">
                แสดงบัญชีทดสอบด้วย ({testCount} บัญชี)
              </span>
              <Link href="/admin/persona/employees"
                className="text-brand hover:underline">
                ← ซ่อน
              </Link>
            </>
          ) : (
            <Link href="/admin/persona/employees?show_test=1"
              className="text-slate-500 hover:text-brand">
              · มีบัญชีทดสอบที่ซ่อนอยู่ {testCount} บัญชี — กดเพื่อแสดง
            </Link>
          )}
        </div>
      )}
      <EmployeesClient
        employees={safeEmployees}
        allBranches={allBranches}
        grants={grants}
        editableBranchIds={editableBranchIds}
        // Role drives which super_admin-only sections show in the edit
        // modal (payroll grant, health-data access, RBAC roles).
        currentUserRole={user.role}
        // RBAC — full role catalog + each employee's current role ids
        // (super_admin only; empty for other admins). Drives the
        // "บทบาทการเข้าถึงระบบ" assignment section in the edit modal.
        allRoles={allRoles}
        roleIdsByUser={roleIdsByUser}
        // PDPA: drives the conditional render of the salary section
        // inside the edit modal. Server already strips salary fields
        // from the row data (above), but the modal would still SHOW
        // empty inputs labelled "ค่าจ้าง" — confusing for admins who
        // can't see the data. Hiding the inputs entirely is cleaner.
        canViewPayroll={canSeePayroll}
      />
    </div>
  );
}
