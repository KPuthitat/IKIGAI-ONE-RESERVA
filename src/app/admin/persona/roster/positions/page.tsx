import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listAllPositions } from "@/lib/roster";
import PositionsClient from "./PositionsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตำแหน่งงาน · PERSONA" };

export default function AdminPositionsPage() {
  const user = requireAdmin();
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  // Include inactive positions so the visibility switch can render
  // them — admin can flip a hidden position back on without re-creating.
  const positions = listAllPositions(branch.id);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin/persona/roster" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "admin.persona.roster.backToRoster")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.roster.positions.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.roster.positions.subtitle")}
        </p>
      </div>
      <PositionsClient positions={positions} />
    </div>
  );
}
