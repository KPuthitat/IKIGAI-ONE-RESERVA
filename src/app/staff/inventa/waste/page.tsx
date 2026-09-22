import { requireUser, isAdminCapable } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getDb } from "@/lib/db";
import { listWaste } from "@/lib/inventa-waste-server";
import WasteClient, { type WasteItem } from "./WasteClient";

export const dynamic = "force-dynamic";

// INVENTA waste log (owner 2026-09-22): any staff records stock lost to spoilage/
// expiry/breakage etc. Log-only — never touches stock counts.
export default function InventaWastePage() {
  const user = requireUser();
  const lang = getLang();
  const branchId = user.activeBranchId ?? null;

  const items = getDb().prepare(
    "SELECT id, name, unit, unit_cost FROM inventa_items WHERE (branch_id IS ? OR branch_id = ?) AND active = 1 ORDER BY name COLLATE NOCASE"
  ).all(branchId, branchId) as WasteItem[];
  const recent = listWaste(branchId, 100);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">{t(lang, "inv.waste.title")}</h1>
        <p className="text-sm text-slate-500 mt-1">{t(lang, "inv.waste.subtitle")}</p>
      </div>
      <WasteClient items={items} rows={recent} showReportLink={isAdminCapable(user)} />
    </div>
  );
}
