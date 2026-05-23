// /staff/persona/shift/open — เปิดกะ
//
// Staff submits the morning handover. The branch is taken from the
// session's activeBranchId — set up front via /staff/branch-picker so
// staff explicitly chooses "today's branch" once and every form
// (shift open/close, leave, etc.) inherits it. To switch branches
// mid-day, staff goes back to the picker via the topbar pill.
//
// Server pre-loads, for the active branch:
//   - whether today's shift is already open (one-shift-per-branch-per-day).
//     If so, render a locked view instead of the form, with a button to
//     send an unlock request to admin.
//   - the active checklist (admin manages it per-branch at
//     /admin/persona/checklist)
//   - yesterday's closing amount, taken from the latest shift_close
//     report at that branch (or null if there's none yet)

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { parseChecklistOptions } from "@/lib/checklist-options";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import ShiftOpenForm from "./ShiftOpenForm";
import ShiftReportLocked from "../ShiftReportLocked";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Check list ก่อนเริ่มงาน · PERSONA" };

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
  if (!user.activeBranchId) {
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/open")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  const today = todayBkk();

  // One-shift-open-per-branch-per-day. If a row already exists, render
  // the locked view: shows who opened it + when, plus a button to send
  // an unlock request to admin. The same lock applies to ALL staff at
  // that branch (so person B can't accidentally re-submit on top of
  // person A's report).
  const existingOpen = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name, u.title_prefix AS opener_prefix
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = 'shift_open' AND r.branch_id = ? AND r.report_date = ?
      AND r.superseded_at IS NULL
  `).get(branch.id, today) as
    | { id: number; user_id: number; created_at: string; opener_name: string; opener_prefix: string | null }
    | undefined;
  if (existingOpen) {
    // Has the current user already requested an unlock? Pull the
    // latest request the user filed against this report — could be
    // pending (block dup), rejected (show admin's note + allow retry),
    // or granted (shouldn't happen here since the daily_report row
    // would be deleted).
    const lastReq = db.prepare(`
      SELECT id, status, decision_note FROM shift_unlock_requests
      WHERE daily_report_id = ? AND requested_by = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(existingOpen.id, user.id) as
      | { id: number; status: string; decision_note: string | null }
      | undefined;
    const pendingReq = lastReq?.status === "pending";
    const lastRejected = lastReq?.status === "rejected"
      ? { decisionNote: lastReq.decision_note }
      : null;
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
        <ShiftReportLocked
          branchName={branch.name}
          typeLabel={t(lang, "staff.persona.shiftReport.typeLabel.shiftOpen")}
          reportId={existingOpen.id}
          openerName={nameWithPrefix(existingOpen.opener_prefix, existingOpen.opener_name)}
          openedAtIso={existingOpen.created_at}
          alreadyRequested={pendingReq}
          lastRejected={lastRejected}
        />
      </div>
    );
  }

  // Pre-fill yesterday's closing from the latest LIVE (non-superseded)
  // shift_close at this branch. Superseded rows are kept for audit
  // when admin grants an unlock, but they're stale — the live row is
  // the source of truth. Staff can still hand-edit the prefilled
  // value once it lands in the form.
  const lastClose = db.prepare(`
    SELECT data FROM daily_reports
    WHERE type = 'shift_close' AND branch_id = ? AND superseded_at IS NULL
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

  // Prefill source — latest superseded report for today's shift_open
  // at this branch. Passed to the form so a re-do after admin
  // approves an unlock starts pre-filled with what was typed
  // before. Same pattern as shift_close. See close/page.tsx.
  type PrevRow = { data: string };
  const previousRow = db.prepare(`
    SELECT data FROM daily_reports
    WHERE type = 'shift_open' AND branch_id = ? AND report_date = ?
      AND superseded_at IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(branch.id, today) as PrevRow | undefined;
  let previousData: Record<string, unknown> | null = null;
  if (previousRow) {
    try { previousData = JSON.parse(previousRow.data); } catch { previousData = null; }
  }

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
        openerName={nameWithPrefix(user.title_prefix, user.display_name)}
        today={today}
        yesterdayClosingHint={yesterdayClosingHint}
        previousData={previousData}
        checklistItems={checklist
          .map((c) => ({
            id: c.id,
            label: c.label,
            kind: (c.kind ?? "checkbox") as "checkbox" | "text" | "choice" | "amount" | "section",
            options: c.kind === "choice" ? parseChecklistOptions(c) : undefined,
            parent_id: c.parent_id ?? null,
            is_headline: !!c.is_headline_amount,
            description: c.description ?? null
          }))
          .filter((c) => c.kind !== "choice" || (c.options?.length ?? 0) >= 2)}
      />
    </div>
  );
}
