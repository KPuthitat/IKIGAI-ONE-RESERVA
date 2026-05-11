// /admin/persona/shift-reports — admin's view of shift_open reports
// at the active branch + any pending unlock requests on those reports.
//
// Phase 1: read-only list of today's report (if any) + pending unlock
// requests with grant/reject buttons. Granting deletes the original
// daily_reports row (cascades through shift_unlock_requests FK), so
// staff can re-submit cleanly.
//
// Phase 2 (future): historical view of past N days, ad-hoc admin
// "force unlock" without a request, etc.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import ShiftReportsClient, {
  type PendingUnlockRow,
  type TodayReportRow
} from "./ShiftReportsClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "เช็คลิสต์ก่อนเริ่มงาน · PERSONA" };

export default function AdminShiftReportsPage() {
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

  const today = todayBkk();

  // Today's shift_open at this branch (if any). Show it inline so admin
  // sees the status at a glance without clicking through.
  const todayReport = db.prepare(`
    SELECT r.id, r.user_id, r.report_date, r.created_at, u.display_name AS opener_name
    FROM daily_reports r JOIN users u ON r.user_id = u.id
    WHERE r.type = 'shift_open' AND r.branch_id = ? AND r.report_date = ?
  `).get(branch.id, today) as TodayReportRow | undefined;

  // Pending unlock requests across all reports at this branch — not
  // just today, in case a report was filed yesterday and admin only
  // gets to it now. Includes report_type so admin can tell which
  // form the request is for (shift_open / shift_close / readiness_*).
  const pending = db.prepare(`
    SELECT r.id, r.daily_report_id, r.reason, r.created_at,
           dr.type AS report_type,
           dr.report_date, dr.user_id AS opener_id, dr.created_at AS report_created_at,
           u.display_name AS requester_name,
           ou.display_name AS opener_name
    FROM shift_unlock_requests r
    JOIN daily_reports dr ON dr.id = r.daily_report_id
    JOIN users u ON u.id = r.requested_by
    JOIN users ou ON ou.id = dr.user_id
    WHERE r.status = 'pending' AND dr.branch_id = ?
    ORDER BY r.created_at DESC
  `).all(branch.id) as PendingUnlockRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.shiftReports.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.shiftReports.subtitle")}
        </p>
      </div>
      <ShiftReportsClient
        branchName={branch.name}
        today={today}
        todayReport={todayReport ?? null}
        pending={pending}
      />
      <div>
        <Link href="/admin/persona" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
    </div>
  );
}
