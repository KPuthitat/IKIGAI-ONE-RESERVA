import type { Metadata } from "next";
import Link from "next/link";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { listTerminations } from "@/lib/termination";
import TerminationClient, { type TermEmployee } from "./TerminationClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · เลิกจ้าง" };

export default function TerminationPage() {
  const user = getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin" && user.role !== "super_admin") redirect("/admin");

  const db = getDb();
  const canSeeSalary = userCanViewPayroll(user);

  // Active employees the admin may terminate (staff + admin; super_admin
  // rows are only listed for a super_admin operator). Salary is included
  // only when the operator has payroll access (PDPA) — otherwise the
  // severance amount is computed server-side on submit and shown after.
  const roleScope = user.role === "super_admin"
    ? "('staff','admin','super_admin')"
    : "('staff')";
  const employees = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.employment_type, u.hire_date,
           ${canSeeSalary ? "u.monthly_salary" : "NULL"} AS monthly_salary,
           (SELECT b.name FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
             WHERE ub.user_id = u.id ORDER BY ub.branch_id ASC LIMIT 1) AS branch_name
    FROM users u
    WHERE u.role IN ${roleScope}
      AND u.status = 'active'
      AND u.is_test_account = 0
      AND u.id != ${Number(user.id)}
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all() as TermEmployee[];

  const records = listTerminations();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Link href="/admin/persona/resignation" className="text-sm text-slate-500 hover:text-brand">
          ← การลาออก (สมัครใจ)
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">เลิกจ้าง (Involuntary termination)</h1>
        <p className="text-sm text-slate-500 mt-1">
          บันทึกการเลิกจ้างพนักงาน · คิดค่าชดเชยตามอายุงานอัตโนมัติ · ล็อกบัญชีเมื่อถึงวันมีผล
        </p>
        <p className="text-[11px] text-slate-400 mt-1 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5 inline-block">
          ค่าชดเชยคำนวณตามอัตราขั้นต่ำ พรบ.คุ้มครองแรงงาน ม.118 เพื่อช่วยประเมินเท่านั้น —
          กรณีจริงควรตรวจสอบกับฝ่ายบุคคล/นักกฎหมายอีกครั้ง
        </p>
      </div>
      <TerminationClient
        employees={employees}
        records={records}
        canSeeSalary={canSeeSalary}
      />
    </div>
  );
}
