// /staff/persona/shift/readiness-1130 — รายงานความพร้อมรอบเช้า
// (route slug keeps the original "1130" tag for db.type compatibility;
// the user-facing label comes from i18n + branch.readiness_morning_time)
//
// One submission per (branch, date). Same locked-view + edit-request
// flow as shift_open / shift_close. As of 2026-05 the body is a
// structured free-text form (3 textareas + alcohol radio) — admin's
// per-branch readiness checklist is no longer used here. The admin
// checklist editor route still exists at /admin/persona/checklist?
// type=readiness_1130 but configures nothing the staff form reads.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem, parseChecklistOptions } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import ReadinessForm from "../ReadinessForm";
import ShiftReportLocked from "../ShiftReportLocked";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รายงานความพร้อมรอบเช้า · PERSONA" };

export default function Readiness1130Page() {
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
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/readiness-1130")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  const today = todayBkk();
  const typeLabel = t(lang, "staff.persona.shiftReport.typeLabel.readiness1130");

  // One submission per branch per day. If existing, render lock.
  const existing = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name, u.title_prefix AS opener_prefix
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = 'readiness_1130' AND r.branch_id = ? AND r.report_date = ?
      AND r.superseded_at IS NULL
  `).get(branch.id, today) as
    | { id: number; user_id: number; created_at: string; opener_name: string; opener_prefix: string | null }
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
          <p className="text-sm text-slate-500">
            {branch.name} · {t(lang, "staff.persona.readiness.timeNote", {
              time: branch.readiness_morning_time
            })}
          </p>
        </div>
        <ShiftReportLocked
          branchName={branch.name}
          typeLabel={typeLabel}
          reportId={existing.id}
          openerName={nameWithPrefix(existing.opener_prefix, existing.opener_name)}
          openedAtIso={existing.created_at}
          alreadyRequested={lastReq?.status === "pending"}
          lastRejected={lastReq?.status === "rejected"
            ? { decisionNote: lastReq.decision_note }
            : null}
        />
      </div>
    );
  }

  // Admin-configured checklist — drives the WHOLE form (no static
  // fields anymore). The migration seeds defaults per branch so
  // existing branches see the same 4 items they always had.
  const checklist = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'readiness_1130' AND branch_id = ? AND active = 1
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
      <ReadinessForm
        type="readiness_1130"
        branchId={branch.id}
        branchName={branch.name}
        reporterName={nameWithPrefix(user.title_prefix, user.display_name)}
        todayDate={today}
        submitLabel={t(lang, "staff.persona.readiness.submit")}
        successCopy={{
          title: t(lang, "staff.persona.shiftReport.submitted.title"),
          body: t(lang, "staff.persona.shiftReport.submitted.body", {
            type: typeLabel,
            branch: branch.name
          })
        }}
        checklistItems={checklist.map((c) => ({
          id: c.id,
          label: c.label,
          kind: (c.kind ?? "checkbox") as "checkbox" | "text" | "choice",
          options: c.kind === "choice" ? parseChecklistOptions(c) : undefined
        }))}
      />
    </div>
  );
}
