// /staff/persona/shift/open — เปิดกะ
//
// Staff submits the morning handover. Server pre-fills yesterday's
// closing amount from the latest shift_close report and loads the
// active checklist items so admin's edits show up immediately.

import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ShiftOpenForm from "./ShiftOpenForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เปิดกะ · PERSONA" };

export default function ShiftOpenPage() {
  const user = requireUser();
  const lang = getLang();
  if (!user.activeBranchId) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">{t(lang, "admin.notAssignedBranch")}</p>
        <Link href="/staff" className="btn-secondary">{t(lang, "common.back")}</Link>
      </div>
    );
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  // Pre-fill yesterday's closing from the most recent shift_close row
  // (if any). Falls through gracefully when there's no prior close.
  const lastClose = db.prepare(`
    SELECT data FROM daily_reports
    WHERE type = 'shift_close' AND branch_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(branch.id) as { data: string } | undefined;
  let yesterdayClosingHint: number | null = null;
  if (lastClose) {
    try {
      const parsed = JSON.parse(lastClose.data) as { closing_drawer_amount?: number };
      if (typeof parsed.closing_drawer_amount === "number") {
        yesterdayClosingHint = parsed.closing_drawer_amount;
      }
    } catch { /* ignore malformed legacy data */ }
  }

  // Load active checklist items. Admin manages this list at
  // /admin/persona/checklist; the form renders whatever is active here.
  const checklistItems = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_open' AND active = 1
    ORDER BY display_order ASC, id ASC
  `).all() as ShiftChecklistItem[];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold">{t(lang, "staff.persona.shift.open.title")}</h1>
        <p className="text-sm text-slate-500">
          {branch.name} · {t(lang, "staff.persona.shift.open.subtitle")}
        </p>
      </div>
      <ShiftOpenForm
        branchName={branch.name}
        openerName={user.display_name}
        today={todayBkk()}
        yesterdayClosingHint={yesterdayClosingHint}
        checklistItems={checklistItems.map((c) => ({ id: c.id, label: c.label }))}
      />
    </div>
  );
}
