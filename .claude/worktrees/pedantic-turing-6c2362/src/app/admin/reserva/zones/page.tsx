import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listZonesForBranch } from "@/lib/zones";
import ZonesClient from "./ZonesClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "โซนของร้าน · RESERVA" };

export default function ZonesPage() {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return (
      <div className="card text-sm text-amber-700">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }

  const zones = listZonesForBranch(branch.id, { includeInactive: true });

  // Count tables per zone (so admin can see usage at a glance)
  const tableCounts = db.prepare(`
    SELECT zone_id, COUNT(*) AS n FROM tables WHERE branch_id = ?
    GROUP BY zone_id
  `).all(branch.id) as Array<{ zone_id: number | null; n: number }>;
  const countByZone = new Map<number | null, number>(
    tableCounts.map((r) => [r.zone_id, r.n])
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.reserva.zones.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.reserva.zones.subtitle", { branch: branch.name })}
        </p>
      </div>
      <ZonesClient
        lang={lang}
        zones={zones.map((z) => ({
          ...z,
          table_count: countByZone.get(z.id) ?? 0
        }))}
        unassignedCount={countByZone.get(null) ?? 0}
      />
    </div>
  );
}
