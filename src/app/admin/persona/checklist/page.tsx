// /admin/persona/checklist — admin manages the items shown on the
// shift handover checklist forms. Per-branch since 2026-05; the active
// branch is picked via the topbar pill in the global admin layout.
// Soft delete via active=0; historical reports keep their labels because
// they're stored as strings in daily_reports.data.

import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ChecklistEditor from "./ChecklistEditor";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เช็คลิสต์ก่อนเริ่มงาน · PERSONA" };

export default function ChecklistPage() {
  const user = requireAdmin();
  const lang = getLang();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  const items = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_open' AND branch_id = ?
    ORDER BY display_order ASC, id ASC
  `).all(branch.id) as ShiftChecklistItem[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">
          {t(lang, "admin.persona.checklist.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.checklist.subtitle")}
        </p>
      </div>
      <ChecklistEditor initialItems={items} branchId={branch.id} />
    </div>
  );
}
