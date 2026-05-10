// /admin/persona/checklist — admin manages the items shown on the
// shift handover checklist forms. Global list (not per-branch). Soft
// delete via active=0; historical reports keep their labels because
// they're stored as strings in daily_reports.data.

import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ChecklistEditor from "./ChecklistEditor";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เช็คลิสต์เปิดกะ · PERSONA" };

export default function ChecklistPage() {
  requireAdmin();
  const lang = getLang();

  const db = getDb();
  const items = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_open'
    ORDER BY display_order ASC, id ASC
  `).all() as ShiftChecklistItem[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "admin.persona.checklist.title")}</h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.checklist.subtitle")}
        </p>
      </div>
      <ChecklistEditor initialItems={items} />
    </div>
  );
}
