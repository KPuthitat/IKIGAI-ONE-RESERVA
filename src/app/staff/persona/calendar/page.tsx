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
  getLastPublish,
  type AssignmentForStaffCalendar
} from "@/lib/roster";
import OwlMascot from "../../../components/OwlMascot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตารางงานของฉัน · PERSONA" };

const DOW_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export default function StaffCalendarPage({
  searchParams
}: {
  searchParams: { month?: string };
}) {
  const user = requireStaffOrAdmin();
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

      {/* Month picker */}
      <div className="card flex items-center gap-2 flex-wrap">
        <span className="text-sm font-bold text-slate-700">
          {t(lang, "staff.persona.calendar.month")}:
        </span>
        {monthOptions.map((m) => (
          <Link
            key={m}
            href={`/staff/persona/calendar?month=${m}`}
            className={`text-xs px-2.5 py-1 rounded border ${
              m === month
                ? "bg-brand text-white border-brand"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {m}
          </Link>
        ))}
      </div>

      <div className="card">
        <ul className="space-y-2">
          {days.map((d) => {
            const dayAssigns = byDate.get(d) ?? [];
            const dow = new Date(`${d}T00:00:00+07:00`).getUTCDay();
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
    </div>
  );
}
