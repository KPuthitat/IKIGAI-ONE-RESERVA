// /admin/persona/checklist — admin manages the items shown on the
// pre-shift / post-shift / readiness checklist forms. Per-branch since
// 2026-05; the active branch is picked via the topbar pill in the
// global admin layout. Soft delete via active=0; historical reports
// keep their labels because they're stored as strings in
// daily_reports.data.
//
// `?type=` query param selects which checklist to edit:
//   - shift_open      (default — เช็คลิสต์ก่อนเริ่มงาน)
//   - shift_close     (เช็คลิสต์หลังเลิกงาน)
//   - readiness_1130  (รายงานความพร้อมรอบ 11:30 น.)
//   - readiness_1600  (รายงานความพร้อมรอบ 16:00 น.)

import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t, type Lang } from "@/lib/i18n";
import ChecklistEditor from "./ChecklistEditor";
import ShiftCloseDefaultsToggle from "./ShiftCloseDefaultsToggle";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Check list ก่อนเริ่มงาน · PERSONA" };

const TYPES = ["shift_open", "shift_close", "readiness_1130", "readiness_1600"] as const;
type ChecklistType = (typeof TYPES)[number];

function titleFor(type: ChecklistType, lang: Lang): string {
  switch (type) {
    case "shift_open":     return t(lang, "admin.persona.checklist.title.shiftOpen");
    case "shift_close":    return t(lang, "admin.persona.checklist.title.shiftClose");
    case "readiness_1130": return t(lang, "admin.persona.checklist.title.readiness1130");
    case "readiness_1600": return t(lang, "admin.persona.checklist.title.readiness1600");
  }
}

export default function ChecklistPage({
  searchParams
}: { searchParams: { type?: string } }) {
  const user = requireAdmin();
  const lang = getLang();

  const type: ChecklistType = TYPES.includes(searchParams.type as ChecklistType)
    ? (searchParams.type as ChecklistType)
    : "shift_open";

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
    WHERE type = ? AND branch_id = ?
    ORDER BY display_order ASC, id ASC
  `).all(type, branch.id) as ShiftChecklistItem[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">
          {titleFor(type, lang)}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.checklist.subtitle")}
        </p>
      </div>
      {/* Shift-close-only: 3 toggles that decide which of the default
          money fields render in the red headline box on the LINE
          card. Rendered above the per-item editor so the prominence
          decision lives next to the items, not buried in a separate
          settings page. */}
      {type === "shift_close" && (
        <ShiftCloseDefaultsToggle
          key={`scd-${branch.id}`}
          initial={{
            closing_drawer: branch.sc_show_drawer_primary === 1,
            service_charge: branch.sc_show_svc_primary === 1,
            daily_revenue:  branch.sc_show_revenue_primary === 1
          }}
        />
      )}

      {/* key forces React to unmount + remount when the user navigates
          between report types (or branches). Without it, the client
          component's useState seeds from the first initialItems and
          ignores subsequent prop changes — so switching shift_open →
          readiness_1130 would show the old list with the new header. */}
      <ChecklistEditor
        key={`${branch.id}-${type}`}
        initialItems={items}
        branchId={branch.id}
        type={type}
      />
    </div>
  );
}
