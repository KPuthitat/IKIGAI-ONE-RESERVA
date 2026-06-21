// /staff/persona/shift/close — เช็คลิสต์หลังเลิกงาน
//
// One submission per (branch, date). Same lock + edit-request flow
// as the other 3 daily-report types. The form takes a closing-drawer
// amount + the per-branch checklist; the next day's pre-shift form
// reads this row's `data.closing_drawer_amount` to pre-fill its
// "ยอดเงินปิดกะเมื่อวาน" hint.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getDb, type Branch, type ShiftChecklistItem } from "@/lib/db";
import { listShiftCloseChannels, materialPurchaseQuota } from "@/lib/accounta-db";
import { parseChecklistOptions } from "@/lib/checklist-options";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import ShiftCloseForm from "./ShiftCloseForm";
import ShiftReportLocked from "../ShiftReportLocked";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Check list หลังเลิกงาน · PERSONA" };

export default function ShiftClosePage() {
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
    redirect(`/staff/branch-picker?next=${encodeURIComponent("/staff/persona/shift/close")}`);
  }

  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card">{t(lang, "common.error")}</div>;
  }

  const today = todayBkk();
  const typeLabel = t(lang, "staff.persona.shiftReport.typeLabel.shiftClose");

  const existing = db.prepare(`
    SELECT r.id, r.user_id, r.created_at, u.display_name AS opener_name, u.title_prefix AS opener_prefix
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = 'shift_close' AND r.branch_id = ? AND r.report_date = ?
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
          <p className="text-sm text-slate-500">{branch.name}</p>
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

  const checklist = db.prepare(`
    SELECT * FROM shift_checklist_items
    WHERE type = 'shift_close' AND branch_id = ? AND active = 1
    ORDER BY display_order ASC, id ASC
  `).all(branch.id) as ShiftChecklistItem[];

  // Prefill source — when admin previously granted an unlock for
  // today's shift_close at this branch, the superseded row carries
  // the values the staff already typed. Reading the latest one and
  // passing it as initialValues spares staff from re-typing the
  // whole form when they only need to fix one or two fields.
  // Falls back to empty when there's no prior submission.
  type PrevRow = { data: string };
  const previousRow = db.prepare(`
    SELECT data FROM daily_reports
    WHERE type = 'shift_close' AND branch_id = ? AND report_date = ?
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
        <h1 className="text-2xl font-bold">{typeLabel}</h1>
        <p className="text-sm text-slate-500">{branch.name}</p>
      </div>
      <ShiftCloseForm
        branchId={branch.id}
        branchName={branch.name}
        closerName={nameWithPrefix(user.title_prefix, user.display_name)}
        requireServiceCharge={branch.require_service_charge === 1}
        requireTodayClosing={branch.require_today_closing === 1}
        requireDailyRevenue={branch.require_daily_revenue === 1}
        // Master income channels — staff fill a mandatory per-channel
        // breakdown that must reconcile to ยอดขายวันนี้ before they can
        // submit (owner 2026-06-21). Only relevant when the branch records
        // daily revenue; the form gates the panel on requireDailyRevenue.
        incomeChannels={branch.require_daily_revenue === 1 ? listShiftCloseChannels(branch.id) : []}
        // Material-purchase quota for today (owner 2026-06-21). null when the
        // branch hasn't enabled it. The form shows today's quota + records how
        // much was ordered, flagging over-quota on the report.
        materialQuota={materialPurchaseQuota(branch.id, today)}
        previousData={previousData}
        // Per-branch headline label + order + in-red-box knobs.
        // The form forwards these into the live FlexPreview so the
        // staff sees what the LINE Flex card will actually look like
        // (custom labels + chosen order) before they hit submit.
        defaultFieldConfig={{
          // Fixed layout (owner 2026-06-09): only ยอดขายวันนี้ in the red
          // box; ปิดกะ + เซอร์วิสชาร์จ as bold rows. Mirrors the LINE card.
          closing_drawer: {
            label: branch.sc_drawer_label || "ยอดเงินปิดกะวันนี้",
            display_order: branch.sc_drawer_order,
            in_red_box: false
          },
          service_charge: {
            label: branch.sc_svc_label || "เซอร์วิสชาร์จวันนี้",
            display_order: branch.sc_svc_order,
            in_red_box: false
          },
          daily_revenue: {
            label: branch.sc_revenue_label || "ยอดขายวันนี้",
            display_order: branch.sc_revenue_order,
            in_red_box: true
          }
        }}
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
