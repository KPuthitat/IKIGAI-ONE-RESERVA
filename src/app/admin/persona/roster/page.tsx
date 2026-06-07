// /admin/persona/roster — monthly duty roster grid.
//
// Rows = positions configured for the branch.
// Cols = calendar days of the selected month (split into chunks of 7
//        on the client for readability).
// Cells = either empty ("+" button to assign) or a chip showing the
//         staff name + shift colour. Click any cell to open the
//         assign modal (staff picker + shift code picker).
//
// Totals along the right edge = shifts assigned per staff that month.
// Totals along the bottom = unique staff working each day.
//
// The grid is rendered entirely server-side; the client component is
// only for the assign modal + publish button.

import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  listShiftCodes,
  listPositions,
  listAssignmentsForMonth,
  getLastPublish
} from "@/lib/roster";
import RosterClient from "./RosterClient";
import RosterCalendarView from "./RosterCalendarView";
import NotifyShiftsButton from "./NotifyShiftsButton";
import CsvImportButton from "./CsvImportButton";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตารางมอบหมายงาน · PERSONA" };

type StaffOption = {
  id: number;
  display_name: string;
  title_prefix: string | null;
  first_name_th: string | null;
  last_name_th: string | null;
  employment_type: string | null;
};

export default function AdminRosterPage({
  searchParams
}: {
  searchParams: { month?: string; view?: string };
}) {
  const user = requireAdmin();
  // 2026-05-30 — view toggle. Default to the existing grid; admin
  // opts into calendar view via ?view=calendar. Calendar is
  // read-only; assign/clear still requires the grid.
  const view: "grid" | "calendar" =
    searchParams.view === "calendar" ? "calendar" : "grid";
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "admin.notAssignedBranch")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  // Default month — current Bangkok month
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const currentMonth = nowBkk.toISOString().slice(0, 7);
  const month = searchParams.month || currentMonth;
  const [yyyy, mm] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();

  const shiftCodes = listShiftCodes(branch.id);
  const positions = listPositions(branch.id);
  const assignments = listAssignmentsForMonth(branch.id, month);
  const lastPublish = getLastPublish(branch.id, month);

  // Birthday layer (2026-05-30) — every staff in this branch with a
  // dob on file. We pre-extract MM-DD so the calendar can match by
  // month-day across years without exposing the year of birth (also
  // mildly sensitive). is_test_account + resigned/disabled excluded
  // for the same reason they're excluded everywhere else.
  const birthdays = db.prepare(`
    SELECT u.id AS user_id,
           u.display_name,
           u.nickname_th,
           substr(u.dob, 6, 5) AS month_day  -- 'MM-DD' slice from 'YYYY-MM-DD'
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.dob IS NOT NULL
      AND length(u.dob) >= 10
      AND u.status NOT IN ('disabled', 'resigned')
      AND u.is_test_account = 0
  `).all(branch.id) as Array<{
    user_id: number;
    display_name: string;
    nickname_th: string | null;
    month_day: string;
  }>;

  // Staff pool — anyone assigned to this branch via user_branches.
  // Includes admins (a branch admin still works shifts like any other
  // employee) and excludes disabled accounts. super_admin is the
  // settings-only top role and isn't rosterable.
  const staff = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.first_name_th, u.last_name_th,
           u.employment_type
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    WHERE ub.branch_id = ?
      AND u.role IN ('staff','admin')
      AND u.status NOT IN ('disabled', 'resigned')
      AND u.is_test_account = 0
    ORDER BY u.display_name COLLATE NOCASE
  `).all(branch.id) as StaffOption[];

  const monthOptions: string[] = [];
  // Show current + 2 future months so supervisor can pre-plan ahead,
  // plus 3 past for review. 6 chips total like other monthly views.
  for (let i = -2; i <= 3; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() + i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.roster.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.persona.roster.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/admin/persona/roster/shifts"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50">
          ⚙️ {t(lang, "admin.persona.roster.manageShifts")}
        </Link>
        <Link href="/admin/persona/roster/positions"
          className="text-xs px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50">
          ⚙️ {t(lang, "admin.persona.roster.managePositions")}
        </Link>
        <CsvImportButton />
        <NotifyShiftsButton />
        <span className="flex-1" />
        {lastPublish && (
          <span className="text-[11px] text-slate-500">
            {t(lang, lastPublish.kind === "publish"
              ? "admin.persona.roster.lastPublishedAt"
              : "admin.persona.roster.lastEditedAt", {
                ts: new Date(lastPublish.published_at).toISOString().slice(0, 16).replace("T", " ")
            })}
          </span>
        )}
      </div>

      {/* Month picker + view toggle */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "admin.persona.roster.month")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/admin/persona/roster?month=${m}${view === "calendar" ? "&view=calendar" : ""}`}
            className={`text-xs px-2.5 py-1 rounded border ${
              m === month
                ? "bg-brand text-white border-brand"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m}
          </Link>
        ))}
        <span className="flex-1" />
        {/* View toggle — grid (full editor) vs calendar (read-only,
            see-at-a-glance overview). Preserves the current month in
            both URLs. */}
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          <Link
            href={`/admin/persona/roster?month=${month}`}
            className={`text-xs px-3 py-1 ${
              view === "grid"
                ? "bg-brand text-white"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            📋 ตาราง
          </Link>
          <Link
            href={`/admin/persona/roster?month=${month}&view=calendar`}
            className={`text-xs px-3 py-1 border-l border-slate-300 ${
              view === "calendar"
                ? "bg-brand text-white"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            🗓 ปฏิทิน
          </Link>
        </div>
      </div>

      {/* Empty-state hints when config is incomplete */}
      {shiftCodes.length === 0 && (
        <div className="card text-sm text-amber-700 bg-amber-50 border-amber-200">
          ⚠ {t(lang, "admin.persona.roster.emptyShifts")} —
          <Link href="/admin/persona/roster/shifts" className="ml-1 underline font-bold">
            {t(lang, "admin.persona.roster.goSetupShifts")}
          </Link>
        </div>
      )}
      {positions.length === 0 && (
        <div className="card text-sm text-amber-700 bg-amber-50 border-amber-200">
          ⚠ {t(lang, "admin.persona.roster.emptyPositions")} —
          <Link href="/admin/persona/roster/positions" className="ml-1 underline font-bold">
            {t(lang, "admin.persona.roster.goSetupPositions")}
          </Link>
        </div>
      )}

      {shiftCodes.length > 0 && positions.length > 0 && (
        view === "calendar" ? (
          <RosterCalendarView
            month={month}
            daysInMonth={daysInMonth}
            positions={positions.map((p) => ({ id: p.id, title: p.title }))}
            assignments={assignments.map((a) => ({
              id: a.id,
              date: a.assignment_date,
              position_id: a.position_id,
              user_id: a.user_id,
              user_display_name: a.user_display_name,
              user_first_name: a.user_first_name,
              user_last_name: a.user_last_name,
              shift_code_id: a.shift_code_id,
              shift_code: a.shift_code,
              shift_color: a.shift_color,
              shift_start_time: a.shift_start_time
            }))}
            birthdays={birthdays.map((b) => ({
              user_id: b.user_id,
              display_name: b.display_name,
              nickname_th: b.nickname_th,
              month_day: b.month_day,
              is_self: b.user_id === user.id
            }))}
            currentUserId={user.id}
          />
        ) : (
          <RosterClient
            month={month}
            daysInMonth={daysInMonth}
            positions={positions.map((p) => ({
              id: p.id, title: p.title, description: p.description
            }))}
            shiftCodes={shiftCodes.map((s) => ({
              id: s.id, code: s.code, name: s.name,
              start_time: s.start_time, end_time: s.end_time,
              color: s.color
            }))}
            staff={staff}
            assignments={assignments.map((a) => ({
              id: a.id,
              date: a.assignment_date,
              position_id: a.position_id,
              user_id: a.user_id,
              user_display_name: a.user_display_name,
              user_first_name: a.user_first_name,
              user_last_name: a.user_last_name,
              shift_code_id: a.shift_code_id,
              shift_code: a.shift_code,
              shift_color: a.shift_color,
              shift_start_time: a.shift_start_time
            }))}
          />
        )
      )}
    </div>
  );
}
