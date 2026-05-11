// /staff/persona/shift/readiness-1600 — รายงานความพร้อมรอบ 16:00 น.
//
// Same shape as readiness-1130; only the type and i18n labels differ.
// See readiness-1130/page.tsx for the architecture commentary.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ChecklistRunner from "../ChecklistRunner";
import ShiftReportLocked from "../ShiftReportLocked";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รายงานความพร้อมรอบ 16:00 น. · PERSONA" };

export default function Readiness1600Page() {
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
  if (!user.activeBranchId) {
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/readiness-1600")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  const today = todayBkk();
  const typeLabel = t(lang, "staff.persona.shiftReport.typeLabel.readiness1600");

  const existing = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = 'readiness_1600' AND r.branch_id = ? AND r.report_date = ?
      AND r.superseded_at IS NULL
  `).get(branch.id, today) as
    | { id: number; user_id: number; created_at: string; opener_name: string }
    | undefined;
  if (existing) {
    const lastReq = db.prepare(`
      SELECT id, status, decision_note FROM shift_unlock_requests
      WHERE daily_report_id = ? AND requested_by = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(existing.id, user.id) as
      | { id: number; status: string; decision_note: string | null }
      | undefined;
    return (
      <div className="space-y-4">
        <div>
          <Link href="/staff/persona" className="text-sm text-slate-500 hover:text-brand">
            ← {t(lang, "common.back")}
          </Link>
        </div>
        <div>
          <h1 className="text-2xl font-bold">{typeLabel}</h1>
          <p className="text-sm text-slate-500">{branch.name}</p>
        </div>
        <ShiftReportLocked
          branchName={branch.name}
          typeLabel={typeLabel}
          reportId={existing.id}
          openerName={existing.opener_name}
          openedAtIso={existing.created_at}
          alreadyRequested={lastReq?.status === "pending"}
          lastRejected={lastReq?.status === "rejected"
            ? { decisionNote: lastReq.decision_note }
            : null}
        />
      </div>
    );
  }

  const checklist = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'readiness_1600' AND branch_id = ? AND active = 1
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
        <h1 className="text-2xl font-bold">{typeLabel}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>
      <ChecklistRunner
        type="readiness_1600"
        branchId={branch.id}
        branchName={branch.name}
        checklistItems={checklist.map((c) => ({ id: c.id, label: c.label }))}
        submitLabel={t(lang, "staff.persona.readiness.submit")}
        successCopy={{
          title: t(lang, "staff.persona.shiftReport.submitted.title"),
          body: t(lang, "staff.persona.shiftReport.submitted.body", {
            type: typeLabel,
            branch: branch.name
          })
        }}
      />
    </div>
  );
}
