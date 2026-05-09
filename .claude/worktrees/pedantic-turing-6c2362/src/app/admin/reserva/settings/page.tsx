import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import SettingsClient from "./SettingsClient";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const user = requireAdmin();
  const lang = getLang();
  if (!user.activeBranchId) return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  const branch = getDb().prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.settings.title")}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>
      <SettingsClient branch={branch} />
    </div>
  );
}
