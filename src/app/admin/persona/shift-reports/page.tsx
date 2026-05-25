// /admin/persona/shift-reports — admin's view of the active branch's
// daily reports (all 4 types: shift_open, readiness_1130,
// readiness_1600, shift_close) for today, plus any pending unlock
// requests on those reports.
//
// Today's status: one row per type — ✓ if a LIVE report exists (not
// superseded), ○ otherwise. A small "แก้ไข N×" chip surfaces when the
// chain has revisions (admin previously granted edit request(s)),
// so it's obvious at a glance which reports got redone. Clicking the
// chip expands the full revision chain inline (ฉบับแรก → ... →
// ฉบับปัจจุบัน) annotated with each granted edit request — who
// asked, what reason, which admin approved when, optional note.
//
// Pending unlock requests: list of staff edit requests still awaiting
// a decision. Grant marks the underlying daily_reports row
// `superseded_at` (the original survives for audit + chain rebuild);
// reject leaves it untouched. Both decisions push a LINE Flex to the
// branch group via /api/.../decide.
//
// Phase 3 (future): historical view of past N days, ad-hoc admin
// "force unlock" without a request, export chain to CSV for audit.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { todayBkk } from "@/lib/time";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";
import { buildDailyAttendanceRoster } from "@/lib/daily-attendance-summary";
import ShiftReportsClient, {
  type PendingUnlockRow,
  type TodayReportRow,
  type ReportType,
  type ChainLink,
  type ChainsByType
} from "./ShiftReportsClient";
import SendAttendanceSummaryButton from "./SendAttendanceSummaryButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "รายงานประจำวัน · PERSONA" };

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

  // Today's LIVE reports at this branch — one per type at most (the
  // partial unique index on daily_reports filters superseded rows out).
  // The correlated subquery counts the full chain length (live +
  // superseded predecessors); revision_count = chain length - 1, so
  // 0 = fresh first submission, ≥1 = at least one redo via an
  // admin-granted edit request.
  const todayRows = db.prepare(`
    SELECT r.id, r.type, r.user_id, r.report_date, r.created_at,
           u.display_name AS opener_name,
           u.title_prefix AS opener_prefix,
           (
             SELECT COUNT(*) - 1 FROM daily_reports d2
             WHERE d2.branch_id = r.branch_id
               AND d2.type = r.type
               AND d2.report_date = r.report_date
           ) AS revision_count
    FROM daily_reports r
    JOIN users u ON r.user_id = u.id
    WHERE r.branch_id = ? AND r.report_date = ? AND r.superseded_at IS NULL
  `).all(branch.id, today) as TodayReportRow[];

  // Index by type so the client renders all 4 rows in a fixed order
  // even if some types haven't been submitted yet today (null = ○).
  const todayReports: Record<ReportType, TodayReportRow | null> = {
    shift_open: null,
    readiness_1130: null,
    readiness_1600: null,
    shift_close: null
  };
  for (const row of todayRows) {
    if (row.type in todayReports) {
      todayReports[row.type as ReportType] = row;
    }
  }

  // Build revision chains per type — every daily_reports row for
  // today's (branch, date), ordered oldest → newest. The client
  // expands a chain when the admin clicks the "แก้ไข N×" chip.
  //
  // We always run this query (cheap — at most ~10 rows per branch/day)
  // and group by type in JS; types with chain length ≤ 1 have no
  // visible history but the empty array keeps Record<ReportType, _>
  // exhaustive on the client.
  type ChainRow = {
    id: number;
    type: ReportType;
    created_at: string;
    superseded_at: string | null;
    user_name: string;
    user_prefix: string | null;
  };
  const chainRows = db.prepare(`
    SELECT dr.id, dr.type, dr.created_at, dr.superseded_at,
           u.display_name AS user_name,
           u.title_prefix AS user_prefix
    FROM daily_reports dr
    JOIN users u ON u.id = dr.user_id
    WHERE dr.branch_id = ? AND dr.report_date = ?
    ORDER BY dr.type ASC, dr.id ASC
  `).all(branch.id, today) as ChainRow[];

  // Attach the granted unlock request to each row that GOT superseded.
  // (The live tail row's granted_unlock is always null — nothing has
  // superseded it yet, though a pending request may exist; pending
  // ones surface in the "คำขอที่รอตรวจสอบ" section below, not here.)
  type GrantedUnlock = {
    id: number;
    daily_report_id: number;
    reason: string;
    decided_at: string | null;
    decision_note: string | null;
    requester_name: string;
    requester_prefix: string | null;
    decided_by_name: string | null;
    decided_by_prefix: string | null;
  };
  const unlockByReportId = new Map<number, GrantedUnlock>();
  const supersededIds = chainRows
    .filter((r) => r.superseded_at !== null)
    .map((r) => r.id);
  if (supersededIds.length > 0) {
    const placeholders = supersededIds.map(() => "?").join(",");
    const unlocks = db.prepare(`
      SELECT r.id, r.daily_report_id, r.reason, r.decided_at, r.decision_note,
             u.display_name AS requester_name,
             u.title_prefix AS requester_prefix,
             du.display_name AS decided_by_name,
             du.title_prefix AS decided_by_prefix
      FROM shift_unlock_requests r
      JOIN users u ON u.id = r.requested_by
      LEFT JOIN users du ON du.id = r.decided_by
      WHERE r.status = 'granted' AND r.daily_report_id IN (${placeholders})
    `).all(...supersededIds) as GrantedUnlock[];
    for (const u of unlocks) {
      unlockByReportId.set(u.daily_report_id, u);
    }
  }

  const chains: ChainsByType = {
    shift_open: [],
    readiness_1130: [],
    readiness_1600: [],
    shift_close: []
  };
  for (const row of chainRows) {
    if (!(row.type in chains)) continue;
    const granted = unlockByReportId.get(row.id);
    const link: ChainLink = {
      id: row.id,
      user_name: row.user_name,
      user_prefix: row.user_prefix,
      created_at: row.created_at,
      is_live: row.superseded_at === null,
      granted_unlock: granted
        ? {
            id: granted.id,
            requester_name: granted.requester_name,
            requester_prefix: granted.requester_prefix,
            reason: granted.reason,
            decided_by_name: granted.decided_by_name,
            decided_by_prefix: granted.decided_by_prefix,
            decided_at: granted.decided_at,
            decision_note: granted.decision_note
          }
        : null
    };
    chains[row.type].push(link);
  }

  // Pending unlock requests across all reports at this branch — not
  // just today, in case a report was filed yesterday and admin only
  // gets to it now. Includes report_type so admin can tell which
  // form the request is for (shift_open / shift_close / readiness_*).
  const pending = db.prepare(`
    SELECT r.id, r.daily_report_id, r.reason, r.created_at,
           dr.type AS report_type,
           dr.report_date, dr.user_id AS opener_id, dr.created_at AS report_created_at,
           u.display_name AS requester_name,
           u.title_prefix AS requester_prefix,
           ou.display_name AS opener_name,
           ou.title_prefix AS opener_prefix
    FROM shift_unlock_requests r
    JOIN daily_reports dr ON dr.id = r.daily_report_id
    JOIN users u ON u.id = r.requested_by
    JOIN users ou ON ou.id = dr.user_id
    WHERE r.status = 'pending' AND dr.branch_id = ?
    ORDER BY r.created_at DESC
  `).all(branch.id) as PendingUnlockRow[];

  // Today's attendance roster — same data that's sent to the
  // executive group every morning, surfaced ON-PAGE so admin can
  // glance at it without scrolling through LINE. Categorised
  // (on_time / late / on_leave / absent).
  const attendanceRows = buildDailyAttendanceRoster(branch.id, today);
  const onTime = attendanceRows.filter((r) => r.category === "on_time");
  const late = attendanceRows.filter((r) => r.category === "late");
  const onLeave = attendanceRows.filter((r) => r.category === "on_leave");
  const notYet = attendanceRows.filter((r) => r.category === "not_yet");
  const absent = attendanceRows.filter((r) => r.category === "absent");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.shiftReports.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.shiftReports.subtitle")}
        </p>
      </div>

      {/* ── Section 1: Attendance summary — added 2026-05-25 per
          owner direction. Same data the cron sends to LINE at the
          configured time, but always visible here too + inline
          "send again" button so admin can re-fire when needed. */}
      <section>
        <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
          <h2 className="text-lg font-bold text-slate-800">
            📋 สรุปการเข้างานวันนี้
          </h2>
          <SendAttendanceSummaryButton />
        </div>
        <div className="card grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <div>
            <div className="text-xs font-bold text-emerald-700 mb-1">
              ✓ มาตรงเวลา ({onTime.length})
            </div>
            {onTime.length === 0 ? (
              <div className="text-xs text-slate-400">—</div>
            ) : (
              <ul className="space-y-0.5">
                {onTime.map((r) => (
                  <li key={r.userId} className="text-slate-700">
                    {nameWithPrefix(r.titlePrefix, r.displayName)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-xs font-bold text-amber-700 mb-1">
              ⚠ มาสาย ({late.length})
            </div>
            {late.length === 0 ? (
              <div className="text-xs text-slate-400">—</div>
            ) : (
              <ul className="space-y-0.5">
                {late.map((r) => (
                  <li key={r.userId} className="text-slate-700">
                    {nameWithPrefix(r.titlePrefix, r.displayName)}
                    <span className="text-amber-600 text-xs"> · {r.minutesLate} นาที</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-xs font-bold text-sky-700 mb-1">
              📅 ลางาน ({onLeave.length})
            </div>
            {onLeave.length === 0 ? (
              <div className="text-xs text-slate-400">—</div>
            ) : (
              <ul className="space-y-0.5">
                {onLeave.map((r) => (
                  <li key={r.userId} className="text-slate-700">
                    {nameWithPrefix(r.titlePrefix, r.displayName)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-xs font-bold text-slate-600 mb-1">
              ⏰ ยังไม่ถึงเวลา ({notYet.length})
            </div>
            {notYet.length === 0 ? (
              <div className="text-xs text-slate-400">—</div>
            ) : (
              <ul className="space-y-0.5">
                {notYet.map((r) => (
                  <li key={r.userId} className="text-slate-700">
                    {nameWithPrefix(r.titlePrefix, r.displayName)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-xs font-bold text-rose-700 mb-1">
              ✗ ขาดงาน ({absent.length})
            </div>
            {absent.length === 0 ? (
              <div className="text-xs text-slate-400">—</div>
            ) : (
              <ul className="space-y-0.5">
                {absent.map((r) => (
                  <li key={r.userId} className="text-slate-700">
                    {nameWithPrefix(r.titlePrefix, r.displayName)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <p className="text-[11px] text-slate-400 mt-1.5">
          อัปเดตทุกครั้งที่รีเฟรชหน้านี้ · ส่งเข้ากลุ่ม executive อัตโนมัติเวลา {branch.attendance_summary_time || "—"}
        </p>
      </section>

      {/* ── Section 2 + 3: Shift report status + edit requests
          ShiftReportsClient renders 2 independent inner sections,
          each with its own h2 + card. We don't add an outer wrapper
          so they appear as distinct boxes in the page flow. */}
      <ShiftReportsClient
        branchName={branch.name}
        today={today}
        todayReports={todayReports}
        chains={chains}
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
