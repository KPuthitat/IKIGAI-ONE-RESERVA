import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb, type EmployeeProfile } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ProfileForm, { type ProfileSupervisor } from "@/app/staff/persona/profile/ProfileForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "แก้ไขข้อมูลพนักงาน · PERSONA" };

// /admin/persona/employees/[id] — full employee profile (admin view).
// The list modal only carries employment/payroll fields, so the
// personal data staff fill in their own profile (name, DOB, address,
// emergency contact, …) was never visible to admins. This page reuses
// the shared ProfileForm in mode="admin" — every field, editable,
// posting to /api/admin/persona/employees/[id] which already accepts
// the full Phase-A field set.
export default function AdminEmployeeProfilePage({
  params
}: { params: { id: string } }) {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  const row = db.prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as EmployeeProfile | undefined;
  if (!row || row.status === "disabled") {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "common.error")} —{" "}
        <Link href="/admin/persona/employees" className="text-brand underline">
          {t(lang, "common.back")}
        </Link>
      </div>
    );
  }

  // Access guard. super_admin → any employee. A branch admin may only
  // open an employee who shares one of the branches they administer
  // (defence-in-depth: the list is branch-scoped, but a hand-typed URL
  // must not leak a profile from a branch they don't manage).
  if (user.role !== "super_admin") {
    const ids = user.adminBranchIds;
    const allowed = ids.length > 0 && db.prepare(
      `SELECT 1 FROM user_branches
        WHERE user_id = ? AND branch_id IN (${ids.map(() => "?").join(",")})
        LIMIT 1`
    ).get(id, ...ids);
    if (!allowed) {
      return (
        <div className="card text-sm text-rose-600">
          {t(lang, "admin.persona.employees.notPermitted")} —{" "}
          <Link href="/admin/persona/employees" className="text-brand underline">
            {t(lang, "common.back")}
          </Link>
        </div>
      );
    }
  }

  // Supervisor dropdown — any non-disabled account (ProfileForm filters
  // out the employee themselves). Kept un-branch-scoped on purpose so a
  // cross-branch supervisor can still be selected by the owner.
  const supervisors = db.prepare(
    `SELECT id, display_name, title_prefix FROM users
      WHERE status NOT IN ('disabled', 'resigned', 'terminated') AND is_test_account = 0
      ORDER BY display_name`
  ).all() as ProfileSupervisor[];

  // "ยังไม่ได้กรอก" check — the full profile fields (first_name_th
  // etc.) sit on users alongside the on-boarding display_name. A
  // brand-new employee that hasn't logged in to fill their profile
  // shows blanks across the board, which previously looked like a
  // display bug. Surface a clear notice so admin knows it's a
  // data-not-filled situation, not a UI failure.
  const notFilled = !row.first_name_th && !row.last_name_th
    && !row.dob && !row.mobile_phone;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona/employees"
          className="text-sm text-brand hover:underline">
          {t(lang, "common.back")}
        </Link>
        <h1 className="text-2xl font-bold text-slate-800 mt-1">
          {t(lang, "admin.persona.employees.editTitle")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.employees.fullProfileHint")}
        </p>
      </div>

      {notFilled && (
        <div className="card border-l-4 border-amber-400 bg-amber-50/50">
          <div className="font-bold text-amber-900">
            พนักงานคนนี้ยังไม่ได้กรอกข้อมูลส่วนตัว
          </div>
          <p className="text-sm text-amber-800/90 mt-1 leading-relaxed">
            ชื่อในระบบตอนสร้างบัญชี: <span className="font-bold">{row.display_name}</span>
            {row.username && <> · <span className="font-mono text-xs">@{row.username}</span></>}
          </p>
          <p className="text-xs text-amber-800/70 mt-2">
            ฟอร์มทั้งหมดจึงว่างเปล่า ไม่ใช่ระบบแสดงผลผิดพลาด — แอดมิน
            สามารถกรอกแทนพนักงานได้ที่นี่ หรือให้พนักงาน login เข้า
            /staff/persona/profile แล้วกรอกเองได้
          </p>
        </div>
      )}

      <ProfileForm mode="admin" profile={row} supervisors={supervisors} />
    </div>
  );
}
