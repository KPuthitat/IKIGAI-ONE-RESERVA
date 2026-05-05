import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { todayBkk } from "@/lib/time";
import TimesheetsClient, { type TimeEntryRow, type UserOption, type AuditRow } from "./TimesheetsClient";

export const dynamic = "force-dynamic";

export default function TimesheetsPage({
  searchParams
}: {
  searchParams: { from?: string; to?: string; user_id?: string };
}) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

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

  // Query entries with user join
  const params: Array<string | number> = [fromIso, toIso];
  let userClause = "";
  if (userIdFilter) {
    userClause = "AND te.user_id = ?";
    params.push(userIdFilter);
  }

  const entries = db.prepare(`
    SELECT te.id, te.user_id, te.type, te.ts, u.username, u.display_name
    FROM time_entries te
    JOIN users u ON te.user_id = u.id
    WHERE te.ts >= ? AND te.ts <= ? ${userClause}
    ORDER BY te.ts DESC
    LIMIT 500
  `).all(...params) as TimeEntryRow[];

  // user dropdown — เฉพาะคนที่มี entries ใน DB หรือ user ที่มี pin_hash
  const users = db.prepare(`
    SELECT DISTINCT u.id, u.username, u.display_name
    FROM users u
    WHERE u.id IN (SELECT DISTINCT user_id FROM time_entries)
       OR u.pin_hash IS NOT NULL
    ORDER BY u.display_name
  `).all() as UserOption[];

  // audit log ล่าสุด (10 รายการ)
  const audit = db.prepare(`
    SELECT a.id, a.entry_id, a.entry_user_id, a.entry_type, a.entry_ts,
           a.action, a.admin_id, a.reason, a.created_at,
           u.display_name AS entry_user_name,
           au.display_name AS admin_name
    FROM time_entries_audit a
    LEFT JOIN users u ON a.entry_user_id = u.id
    LEFT JOIN users au ON a.admin_id = au.id
    ORDER BY a.created_at DESC
    LIMIT 10
  `).all() as AuditRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.timesheets.title")}
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
        entries={entries}
        audit={audit}
      />
    </div>
  );
}
