// /staff/persona/calendar — staff's own monthly assignment view.
//
// Shows a list of "today + this month" per the supervisor's roster:
// date, position, shift code with time, and the position description
// so each staff knows their scope of work for that day.
//
// "No assignment" days are shown as days off (no late check kicks in).
// The page is read-only — staff can't move assignments around, only
// the supervisor edits the master roster.

import Link from "next/link";
import type { Metadata } from "next";
import { requireStaffOrAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import {
  listAssignmentsForUserMonth,
  listAssignmentsForMonth,
  listPositions,
  getLastPublish,
  type AssignmentForStaffCalendar
} from "@/lib/roster";
import OwlMascot from "../../../components/OwlMascot";
// Reuse the admin calendar component verbatim — same visual language,
// same birthday + greeting flow. Staff is in read-only mode by
// design (the admin component already disables edits).
import RosterCalendarView from "../../../admin/persona/roster/RosterCalendarView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตารางงานของฉัน · PERSONA" };

const DOW_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export default function StaffCalendarPage({
  searchParams
}: {
  searchParams: { month?: string; view?: string };
}) {
  const user = requireStaffOrAdmin();
  // 2026-05-30 — view toggle. Default stays on the list view that
  // shipped originally; staff opts into the calendar grid via
  // ?view=calendar. Calendar shows ALL colleagues' assignments
  // (not just self) so staff can see who they're sharing the shift
  // with — same data shape the admin calendar consumes.
  const view: "list" | "calendar" =
    searchParams.view === "calendar" ? "calendar" : "list";
  const lang = getLang();
  if (!user.activeBranchId) {
    return <div className="card text-sm text-slate-600">{t(lang, "staff.notAssignedBranch")}</div>;
  }
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;

  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const currentMonth = nowBkk.toISOString().slice(0, 7);
  const month = searchParams.month || currentMonth;
  const todayBkk = nowBkk.toISOString().slice(0, 10);

  const assignments = listAssignmentsForUserMonth(user.id, branch.id, month);
  const lastPublish = getLastPublish(branch.id, month);

  // For the calendar grid view we also fetch every assignment in the
  // branch so a staff can see who they're sharing the day with —
  // same shape the admin grid uses. List view stays user-scoped.
  const allMonthAssignments = view === "calendar"
    ? listAssignmentsForMonth(branch.id, month)
    : [];
  const positionsLite = view === "calendar"
    ? listPositions(branch.id).map((p) => ({ id: p.id, title: p.title }))
    : [];

  // Birthday layer for the calendar view. Same query as the admin
  // page — month-day slice from dob, scoped to this branch, exclude
  // disabled/resigned/test accounts.
  const birthdays = view === "calendar"
    ? (db.prepare(`
        SELECT u.id AS user_id, u.display_name, u.nickname_th,
               substr(u.dob, 6, 5) AS month_day
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
      }>)
    : [];

  // Bucket assignments by date (a staff can be in multiple positions
  // on the same day — show them grouped). Explicit element type so
  // the value array keeps the position_description field after
  // Next.js' module-boundary type inference.
  const byDate = new Map<string, AssignmentForStaffCalendar[]>();
  for (const a of assignments) {
    if (!byDate.has(a.assignment_date)) byDate.set(a.assignment_date, []);
    byDate.get(a.assignment_date)!.push(a);
  }

  // Build list of all days in the month — include "OFF" days so the
  // staff can confirm "no assignment = day off".
  const [yyyy, mm] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }

  // 6-month picker for browsing past + future
  const monthOptions: string[] = [];
  for (let i = -2; i <= 3; i++) {
    const d = new Date(Date.UTC(nowBkk.getUTCFullYear(), nowBkk.getUTCMonth() + i, 1));
    monthOptions.push(d.toISOString().slice(0, 7));
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "staff.persona.calendar.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "staff.persona.calendar.subtitle")}
        </p>
      </div>

      {lastPublish ? (
        <div className="card bg-emerald-50 border-emerald-200 text-sm text-emerald-800">
          ✓ {t(lang, lastPublish.kind === "publish"
            ? "staff.persona.calendar.publishedAt"
            : "staff.persona.calendar.editedAt", {
              ts: new Date(lastPublish.published_at).toISOString().slice(0, 16).replace("T", " ")
          })}
          {lastPublish.note && (
            <div className="text-xs text-emerald-700 mt-1">📝 {lastPublish.note}</div>
          )}
        </div>
      ) : (
        <div className="card bg-amber-50 border-amber-200 flex items-center gap-3">
          <OwlMascot size={64} mood="sleepy" showCoffee={false} />
          <div className="text-sm text-amber-800">
            ⏳ {t(lang, "staff.persona.calendar.notPublishedYet")}
          </div>
        </div>
      )}

      {/* Month picker + view toggle */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "staff.persona.calendar.month")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/staff/persona/calendar?month=${m}${view === "calendar" ? "&view=calendar" : ""}`}
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
        {/* View toggle — list (default, scrollable per-day) vs
            calendar (month grid showing colleagues + birthdays).
            Preserves the current month when switching. */}
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          <Link
            href={`/staff/persona/calendar?month=${month}`}
            className={`text-xs px-3 py-1 ${
              view === "list"
                ? "bg-brand text-white"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            📋 รายการ
          </Link>
          <Link
            href={`/staff/persona/calendar?month=${month}&view=calendar`}
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

      {view === "calendar" ? (
        <RosterCalendarView
          month={month}
          daysInMonth={daysInMonth}
          positions={positionsLite}
          assignments={allMonthAssignments.map((a) => ({
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
      <div className="card">
        <ul className="space-y-2">
          {days.map((d) => {
            const dayAssigns = byDate.get(d) ?? [];
            // Use Z (UTC midnight of the calendar date) so getUTCDay
            // matches the actual weekday — the previous +07:00 form
            // shifted the result back one day.
            const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
            const isToday = d === todayBkk;
            const isOff = dayAssigns.length === 0;
            return (
              <li
                key={d}
                className={`flex items-start gap-3 border-[1.5px] rounded-lg p-3 ${
                  isToday
                    ? "border-brand bg-rose-50/30 ring-1 ring-brand/30"
                    : "border-slate-200"
                }`}
              >
                <div className="flex-shrink-0 w-12 text-center">
                  <div className="text-2xl font-bold text-slate-800 leading-none">
                    {Number(d.slice(8))}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">{DOW_TH[dow]}</div>
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  {isOff ? (
                    <div className="text-sm text-slate-400 italic">
                      {t(lang, "staff.persona.calendar.dayOff")}
                    </div>
                  ) : (
                    dayAssigns.map((a) => (
                      <div key={a.id} className="text-sm">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className="inline-block w-3 h-3 rounded border border-slate-300"
                            style={{ backgroundColor: a.shift_color ?? "#cbd5e1" }}
                          />
                          <span className="font-bold text-slate-800">{a.position_title}</span>
                          <span className="text-slate-500">·</span>
                          <span className="font-mono text-xs text-slate-700">
                            {a.shift_start_time}–{a.shift_end_time}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                            {a.shift_code}
                          </span>
                        </div>
                        {a.position_description && (
                          <div className="text-[11px] text-slate-500 mt-1 whitespace-pre-wrap">
                            {a.position_description}
                          </div>
                        )}
                        {(a.shift_break_start && a.shift_break_end) && (
                          <div className="text-[10px] text-slate-400 mt-0.5">
                            ☕ {t(lang, "staff.persona.calendar.break")}: {a.shift_break_start}–{a.shift_break_end}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      )}
    </div>
  );
}
