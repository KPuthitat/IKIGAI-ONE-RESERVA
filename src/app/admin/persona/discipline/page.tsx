import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { listWarningsForBranch } from "@/lib/discipline";
import { nameWithPrefix } from "@/lib/name";
import DisciplineClient from "./DisciplineClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "หนังสือตักเตือน · PERSONA" };

export default function AdminDisciplinePage() {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  const staffList = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.username, u.employment_type
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ? AND u.role = 'staff'
    ORDER BY u.display_name COLLATE NOCASE
  `).all(branch.id) as Array<{
    id: number; display_name: string; title_prefix: string | null; username: string; employment_type: string | null;
  }>;
  const warnings = listWarningsForBranch(branch.id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.discipline.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.discipline.subtitle")}
        </p>
      </div>
      <DisciplineClient
        staffList={staffList}
        warnings={warnings.map((w) => ({
          id: w.id,
          ref_no: w.ref_no,
          severity: w.severity,
          title: w.title,
          recipient: nameWithPrefix(w.user_title_prefix, w.user_display_name),
          issued_by: nameWithPrefix(w.issued_by_prefix, w.issued_by_name),
          issued_at: w.issued_at,
          acknowledged_at: w.acknowledged_at,
          acknowledged_method: w.acknowledged_method
        }))}
      />
    </div>
  );
}
