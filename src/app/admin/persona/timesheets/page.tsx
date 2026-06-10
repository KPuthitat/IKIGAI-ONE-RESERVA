import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { todayBkk } from "@/lib/time";
import TimesheetsClient, { type TimesheetDayRow, type UserOption, type AuditRow } from "./TimesheetsClient";

export const dynamic = "force-dynamic";

// Per-branch since 2026-05 (Phase 2): timesheet rows are filtered by
// time_entries.branch_id matching the admin's currently-active branch.
// Same staff working morning at A and afternoon at B will appear in
// each branch's timesheet — that's intentional, since payroll splits
// the same way.
export default function TimesheetsPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; user_id?: string };
}) {
  const user = requireAdmin();
  const lang = getLang();
  const db = getDb();

  if (!user.activeBranchId) {
    return (
      <div className="card text-sm text-slate-600">
        {t(lang, "admin.notAssignedBranch")}
      </div>
    );
  }
  const branch = db.prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) {
    return <div className="card text-sm text-slate-600">{t(lang, "common.error")}</div>;
  }

  // default range = 7 วันย้อนหลัง (รวมวันนี้)
  const today = todayBkk();
  const sevenAgo = new Date(new Date(`${today}T00:00:00+07:00`).getTime() - 6 * 86400_000)
    .toISOString().slice(0, 10);

  const from = searchParams.from || sevenAgo;
  const to = searchParams.to || today;
  const userIdFilter = searchParams.user_id ? Number(searchParams.user_id) : null;

  // Bangkok-aware range → ISO timestamps
  const fromIso = new Date(`${from}T00:00:00+07:00`).toISOString();
  const toIso = new Date(`${to}T23:59:59+07:00`).toISOString();

  // Query entries with user join — scoped to the active branch.
  const params: Array<string | number> = [branch.id, fromIso, toIso];
  let userClause = "";
  if (userIdFilter) {
    userClause = "AND te.user_id = ?";
    params.push(userIdFilter);
  }

  const punches = db.prepare(`
    SELECT te.id, te.user_id, te.type, te.ts, u.username,
           u.display_name, u.title_prefix
    FROM time_entries te
    JOIN users u ON te.user_id = u.id
    WHERE te.branch_id = ? AND te.ts >= ? AND te.ts <= ? ${userClause}
    ORDER BY te.ts ASC
    LIMIT 1000
  `).all(...params) as Array<{
    id: number; user_id: number; type: "in" | "out"; ts: string;
    username: string; display_name: string; title_prefix: string | null;
  }>;

  // Approved OT until-times for the range, keyed by `${user_id}|${work_date}`.
  // Only approved OT counts toward pay, so only that surfaces here.
  const otRows = db.prepare(`
    SELECT user_id, work_date, requested_until
    FROM ot_requests
    WHERE branch_id = ? AND status = 'approved'
      AND work_date >= ? AND work_date <= ?
  `).all(branch.id, from, to) as Array<{ user_id: number; work_date: string; requested_until: string }>;
  const otByKey = new Map<string, string>();
  for (const r of otRows) otByKey.set(`${r.user_id}|${r.work_date}`, r.requested_until);

  // Roster shift per (user, date). When a staff holds multiple positions
  // on the same day, the earliest-start shift wins (they had to be in by
  // then) — matches effectiveShiftStartForUserDate's rule.
  const shiftRows = db.prepare(`
    SELECT a.user_id, a.assignment_date, s.code, s.start_time, s.end_time, s.kind
    FROM roster_assignments a
    JOIN shift_codes s ON s.id = a.shift_code_id
    WHERE a.branch_id = ? AND a.assignment_date >= ? AND a.assignment_date <= ?
    ORDER BY a.assignment_date ASC, s.start_time ASC
  `).all(branch.id, from, to) as Array<{
    user_id: number; assignment_date: string;
    code: string; start_time: string; end_time: string; kind: string;
  }>;
  const shiftByKey = new Map<string, { code: string; start_time: string; end_time: string; kind: string }>();
  for (const r of shiftRows) {
    const k = `${r.user_id}|${r.assignment_date}`;
    if (!shiftByKey.has(k)) {
      shiftByKey.set(k, { code: r.code, start_time: r.start_time, end_time: r.end_time, kind: r.kind });
    }
  }

  // Group raw punches into one row per (employee, Bangkok-date). Each row
  // carries every in/out punch that day (so delete/resend still works per
  // punch) plus the roster shift + approved OT for that day.
  const bkkDate = (ts: string) =>
    new Date(new Date(ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const dayMap = new Map<string, TimesheetDayRow>();
  for (const p of punches) {
    const date = bkkDate(p.ts);
    const key = `${p.user_id}|${date}`;
    let row = dayMap.get(key);
    if (!row) {
      row = {
        user_id: p.user_id,
        display_name: p.display_name,
        title_prefix: p.title_prefix,
        username: p.username,
        work_date: date,
        ins: [],
        outs: [],
        ot_until: otByKey.get(key) ?? null,
        shift: shiftByKey.get(key) ?? null
      };
      dayMap.set(key, row);
    }
    if (p.type === "in") row.ins.push({ id: p.id, ts: p.ts });
    else row.outs.push({ id: p.id, ts: p.ts });
  }
  // Newest day first, then by staff name (Thai collation).
  const dayRows = [...dayMap.values()].sort((a, b) =>
    a.work_date === b.work_date
      ? a.display_name.localeCompare(b.display_name, "th")
      : b.work_date.localeCompare(a.work_date)
  );

  // User dropdown — only people assigned to this branch (so admin
  // doesn't see staff from the other branch in the filter list).
  const users = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.display_name, u.title_prefix
    FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.is_test_account = 0
      AND (
        u.id IN (SELECT DISTINCT user_id FROM time_entries WHERE branch_id = ?)
        OR u.pin_hash IS NOT NULL
      )
    ORDER BY CASE WHEN u.employment_type = 'ft' THEN 0 WHEN u.employment_type = 'pt' THEN 1 ELSE 2 END,
             u.display_name
  `).all(branch.id, branch.id) as UserOption[];

  // audit log ล่าสุด (10 รายการ) — scoped to the admin's active
  // branch. Filter via the recipient user being assigned to this
  // branch (entry_user_id IN user_branches WHERE branch_id = ?).
  // This is the broadest available proxy since time_entries_audit
  // doesn't carry branch_id directly (it snapshots fields from the
  // deleted time_entries row but not its branch). Previously this
  // query had no WHERE clause and leaked audit events from every
  // branch — an AT-HOME admin could see NAMA staff edits.
  const audit = db.prepare(`
    SELECT a.id, a.entry_id, a.entry_user_id, a.entry_type, a.entry_ts,
           a.action, a.admin_id, a.reason, a.created_at,
           u.display_name AS entry_user_name,
           au.display_name AS admin_name
    FROM time_entries_audit a
    LEFT JOIN users u ON a.entry_user_id = u.id
    LEFT JOIN users au ON a.admin_id = au.id
    WHERE a.entry_user_id IN (
      SELECT user_id FROM user_branches WHERE branch_id = ?
    )
    ORDER BY a.created_at DESC
    LIMIT 10
  `).all(branch.id) as AuditRow[];

  // Punches that came from an approved time certification — so the client
  // can tag them "รับรองเวลา" (owner 2026-06-10). Small table; pass all
  // approved entry_ids and let the client match by id.
  const certEntryIds = (db.prepare(`
    SELECT entry_id FROM time_certifications
    WHERE status = 'approved' AND entry_id IS NOT NULL
  `).all() as Array<{ entry_id: number }>).map((r) => r.entry_id);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.timesheets.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.timesheets.subtitle")}
        </p>
      </div>

      <TimesheetsClient
        lang={lang}
        from={from}
        to={to}
        userIdFilter={userIdFilter}
        users={users}
        dayRows={dayRows}
        audit={audit}
        certEntryIds={certEntryIds}
      />
    </div>
  );
}
