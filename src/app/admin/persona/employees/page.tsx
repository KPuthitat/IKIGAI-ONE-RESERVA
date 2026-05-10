import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import EmployeesClient, { type EmployeeRow } from "./EmployeesClient";

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

  const employees = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role,
           u.gender, u.employment_type, u.hire_date, u.weekly_off_days,
           u.employee_code, u.national_id, u.bank_name, u.bank_account,
           u.tax_id, u.sso_id, u.hourly_rate, u.monthly_salary, u.pay_cycle,
           u.salary_tax_mode, u.line_user_id,
           CASE WHEN u.pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,
           CASE WHEN u.resignation_unlocked_at IS NULL THEN 0 ELSE 1 END AS resign_unlocked
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    ORDER BY u.role DESC,
             CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name ASC
  `).all(branch.id) as EmployeeRow[];

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
      <EmployeesClient employees={employees} />
    </div>
  );
}
