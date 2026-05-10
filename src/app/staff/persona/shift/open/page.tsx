// /staff/persona/shift/open — เปิดกะ
//
// Staff submits the morning handover. Server pre-loads, for EACH branch
// the staff is assigned to:
//   - the active checklist (admin manages it per-branch at
//     /admin/persona/checklist)
//   - yesterday's closing amount, taken from the latest shift_close
//     report at that branch (or null if there's none yet)
// The form lets staff pick which branch they're opening at — the same
// person can do morning at branch A and afternoon at branch B, so we
// don't lock them to session activeBranchId.

import Link from "next/link";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type ShiftChecklistItem } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ShiftOpenForm, { type BranchOption } from "./ShiftOpenForm";

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

  const db = getDb();

  // Build per-branch options: each carries its own checklist + yesterday
  // closing hint, pre-fetched server-side so the form can switch branches
  // without an extra round-trip.
  const branchOptions: BranchOption[] = user.branches.map((b) => {
    const lastClose = db.prepare(`
      SELECT data FROM daily_reports
      WHERE type = 'shift_close' AND branch_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(b.id) as { data: string } | undefined;
    let yesterdayClosingHint: number | null = null;
    if (lastClose) {
      try {
        const parsed = JSON.parse(lastClose.data) as { closing_drawer_amount?: number };
        if (typeof parsed.closing_drawer_amount === "number") {
          yesterdayClosingHint = parsed.closing_drawer_amount;
        }
      } catch { /* ignore malformed legacy data */ }
    }

    const checklist = db.prepare(`
      SELECT * FROM shift_checklist_items
      WHERE type = 'shift_open' AND branch_id = ? AND active = 1
      ORDER BY display_order ASC, id ASC
    `).all(b.id) as ShiftChecklistItem[];

    return {
      id: b.id,
      name: b.name,
      yesterdayClosingHint,
      checklistItems: checklist.map((c) => ({ id: c.id, label: c.label }))
    };
  });

  // Initial selection — prefer session activeBranchId so the typical
  // "I'm opening my home branch" case is one tap. Falls back to first.
  const defaultBranchId =
    (user.activeBranchId && branchOptions.some((o) => o.id === user.activeBranchId))
      ? user.activeBranchId
      : branchOptions[0].id;

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
          {t(lang, "staff.persona.shift.open.subtitle")}
        </p>
      </div>
      <ShiftOpenForm
        openerName={user.display_name}
        today={todayBkk()}
        branchOptions={branchOptions}
        defaultBranchId={defaultBranchId}
      />
    </div>
  );
}
