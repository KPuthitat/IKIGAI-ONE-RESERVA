import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ExportClient from "./ExportClient";

export const dynamic = "force-dynamic";

export default function ExportPage() {
  requireAdmin();
  const lang = getLang();
  const branches = getDb().prepare("SELECT * FROM branches ORDER BY name").all() as Branch[];
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.export.title")}</h1>
        <p className="text-sm text-slate-500">{t(lang, "admin.export.subtitle")}</p>
      </div>
      <ExportClient branches={branches} />
    </div>
  );
}
