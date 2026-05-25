import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import EmployeesClient, { type EmployeeRow } from "./EmployeesClient";
import AccountActions from "./AccountActions";

export const dynamic = "force-dynamic";

// Per-branch since 2026-05 (Phase 2): the list shows only employees
// assigned to the admin's currently-active branch (via user_branches).
// One employee can sit in multiple branches and will appear in each.
export default function AdminEmployeesPage() {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

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
           u.title_prefix,
           u.gender, u.employment_type, u.hire_date, u.weekly_off_days,
           u.employee_code, u.national_id, u.bank_name, u.bank_account,
           u.tax_id, u.sso_id, u.hourly_rate, u.monthly_salary, u.pay_cycle,
           u.salary_tax_mode, u.line_user_id, u.shift_start_time,
           u.reports_to_user_id, u.escalation_hours,
           CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,
           CASE WHEN u.resignation_unlocked_at IS NULL THEN 0 ELSE 1 END AS resign_unlocked
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.status != 'disabled'
    ORDER BY
      -- Sort by employee_code (admin uses this as the canonical staff
      -- key in payroll). Empty / NULL codes drop to the bottom so the
      -- list is stable as new hires get codes assigned later.
      CASE WHEN u.employee_code IS NULL OR u.employee_code = '' THEN 1 ELSE 0 END,
      u.employee_code COLLATE NOCASE,
      u.display_name COLLATE NOCASE
  `).all(branch.id) as EmployeeRow[];

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
          `SELECT user_id, branch_id FROM user_branches
           WHERE user_id IN (${empIds.map(() => "?").join(",")})`
        ).all(...empIds) as Array<{ user_id: number; branch_id: number }>)
      : [];

  const editableBranchIds =
    user.role === "super_admin"
      ? allBranches.map((b) => b.id)
      : user.adminBranchIds;

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
      <EmployeesClient
        employees={employees}
        allBranches={allBranches}
        grants={grants}
        editableBranchIds={editableBranchIds}
      />
    </div>
  );
}
