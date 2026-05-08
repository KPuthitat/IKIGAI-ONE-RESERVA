import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch, type TableRow } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listZonesForBranch } from "@/lib/zones";
import FloorPlanEditor from "./FloorPlanEditor";

export const dynamic = "force-dynamic";

export default function FloorPlanPage() {
  const user = requireAdmin();
  const lang = getLang();
  if (!user.activeBranchId) return <div className="card">{t(lang, "admin.noBranchAccess")}</div>;
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?").get(user.activeBranchId) as Branch;
  const tables = db.prepare(
    "SELECT * FROM tables WHERE branch_id = ? ORDER BY label"
  ).all(branch.id) as TableRow[];
  // Active zones drive the zone tabs + the per-table dropdown in the sidebar.
  const zones = listZonesForBranch(branch.id);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.floorplan.title")}</h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.floorplan.subtitle", { branch: branch.name })}
        </p>
      </div>
      <FloorPlanEditor branchId={branch.id} initialTables={tables} zones={zones} />
    </div>
  );
}
