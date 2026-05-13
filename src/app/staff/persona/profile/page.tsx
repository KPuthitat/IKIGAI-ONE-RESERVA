import type { Metadata } from "next";
import { requireStaffOrAdmin } from "@/lib/auth";
import { getDb, type EmployeeProfile } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ProfileForm from "./ProfileForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "โปรไฟล์ของฉัน · PERSONA" };

export default function StaffProfilePage() {
  const user = requireStaffOrAdmin();
  const lang = getLang();
  const db = getDb();

  const row = db.prepare("SELECT * FROM users WHERE id = ?")
    .get(user.id) as EmployeeProfile | undefined;
  if (!row) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.persona.profile.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.persona.profile.subtitle")}
        </p>
      </div>
      <ProfileForm mode="self" profile={row} supervisors={[]} />
    </div>
  );
}
