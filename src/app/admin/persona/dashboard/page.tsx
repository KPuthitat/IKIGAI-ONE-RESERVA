import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { nameWithPrefix } from "@/lib/name";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "HR Dashboard · PERSONA" };

// /admin/persona/dashboard — single-page executive HR overview.
//
// Inspired by the owner's reference mockup (2026-05-31): KPI cards
// at the top, distribution charts in the middle, contracts-expiring
// table + leave-type breakdown at the bottom. Every chart is inline
// SVG to keep the bundle small — no chart library, no client JS.
//
// All data is pulled from existing tables (users, user_branches,
// leave_requests, resignation_requests, branches) — no new schema.
// Filters: search-period (?days=30|90|365, default 365) and branch
// (?branch=<id>). Reading both from searchParams so the page stays
// shareable.

type CountRow = { label: string; count: number };
type StackRow = { label: string; a: number; b: number };

const PERIOD_OPTIONS = [
  { days: 30,  label: "30 วันที่ผ่านมา" },
  { days: 90,  label: "90 วันที่ผ่านมา" },
  { days: 365, label: "1 ปีที่ผ่านมา" }
];

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

export default function HRDashboard({
  searchParams
}: { searchParams: { days?: string; branch?: string } }) {
  requireAdmin();
  const lang = getLang();
  const db = getDb();

  const days = Math.max(7, Math.min(3650,
    parseInt(searchParams.days ?? "365", 10) || 365));
  const periodStart = new Date(Date.now() - days * 86_400_000)
    .toISOString().slice(0, 10);

  const branchFilter = searchParams.branch
    ? parseInt(searchParams.branch, 10) || null
    : null;

  // Branch list for the dropdown
  const branches = db.prepare(
    "SELECT id, name FROM branches ORDER BY name"
  ).all() as Array<{ id: number; name: string }>;
  const branchName = branchFilter
    ? branches.find((b) => b.id === branchFilter)?.name ?? "—"
    : "ทุกสาขา";

  // Common WHERE clause — active employees only (status NOT IN
  // disabled/resigned per CLAUDE.md guardrail), role in staff/admin
  // (admins are employees too).
  const whereActive = `
    u.status NOT IN ('disabled', 'resigned', 'terminated')
    AND u.role IN ('staff', 'admin')
  `;
  const branchJoin = branchFilter
    ? `JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ${branchFilter}`
    : "";

  // ── KPI counters ────────────────────────────────────────────
  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS n
    FROM users u
    ${branchJoin}
    WHERE ${whereActive}
  `).get() as { n: number };
  const total = totalRow.n;

  const ftRow = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS n
    FROM users u
    ${branchJoin}
    WHERE ${whereActive} AND u.employment_type = 'ft'
  `).get() as { n: number };
  const ptRow = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS n
    FROM users u
    ${branchJoin}
    WHERE ${whereActive} AND u.employment_type = 'pt'
  `).get() as { n: number };

  // New hires in period (hire_date >= periodStart)
  const newHires = db.prepare(`
    SELECT COUNT(DISTINCT u.id) AS n
    FROM users u
    ${branchJoin}
    WHERE ${whereActive}
      AND u.hire_date IS NOT NULL
      AND u.hire_date >= ?
  `).get(periodStart) as { n: number };

  // Resignations in period (status = 'resigned' for the historical
  // view, regardless of current state)
  const resignationsInPeriod = db.prepare(`
    SELECT COUNT(*) AS n
    FROM users u
    ${branchFilter ? `JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ${branchFilter}` : ""}
    WHERE u.status = 'resigned'
      AND u.resigned_at >= ?
  `).get(periodStart) as { n: number };

  // Turnover rate ≈ resignations / avg_headcount.
  // Approximate avg headcount as current + leavers / 2.
  const avgHeadcount = total + resignationsInPeriod.n / 2;
  const turnoverRate = avgHeadcount > 0
    ? (resignationsInPeriod.n / avgHeadcount) * 100
    : 0;

  // ── Gender split ────────────────────────────────────────────
  const genderRows = db.prepare(`
    SELECT u.gender AS label, COUNT(DISTINCT u.id) AS count
    FROM users u
    ${branchJoin}
    WHERE ${whereActive}
    GROUP BY u.gender
  `).all() as CountRow[];

  // ── By branch ───────────────────────────────────────────────
  const byBranch = db.prepare(`
    SELECT b.name AS label, COUNT(DISTINCT u.id) AS count
    FROM users u
    JOIN user_branches ub ON ub.user_id = u.id
    JOIN branches b ON b.id = ub.branch_id
    WHERE u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND u.role IN ('staff', 'admin')
    GROUP BY b.id
    ORDER BY count DESC
  `).all() as CountRow[];

  // ── Age buckets ─────────────────────────────────────────────
  const ageRows = db.prepare(`
    SELECT u.dob FROM users u
    ${branchJoin}
    WHERE ${whereActive} AND u.dob IS NOT NULL
  `).all() as Array<{ dob: string }>;
  const ageBuckets = [
    { label: "ต่ำกว่า 25", count: 0 },
    { label: "25–34",   count: 0 },
    { label: "35–44",   count: 0 },
    { label: "45–54",   count: 0 },
    { label: "55+",     count: 0 }
  ];
  const todayY = new Date().getFullYear();
  for (const r of ageRows) {
    const y = parseInt(r.dob.slice(0, 4), 10);
    if (!Number.isFinite(y)) continue;
    const age = todayY - y;
    if (age < 25) ageBuckets[0].count++;
    else if (age < 35) ageBuckets[1].count++;
    else if (age < 45) ageBuckets[2].count++;
    else if (age < 55) ageBuckets[3].count++;
    else ageBuckets[4].count++;
  }

  // ── Leave types in period ───────────────────────────────────
  const leaveRows = db.prepare(`
    SELECT lr.type AS label, SUM(lr.days) AS count
    FROM leave_requests lr
    JOIN users u ON u.id = lr.user_id
    ${branchFilter ? `JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ${branchFilter}` : ""}
    WHERE lr.status = 'approved'
      AND lr.date_from >= ?
    GROUP BY lr.type
    ORDER BY count DESC
  `).all(periodStart) as Array<{ label: string; count: number }>;

  // ── Hires vs leaves by month (last 12 months) ───────────────
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7)); // YYYY-MM
  }
  const monthlySeries: StackRow[] = months.map((ym) => ({
    label: ym, a: 0, b: 0
  }));
  const hiresByMonth = db.prepare(`
    SELECT substr(u.hire_date, 1, 7) AS ym, COUNT(*) AS n
    FROM users u
    ${branchJoin}
    WHERE u.hire_date IS NOT NULL
      AND u.hire_date >= ?
    GROUP BY ym
  `).all(months[0] + "-01") as Array<{ ym: string; n: number }>;
  for (const r of hiresByMonth) {
    const slot = monthlySeries.find((m) => m.label === r.ym);
    if (slot) slot.a = r.n;
  }
  const leavesByMonth = db.prepare(`
    SELECT substr(u.resigned_at, 1, 7) AS ym, COUNT(*) AS n
    FROM users u
    ${branchFilter ? `JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ${branchFilter}` : ""}
    WHERE u.status = 'resigned'
      AND u.resigned_at >= ?
    GROUP BY ym
  `).all(months[0] + "-01") as Array<{ ym: string; n: number }>;
  for (const r of leavesByMonth) {
    const slot = monthlySeries.find((m) => m.label === r.ym);
    if (slot) slot.b = r.n;
  }

  // ── Contracts expiring in next 90 days ──────────────────────
  const todayIso = new Date().toISOString().slice(0, 10);
  const in90 = new Date(Date.now() + 90 * 86_400_000)
    .toISOString().slice(0, 10);
  const expiring = db.prepare(`
    SELECT u.id, u.display_name, u.title_prefix, u.job_title, u.contract_end_date,
           b.name AS branch_name
    FROM users u
    LEFT JOIN user_branches ub ON ub.user_id = u.id
    LEFT JOIN branches b ON b.id = ub.branch_id
    WHERE ${whereActive}
      AND u.contract_end_date IS NOT NULL
      AND u.contract_end_date BETWEEN ? AND ?
      ${branchFilter ? `AND ub.branch_id = ${branchFilter}` : ""}
    ORDER BY u.contract_end_date ASC
    LIMIT 20
  `).all(todayIso, in90) as Array<{
    id: number; display_name: string; title_prefix: string | null; job_title: string | null;
    contract_end_date: string; branch_name: string | null;
  }>;

  // ── Pending leave requests (admin needs to action) ──────────
  const pendingLeaves = db.prepare(`
    SELECT COUNT(*) AS n
    FROM leave_requests lr
    JOIN users u ON u.id = lr.user_id
    ${branchFilter ? `JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ${branchFilter}` : ""}
    WHERE lr.status = 'pending'
  `).get() as { n: number };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.persona.dashboard.hrTitle")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.persona.dashboard.hrSubtitle")} · {PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `${days} วัน`} · {branchName}
        </p>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[11px] text-slate-500 mb-1">ช่วงเวลา</div>
          <div className="flex gap-1">
            {PERIOD_OPTIONS.map((p) => (
              <Link key={p.days}
                href={{ pathname: "/admin/persona/dashboard", query: {
                  ...(branchFilter ? { branch: branchFilter } : {}),
                  days: p.days
                }}}
                className={`text-xs px-3 py-1.5 rounded border ${
                  days === p.days
                    ? "bg-brand text-white border-brand font-bold"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}>
                {p.label}
              </Link>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] text-slate-500 mb-1">สาขา</div>
          <div className="flex flex-wrap gap-1">
            <Link href={{ pathname: "/admin/persona/dashboard", query: { days } }}
              className={`text-xs px-3 py-1.5 rounded border ${
                !branchFilter
                  ? "bg-brand text-white border-brand font-bold"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}>
              ทุกสาขา
            </Link>
            {branches.map((b) => (
              <Link key={b.id}
                href={{ pathname: "/admin/persona/dashboard", query: { days, branch: b.id } }}
                className={`text-xs px-3 py-1.5 rounded border ${
                  branchFilter === b.id
                    ? "bg-brand text-white border-brand font-bold"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}>
                {b.name}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <KPI label="พนักงานทั้งหมด" value={total} />
        <KPI label="ประจำ (FT)" value={ftRow.n}
          hint={total > 0 ? pct(ftRow.n, total) : ""} tone="emerald" />
        <KPI label="ชั่วคราว (PT)" value={ptRow.n}
          hint={total > 0 ? pct(ptRow.n, total) : ""} tone="amber" />
        <KPI label="เข้าใหม่" value={newHires.n}
          hint={`ใน ${days} วัน`} tone="sky" />
        <KPI label="ลาออก" value={resignationsInPeriod.n}
          hint={`ใน ${days} วัน`} tone="rose" />
      </div>

      {/* Distribution row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* By branch */}
        <ChartCard title="พนักงาน แยกตามสาขา">
          {byBranch.length === 0
            ? <EmptyChart />
            : <BarChart rows={byBranch} color="#3b82f6" />}
        </ChartCard>

        {/* Gender donut */}
        <ChartCard title="สัดส่วน เพศ">
          {genderRows.length === 0
            ? <EmptyChart />
            : <DonutChart rows={genderRows.map((r) => ({
                label: r.label === "male" ? "ชาย" : r.label === "female" ? "หญิง" : "อื่นๆ / ไม่ระบุ",
                count: r.count
              }))} />}
        </ChartCard>

        {/* Age */}
        <ChartCard title="ช่วงอายุของพนักงาน">
          {ageBuckets.every((b) => b.count === 0)
            ? <EmptyChart />
            : <BarChart rows={ageBuckets} color="#8b5cf6" />}
        </ChartCard>
      </div>

      {/* Turnover + Leave */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Turnover gauge */}
        <ChartCard title={`อัตราการลาออก (Turnover Rate) · ${days} วันล่าสุด`}>
          <div className="flex items-center justify-center py-2">
            <div className="text-center">
              <div className={`text-5xl font-bold ${
                turnoverRate > 10
                  ? "text-rose-600"
                  : turnoverRate > 5
                    ? "text-amber-600"
                    : "text-emerald-600"
              }`}>
                {turnoverRate.toFixed(2)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">
                เป้าหมาย: ไม่เกิน 8% · ลาออก {resignationsInPeriod.n} / พนักงาน {total} คน
              </div>
            </div>
          </div>
        </ChartCard>

        {/* Leave types */}
        <ChartCard title={`การลา แยกตามประเภท · ${days} วันล่าสุด`}>
          {leaveRows.length === 0
            ? <EmptyChart />
            : <DonutChart rows={leaveRows.map((l) => ({
                label: leaveTypeLabel(l.label),
                count: Math.round(l.count)
              }))} unit="วัน" />}
        </ChartCard>
      </div>

      {/* Monthly hires vs leaves */}
      <ChartCard title="พนักงานเข้าใหม่ & ลาออก รายเดือน · 12 เดือนล่าสุด">
        <MonthlySeriesChart series={monthlySeries} />
      </ChartCard>

      {/* Contracts expiring */}
      <div className="card">
        <h2 className="font-bold text-slate-800 text-sm mb-2">
          พนักงานที่ใกล้ครบสัญญา ({expiring.length})
          <span className="ml-2 text-xs font-normal text-slate-500">90 วันข้างหน้า</span>
        </h2>
        {expiring.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">
            ไม่มีพนักงานที่ใกล้ครบสัญญาในช่วง 90 วัน
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {expiring.map((e) => {
              const days = Math.ceil(
                (new Date(e.contract_end_date).getTime() - Date.now()) / 86_400_000
              );
              return (
                <Link key={e.id} href={`/admin/persona/staff/${e.id}`}
                  className="flex items-center justify-between py-2 hover:bg-slate-50 -mx-2 px-2 rounded">
                  <div className="min-w-0">
                    <div className="font-bold text-slate-800 text-sm">{nameWithPrefix(e.title_prefix, e.display_name)}</div>
                    <div className="text-xs text-slate-500">
                      {e.job_title ?? "—"}{e.branch_name && ` · ${e.branch_name}`}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-mono">{e.contract_end_date}</div>
                    <div className={`text-[11px] font-bold ${
                      days < 14 ? "text-rose-600"
                        : days < 30 ? "text-amber-600"
                        : "text-slate-500"
                    }`}>
                      อีก {days} วัน
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {pendingLeaves.n > 0 && (
        <Link href="/admin/persona/leave"
          className="card bg-amber-50 border-2 border-amber-200 hover:shadow-md transition flex items-center justify-between">
          <div>
            <div className="text-sm font-bold text-amber-900">
              มีคำขอลา {pendingLeaves.n} รายการรอการอนุมัติ
            </div>
            <div className="text-xs text-amber-700 mt-0.5">
              กดเพื่อไปจัดการ
            </div>
          </div>
          <div className="text-amber-900 font-bold text-2xl">→</div>
        </Link>
      )}
    </div>
  );
}

// ── KPI counter card ──────────────────────────────────────────
function KPI({
  label, value, hint, icon, tone
}: {
  label: string; value: number; hint?: string; icon?: string;
  tone?: "emerald" | "amber" | "sky" | "rose";
}) {
  const toneCls = tone === "emerald" ? "text-emerald-700"
    : tone === "amber" ? "text-amber-700"
    : tone === "sky" ? "text-sky-700"
    : tone === "rose" ? "text-rose-700"
    : "text-slate-800";
  return (
    <div className="card">
      <div className="text-[11px] text-slate-500 uppercase tracking-[1px] flex items-center gap-1">
        {icon} {label}
      </div>
      <div className={`text-3xl font-bold mt-1 tabular-nums ${toneCls}`}>
        {value.toLocaleString("th-TH")}
      </div>
      {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="font-bold text-slate-800 text-sm mb-3">{title}</h2>
      {children}
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="text-sm text-slate-400 text-center py-8">
      ไม่มีข้อมูลในช่วงเวลานี้
    </div>
  );
}

// ── Inline SVG charts (no chart library) ──────────────────────
function BarChart({ rows, color }: { rows: CountRow[]; color: string }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="text-xs">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-slate-600">{r.label}</span>
            <span className="font-bold text-slate-800 tabular-nums">{r.count}</span>
          </div>
          <div className="h-3 bg-slate-100 rounded overflow-hidden">
            <div className="h-full rounded transition-all"
              style={{
                width: `${(r.count / max) * 100}%`,
                backgroundColor: color
              }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ rows, unit }: { rows: CountRow[]; unit?: string }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0) return <EmptyChart />;
  const COLORS = ["#3b82f6", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#64748b"];
  const r = 60;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segments = rows.map((row, i) => {
    const len = (row.count / total) * c;
    const seg = {
      color: COLORS[i % COLORS.length],
      dasharray: `${len} ${c - len}`,
      offset
    };
    offset -= len;
    return seg;
  });
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 160 160" width={160} height={160} className="flex-shrink-0">
        <circle cx={80} cy={80} r={r} fill="none" stroke="#f1f5f9" strokeWidth={20} />
        {segments.map((s, i) => (
          <circle key={i}
            cx={80} cy={80} r={r}
            fill="none" stroke={s.color} strokeWidth={20}
            strokeDasharray={s.dasharray}
            strokeDashoffset={s.offset}
            transform="rotate(-90 80 80)" />
        ))}
        <text x={80} y={86} textAnchor="middle" className="font-bold fill-slate-800" fontSize="20">
          {total.toLocaleString("th-TH")}
        </text>
      </svg>
      <div className="flex-1 space-y-1 text-xs">
        {rows.map((row, i) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: COLORS[i % COLORS.length] }} />
            <span className="text-slate-700 flex-1 truncate">{row.label}</span>
            <span className="font-bold text-slate-800 tabular-nums">
              {row.count}{unit ? ` ${unit}` : ""}
            </span>
            <span className="text-slate-400 tabular-nums w-12 text-right">
              {pct(row.count, total)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlySeriesChart({ series }: { series: StackRow[] }) {
  const max = Math.max(...series.map((s) => Math.max(s.a, s.b)), 1);
  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-xs">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-emerald-500" /> เข้าใหม่
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-sm bg-rose-500" /> ลาออก
        </span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-1 min-w-full" style={{ minHeight: 140 }}>
          {series.map((row) => {
            const ym = row.label;
            const month = ym.slice(5, 7);
            const ha = (row.a / max) * 120;
            const hb = (row.b / max) * 120;
            return (
              <div key={ym} className="flex-1 min-w-[36px] flex flex-col items-center justify-end gap-1">
                <div className="flex items-end gap-0.5 h-[120px]">
                  <div className="w-3 bg-emerald-500 rounded-t" style={{ height: `${ha}px` }}
                    title={`เข้าใหม่ ${row.a} คน`} />
                  <div className="w-3 bg-rose-500 rounded-t" style={{ height: `${hb}px` }}
                    title={`ลาออก ${row.b} คน`} />
                </div>
                <div className="text-[10px] text-slate-500">{Number(month)}</div>
                {(row.a > 0 || row.b > 0) && (
                  <div className="text-[9px] text-slate-400">
                    {row.a}/{row.b}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function leaveTypeLabel(t: string): string {
  const map: Record<string, string> = {
    sick: "ลาป่วย", personal: "ลากิจ", vacation: "ลาพักร้อน",
    maternity: "ลาคลอด", ordination: "ลาบวช", military: "ลาทหาร",
    unpaid: "ลาไม่รับค่าจ้าง", other: "อื่นๆ"
  };
  return map[t] ?? t;
}
