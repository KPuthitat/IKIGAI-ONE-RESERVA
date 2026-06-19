import Link from "next/link";
import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "PERSONA · Admin" };

type Counter = { n: number };
type RecentLeave = {
  id: number;
  ref_no: string | null;
  type: string;
  date_from: string;
  date_to: string;
  status: string;
  is_special_request: number;
  display_name: string;
  title_prefix: string | null;
};
type RecentResig = {
  id: number;
  ref_no: string | null;
  proposed_last_day: string;
  status: string;
  display_name: string;
  title_prefix: string | null;
};

export default function AdminPersonaDashboard() {
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

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const startIso = new Date(`${todayBkk}T00:00:00+07:00`).toISOString();
  const endIso = new Date(`${todayBkk}T23:59:59+07:00`).toISOString();

  // All counters scoped to the active branch (Phase 2). The dashboard
  // reflects "what's pending at this branch" so admin gets a focused
  // view per location. Resignation requests don't carry branch_id yet
  // (out of scope for this phase) — that block is shown unfiltered
  // with a small note.
  const pendingLeave = (db.prepare(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE branch_id = ? AND status = 'pending'"
  ).get(branch.id) as Counter).n;
  const specialLeave = (db.prepare(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE branch_id = ? AND status = 'pending' AND is_special_request = 1"
  ).get(branch.id) as Counter).n;
  const revisionLeave = (db.prepare(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE branch_id = ? AND status = 'revision_requested'"
  ).get(branch.id) as Counter).n;
  const pendingResig = (db.prepare(
    "SELECT COUNT(*) AS n FROM resignation_requests WHERE status = 'pending'"
  ).get() as Counter).n;

  // Staff counts — only people assigned to this branch via user_branches.
  // is_test_account = 0 filter (2026-05-27) excludes test/admin accounts
  // from operational dashboards.
  const ptCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type = 'pt' AND u.is_test_account = 0
  `).get(branch.id) as Counter).n;
  const ftCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type = 'ft' AND u.is_test_account = 0
  `).get(branch.id) as Counter).n;
  const unsetCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.role IN ('staff', 'admin') AND u.employment_type IS NULL AND u.is_test_account = 0
  `).get(branch.id) as Counter).n;
  const resigUnlocked = (db.prepare(`
    SELECT COUNT(*) AS n FROM users u
    INNER JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
    WHERE u.resignation_unlocked_at IS NOT NULL AND u.is_test_account = 0
  `).get(branch.id) as Counter).n;
  const clockedInToday = (db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS n FROM time_entries
    WHERE branch_id = ? AND ts >= ? AND ts <= ?
  `).get(branch.id, startIso, endIso) as Counter).n;

  // ── Recent activity (also branch-scoped for leaves) ──────────────────
  const recentLeaves = db.prepare(`
    SELECT r.id, r.ref_no, r.type, r.date_from, r.date_to, r.status, r.is_special_request,
           u.display_name, u.title_prefix
    FROM leave_requests r JOIN users u ON r.user_id = u.id
    WHERE r.branch_id = ?
    ORDER BY r.created_at DESC LIMIT 5
  `).all(branch.id) as RecentLeave[];
  const recentResigs = db.prepare(`
    SELECT r.id, r.ref_no, r.proposed_last_day, r.status, u.display_name, u.title_prefix
    FROM resignation_requests r JOIN users u ON r.user_id = u.id
    ORDER BY r.created_at DESC LIMIT 5
  `).all() as RecentResig[];

  // ── Render helpers ─────────────────────────────────────────────────
  function StatCard({
    href, label, value, accent, sub
  }: { href: string; label: string; value: number; accent: "amber" | "rose" | "violet" | "slate"; sub?: string }) {
    const colorClass =
      value === 0 ? "text-slate-300" :
      accent === "amber" ? "text-amber-600" :
      accent === "rose" ? "text-rose-600" :
      accent === "violet" ? "text-violet-600" :
      "text-slate-800";
    return (
      <Link href={href} className="card hover:shadow-md transition block">
        <div className="text-xs text-slate-500">{label}</div>
        <div className={`text-3xl font-bold mt-1 ${colorClass}`}>{value}</div>
        {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
      </Link>
    );
  }

  function statusBadgeCls(s: string): string {
    if (s === "pending") return "bg-amber-100 text-amber-700";
    if (s === "approved") return "bg-emerald-100 text-emerald-700";
    if (s === "rejected") return "bg-rose-100 text-rose-700";
    if (s === "cancelled") return "bg-slate-100 text-slate-500";
    if (s === "revision_requested") return "bg-orange-100 text-orange-700";
    return "bg-slate-100 text-slate-500";
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">
          {t(lang, "admin.persona.dashboard.title")}
          <span className="ml-2 text-sm font-medium text-brand">· {branch.name}</span>
        </h1>
        <p className="text-sm text-slate-500">{t(lang, "admin.persona.dashboard.subtitle")}</p>
      </div>

      {/* Action items */}
      {/* HR Dashboard banner — links to the executive overview that
          aggregates everything (headcount / turnover / leave / age /
          gender / contracts expiring). 2026-05-31. */}
      <Link href="/admin/persona/dashboard"
        className="card hover:shadow-md transition flex items-center justify-between gap-3 bg-gradient-to-r from-sky-50 to-emerald-50 border-2 border-sky-200 group">
        <div className="flex items-center gap-3">
          <div className="text-3xl">📊</div>
          <div>
            <div className="font-bold text-slate-800 group-hover:text-brand transition-colors">
              HR Dashboard
            </div>
            <div className="text-xs text-slate-500">
              ภาพรวมบุคลากรในองค์กร · ลาออก / เข้าใหม่ / การลา / ครบสัญญา
            </div>
          </div>
        </div>
        <div className="text-brand font-bold text-2xl">→</div>
      </Link>

      <div>
        <h2 className="text-sm font-semibold text-slate-600 mb-2">
          {t(lang, "admin.persona.dashboard.actionItems")}
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            href="/admin/persona/leave?status=pending"
            label={t(lang, "admin.persona.stat.pendingLeave")}
            value={pendingLeave}
            accent="amber"
          />
          <StatCard
            href="/admin/persona/leave?status=special"
            label={t(lang, "admin.persona.stat.pendingSpecial")}
            value={specialLeave}
            accent="violet"
          />
          <StatCard
            href="/admin/persona/leave?status=revision_requested"
            label={t(lang, "admin.persona.stat.pendingRevision")}
            value={revisionLeave}
            accent="amber"
          />
          <StatCard
            href="/admin/persona/resignation?status=pending"
            label={t(lang, "admin.persona.stat.pendingResignation")}
            value={pendingResig}
            accent="rose"
          />
        </div>
      </div>

      {/* Staff counts */}
      <div>
        <h2 className="text-sm font-semibold text-slate-600 mb-2">
          {t(lang, "admin.persona.dashboard.staffCounts")}
        </h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            href="/admin/persona/employees"
            label={t(lang, "admin.persona.stat.pt")}
            value={ptCount}
            accent="slate"
          />
          <StatCard
            href="/admin/persona/employees"
            label={t(lang, "admin.persona.stat.ft")}
            value={ftCount}
            accent="slate"
          />
          <StatCard
            href="/admin/persona/employees"
            label={t(lang, "admin.persona.stat.staffUnset")}
            value={unsetCount}
            accent="amber"
            sub={unsetCount > 0 ? t(lang, "admin.persona.stat.staffUnsetHint") : undefined}
          />
          <StatCard
            href="/admin/persona/timesheets"
            label={t(lang, "admin.persona.stat.clockedInToday")}
            value={clockedInToday}
            accent="slate"
          />
        </div>
      </div>

      {/* Recent activity */}
      <div className="grid lg:grid-cols-2 gap-3">
        <div className="card">
          <h2 className="font-semibold mb-3 flex items-center justify-between">
            <span>{t(lang, "admin.persona.dashboard.recentLeaves")}</span>
            <Link href="/admin/persona/leave?status=all" className="text-xs text-brand font-normal hover:underline">
              {t(lang, "admin.persona.dashboard.viewAll")} →
            </Link>
          </h2>
          {recentLeaves.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">{t(lang, "admin.persona.dashboard.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {recentLeaves.map((r) => (
                <li key={r.id} className="text-sm flex items-start gap-2 border-b last:border-0 border-slate-100 pb-2 last:pb-0">
                  <div className="flex-1 min-w-0">
                    {r.ref_no && (
                      <span className="text-xs text-slate-400 font-mono mr-1.5">#{r.ref_no}</span>
                    )}
                    <span className="font-medium text-slate-700">{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                    <span className="text-slate-500 mx-1.5">·</span>
                    <span className="text-slate-600">{t(lang, `leave.type.${r.type}` as any)}</span>
                    {r.is_special_request === 1 && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-medium bg-violet-100 text-violet-700">
                        ★
                      </span>
                    )}
                    <div className="text-xs text-slate-400 mt-0.5">
                      {r.date_from === r.date_to ? r.date_from : `${r.date_from} → ${r.date_to}`}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-medium whitespace-nowrap ${statusBadgeCls(r.status)}`}>
                    {t(lang, `leave.status.${r.status}` as any)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="font-semibold mb-3 flex items-center justify-between">
            <span>{t(lang, "admin.persona.dashboard.recentResignations")}</span>
            <Link href="/admin/persona/resignation?status=all" className="text-xs text-brand font-normal hover:underline">
              {t(lang, "admin.persona.dashboard.viewAll")} →
            </Link>
          </h2>
          {recentResigs.length === 0 ? (
            <p className="text-sm text-slate-400 py-4 text-center">{t(lang, "admin.persona.dashboard.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {recentResigs.map((r) => (
                <li key={r.id} className="text-sm flex items-start gap-2 border-b last:border-0 border-slate-100 pb-2 last:pb-0">
                  <div className="flex-1 min-w-0">
                    {r.ref_no && (
                      <span className="text-xs text-slate-400 font-mono mr-1.5">#{r.ref_no}</span>
                    )}
                    <span className="font-medium text-slate-700">{nameWithPrefix(r.title_prefix, r.display_name)}</span>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {t(lang, "admin.persona.dashboard.lastDay")}: {r.proposed_last_day}
                    </div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-medium whitespace-nowrap ${statusBadgeCls(r.status)}`}>
                    {t(lang, `leave.status.${r.status}` as any)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Resignation unlocks reminder */}
      {resigUnlocked > 0 && (
        <div className="card border-l-4 border-amber-400 bg-amber-50">
          <h2 className="font-semibold text-slate-800 mb-1">
            {t(lang, "admin.persona.dashboard.resigUnlockedTitle")}
          </h2>
          <p className="text-sm text-slate-600">
            {t(lang, "admin.persona.dashboard.resigUnlockedBody", { n: resigUnlocked })}
          </p>
          <Link href="/admin/persona/resignation" className="text-sm text-brand font-medium mt-2 inline-block">
            {t(lang, "admin.persona.dashboard.manageUnlocks")} →
          </Link>
        </div>
      )}

      {/* Involuntary termination (เลิกจ้าง) — admin-initiated, separate
          from the staff-driven resignation flow above. */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-1">เลิกจ้างพนักงาน</h2>
        <p className="text-sm text-slate-600">
          บันทึกการเลิกจ้าง (ไม่ผ่านทดลองงาน / มีความผิด / ลดคน / สิ้นสุดสัญญา) พร้อมคำนวณค่าชดเชยตามอายุงาน
        </p>
        <Link href="/admin/persona/termination" className="text-sm text-brand font-medium mt-2 inline-block">
          ไปที่หน้าเลิกจ้าง →
        </Link>
      </div>

      {/* Legacy card removed 2026-05-13 — all features now native.
          /admin/persona/legacy URL still resolves during the
          ~2-week transition period and can then be deleted. */}
    </div>
  );
}
