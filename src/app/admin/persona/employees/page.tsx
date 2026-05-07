import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import EmployeesClient, { type EmployeeRow } from "./EmployeesClient";

export const dynamic = "force-dynamic";

export default function AdminEmployeesPage() {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const employees = db.prepare(`
    SELECT id, username, display_name, role,
           gender, employment_type, hire_date, weekly_off_day,
           employee_code, national_id, bank_name, bank_account,
           tax_id, sso_id, hourly_rate, monthly_salary, pay_cycle,
           salary_tax_mode,
           CASE WHEN pin_hash IS NULL THEN 0 ELSE 1 END AS has_pin,
           CASE WHEN resignation_unlocked_at IS NULL THEN 0 ELSE 1 END AS resign_unlocked
    FROM users
    ORDER BY role DESC, display_name ASC
  `).all() as EmployeeRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.employees.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.employees.subtitle")}
        </p>
      </div>
      <EmployeesClient employees={employees} />
    </div>
  );
}
