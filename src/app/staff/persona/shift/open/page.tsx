// /staff/persona/shift/open — เปิดกะ
//
// Staff submits the morning handover. The branch is taken from the
// session's activeBranchId — set up front via /staff/branch-picker so
// staff explicitly chooses "today's branch" once and every form
// (shift open/close, leave, etc.) inherits it. To switch branches
// mid-day, staff goes back to the picker via the topbar pill.
//
// Server pre-loads, for the active branch:
//   - the active checklist (admin manages it per-branch at
//     /admin/persona/checklist)
//   - yesterday's closing amount, taken from the latest shift_close
//     report at that branch (or null if there's none yet)

import Link from "next/link";
import { redirect } from "next/navigation";
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
  if (user.branches.length === 0) {
    return (
      <div className="card">
        <p className="text-slate-600 mb-3">{t(lang, "admin.notAssignedBranch")}</p>
        <Link href="/staff" className="btn-secondary">{t(lang, "common.back")}</Link>
      </div>
    );
  }
  // Multi-branch staff who haven't picked a "today's branch" yet
  // get bounced to the picker — we don't want to assume on their
  // behalf when LINE notifications go to different groups per branch.
  // (1-branch staff get auto-set on first page load via getSessionUser.)
  if (!user.activeBranchId) {
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/open")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  // Pre-fill yesterday's closing from the latest shift_close at this branch.
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

  // Active checklist for this branch. Admin manages this list at
  // /admin/persona/checklist; the form renders whatever is active here.
  const checklist = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_open' AND branch_id = ? AND active = 1
    ORDER BY display_order ASC, id ASC
  `).all(branch.id) as ShiftChecklistItem[];

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
        branchId={branch.id}
        branchName={branch.name}
        openerName={user.display_name}
        today={todayBkk()}
        yesterdayClosingHint={yesterdayClosingHint}
        checklistItems={checklist.map((c) => ({ id: c.id, label: c.label }))}
      />
    </div>
  );
}
