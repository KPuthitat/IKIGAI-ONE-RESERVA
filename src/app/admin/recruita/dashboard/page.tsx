import type { Metadata } from "next";
import Link from "next/link";
import { requireSuperAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import type { ApplicationStage } from "@/lib/recruita";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "RECRUITA · Analytics" };

// /admin/recruita/dashboard — single-page recruitment analytics.
//
// Funnel + source attribution + time-to-hire + per-position fill
// rate + monthly applications. All read-only. Server-rendered with
// inline SVG charts (no client JS) — matches the HR Dashboard
// pattern. Filters: period (?days=) + position (?position=).

const PERIOD_OPTIONS = [
  { days: 30,  label: "30 วันที่ผ่านมา" },
  { days: 90,  label: "90 วันที่ผ่านมา" },
  { days: 365, label: "1 ปีที่ผ่านมา" }
];

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return ((n / total) * 100).toFixed(1) + "%";
}

// Conversion-funnel ordering. Rejected/withdrawn terminate at
// whatever step they exited and don't appear in later steps; the
// funnel counts current stage at-or-past each level (the schema
// doesn't carry a per-stage history yet, so this is the closest
// proxy for "made it to step X").
const FUNNEL_STEPS: Array<{
  key: ApplicationStage; label: string; downstream: ApplicationStage[];
}> = [
  { key: "applied",   label: "📩 ใบสมัครเข้า",  downstream: ["screening","interview","offered","accepted","hired"] },
  { key: "screening", label: "🔍 ผ่านคัดกรอง",  downstream: ["interview","offered","accepted","hired"] },
  { key: "interview", label: "🗣 สัมภาษณ์",      downstream: ["offered","accepted","hired"] },
  { key: "offered",   label: "📨 เสนองาน",      downstream: ["accepted","hired"] },
  { key: "hired",     label: "✅ รับเข้าทำงาน",  downstream: [] }
];

export default function RecruitaDashboard({
  searchParams
}: { searchParams: { days?: string; position?: string } }) {
  requireSuperAdmin();
  const lang = getLang();
  const db = getDb();

  const days = Math.max(7, Math.min(3650,
    parseInt(searchParams.days ?? "365", 10) || 365));
  const periodStart = new Date(Date.now() - days * 86_400_000).toISOString();

  const positionFilter = searchParams.position
    ? parseInt(searchParams.position, 10) || null
    : null;

  const positions = db.prepare(`
    SELECT p.id, p.title, p.code, p.vacancies,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id AND a.submitted_at >= ?) AS app_count,
           (SELECT COUNT(*) FROM recruita_applications a
              WHERE a.position_id = p.id AND a.stage = 'hired') AS hired_count
    FROM recruita_positions p
    WHERE p.status != 'draft'
    ORDER BY p.opened_at DESC
  `).all(periodStart) as Array<{
    id: number; title: string; code: string | null; vacancies: number;
    app_count: number; hired_count: number;
  }>;
  const positionName = positionFilter
    ? positions.find((p) => p.id === positionFilter)?.title ?? "—"
    : "ทุกตำแหน่ง";

  // Branch + position filter clause shared by all per-application queries
  const wherePeriod = "a.submitted_at >= ?";
  const wherePosition = positionFilter ? "AND a.position_id = ?" : "";
  const paramsPosition = positionFilter ? [positionFilter] : [];

  // ── Total applications in period ────────────────────────────
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS n
    FROM recruita_applications a
    WHERE ${wherePeriod} ${wherePosition}
  `).get(periodStart, ...paramsPosition) as { n: number };
  const totalApps = totalRow.n;

  // ── Funnel — count at or past each step (current-stage proxy)
  const funnelData = FUNNEL_STEPS.map((step) => {
    const inSet = [step.key, ...step.downstream];
    const placeholders = inSet.map(() => "?").join(",");
    const row = db.prepare(`
      SELECT COUNT(*) AS n
      FROM recruita_applications a
      WHERE ${wherePeriod} ${wherePosition}
        AND a.stage IN (${placeholders})
    `).get(periodStart, ...paramsPosition, ...inSet) as { n: number };
    return { label: step.label, count: row.n };
  });
  const totalAtTop = funnelData[0]?.count ?? 0;
  const hiredCount = funnelData[funnelData.length - 1]?.count ?? 0;

  // ── Time-to-hire (avg days, hired only) ─────────────────────
  const tthRow = db.prepare(`
    SELECT a.submitted_at, a.hired_at
    FROM recruita_applications a
    WHERE a.stage = 'hired'
      AND a.hired_at IS NOT NULL
      AND ${wherePeriod}
      ${wherePosition}
  `).all(periodStart, ...paramsPosition) as Array<{
    submitted_at: string; hired_at: string;
  }>;
  let tthSum = 0;
  for (const r of tthRow) {
    const ms = new Date(r.hired_at).getTime() - new Date(r.submitted_at).getTime();
    if (ms > 0) tthSum += ms;
  }
  const tthAvgDays = tthRow.length > 0
    ? tthSum / tthRow.length / 86_400_000
    : 0;

  // ── Source attribution ──────────────────────────────────────
  const sourceRows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(a.info_source), ''), 'ไม่ระบุ') AS label,
      COUNT(*) AS count
    FROM recruita_applications a
    WHERE ${wherePeriod} ${wherePosition}
    GROUP BY label
    ORDER BY count DESC
    LIMIT 10
  `).all(periodStart, ...paramsPosition) as Array<{ label: string; count: number }>;

  // ── Current stage distribution (all-time, scoped by position) ─
  const stageRows = db.prepare(`
    SELECT a.stage AS label, COUNT(*) AS count
    FROM recruita_applications a
    WHERE 1=1 ${wherePosition}
    GROUP BY a.stage
  `).all(...paramsPosition) as Array<{ label: string; count: number }>;
  const stageLabelMap: Record<string, string> = {
    applied: "ใหม่", screening: "คัดกรอง", interview: "สัมภาษณ์",
    offered: "เสนองาน", accepted: "ตอบรับ", hired: "รับเข้าทำงาน",
    rejected: "ไม่ผ่าน", withdrawn: "ถอนตัว"
  };

  // ── Monthly applications (12 months) ────────────────────────
  const months: string[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toISOString().slice(0, 7));
  }
  const monthlyApps = months.map((ym) => ({ label: ym, count: 0 }));
  const monthlyRows = db.prepare(`
    SELECT substr(a.submitted_at, 1, 7) AS ym, COUNT(*) AS n
    FROM recruita_applications a
    WHERE a.submitted_at >= ?
      ${wherePosition}
    GROUP BY ym
  `).all(months[0] + "-01T00:00:00Z", ...paramsPosition) as Array<{ ym: string; n: number }>;
  for (const r of monthlyRows) {
    const slot = monthlyApps.find((m) => m.label === r.ym);
    if (slot) slot.count = r.n;
  }

  // ── Per-position fill rate ──────────────────────────────────
  const fillRows = positions
    .filter((p) => p.vacancies > 0)
    .map((p) => ({
      id: p.id,
      label: p.code ? `[${p.code}] ${p.title}` : p.title,
      app_count: p.app_count,
      hired: p.hired_count,
      vacancies: p.vacancies,
      fill_pct: Math.min(100, (p.hired_count / p.vacancies) * 100)
    }))
    .sort((a, b) => b.fill_pct - a.fill_pct);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          RECRUITA · <span className="font-medium text-slate-600">{t(lang, "admin.recruita.dashboard.title")}</span>
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.recruita.dashboard.subtitle")} · {PERIOD_OPTIONS.find((p) => p.days === days)?.label ?? `${days} วัน`} · {positionName}
        </p>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-end gap-3">
        <div>
          <div className="text-[11px] text-slate-500 mb-1">ช่วงเวลา</div>
          <div className="flex gap-1">
            {PERIOD_OPTIONS.map((p) => (
              <Link key={p.days}
                href={{ pathname: "/admin/recruita/dashboard", query: {
                  ...(positionFilter ? { position: positionFilter } : {}),
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
        <div className="flex-1 min-w-[200px]">
          <div className="text-[11px] text-slate-500 mb-1">ตำแหน่ง</div>
          <div className="flex flex-wrap gap-1">
            <Link href={{ pathname: "/admin/recruita/dashboard", query: { days } }}
              className={`text-xs px-3 py-1.5 rounded border ${
                !positionFilter
                  ? "bg-brand text-white border-brand font-bold"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}>
              ทุกตำแหน่ง
            </Link>
            {positions.slice(0, 10).map((p) => (
              <Link key={p.id}
                href={{ pathname: "/admin/recruita/dashboard", query: { days, position: p.id } }}
                className={`text-xs px-3 py-1.5 rounded border truncate max-w-[200px] ${
                  positionFilter === p.id
                    ? "bg-brand text-white border-brand font-bold"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}>
                {p.code ?? p.title}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KPI label="ใบสมัครทั้งหมด" value={totalApps} icon="📩" />
        <KPI label="รับเข้าทำงาน" value={hiredCount}
          hint={totalApps > 0 ? pct(hiredCount, totalApps) : "0%"} tone="emerald" />
        <KPI label="เวลาเฉลี่ยจ้าง"
          value={Math.round(tthAvgDays * 10) / 10}
          hint={tthAvgDays > 0 ? "วัน (avg)" : "ยังไม่มีข้อมูล"}
          tone="sky" />
        <KPI label="เปิดรับ"
          value={positions.filter((p) => p.vacancies > 0).reduce((s, p) => s + p.vacancies, 0)}
          hint="อัตราทั้งหมด" tone="amber" />
      </div>

      {/* Funnel */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800 text-sm">🌀 Conversion Funnel</h2>
        {totalAtTop === 0 ? (
          <EmptyChart />
        ) : (
          <div className="space-y-1.5">
            {funnelData.map((step, i) => {
              const widthPct = totalAtTop > 0 ? (step.count / totalAtTop) * 100 : 0;
              const conversionFromPrev = i > 0 && funnelData[i - 1].count > 0
                ? (step.count / funnelData[i - 1].count) * 100
                : null;
              return (
                <div key={step.label}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="text-slate-700 font-semibold">{step.label}</span>
                    <span className="font-bold text-slate-800 tabular-nums">
                      {step.count}
                      {conversionFromPrev != null && (
                        <span className={`ml-2 font-normal ${
                          conversionFromPrev > 70 ? "text-emerald-600"
                            : conversionFromPrev > 40 ? "text-amber-600"
                            : "text-rose-600"
                        }`}>
                          ({conversionFromPrev.toFixed(0)}% ↓)
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="h-6 bg-slate-100 rounded overflow-hidden relative">
                    <div className="h-full transition-all"
                      style={{
                        width: `${widthPct}%`,
                        background: `linear-gradient(90deg, #3b82f6 0%, #${i >= funnelData.length - 1 ? "10b981" : "8b5cf6"} 100%)`
                      }} />
                    <span className="absolute inset-0 flex items-center px-2 text-[10px] font-bold text-white drop-shadow">
                      {pct(step.count, totalAtTop)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {totalAtTop > 0 && (
          <div className="bg-slate-50 rounded-lg p-2 text-xs text-slate-600 mt-2">
            🎯 <b>อัตราการแปลงรวม:</b> {pct(hiredCount, totalAtTop)} (
              จาก {totalAtTop} ใบสมัคร เหลือ {hiredCount} คนที่ได้งาน)
          </div>
        )}
      </div>

      {/* Stage + Source */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <ChartCard title="📊 Stage ปัจจุบันของใบสมัครทั้งหมด">
          {stageRows.length === 0
            ? <EmptyChart />
            : <DonutChart rows={stageRows.map((r) => ({
                label: stageLabelMap[r.label] ?? r.label,
                count: r.count
              }))} />}
        </ChartCard>
        <ChartCard title="📣 ที่มาของผู้สมัคร (Source Attribution)">
          {sourceRows.length === 0
            ? <EmptyChart />
            : <BarChart rows={sourceRows} color="#06b6d4" />}
        </ChartCard>
      </div>

      {/* Per-position fill rate */}
      <div className="card space-y-2">
        <h2 className="font-bold text-slate-800 text-sm">
          🎯 อัตราการเติมเต็มต่อตำแหน่ง (Fill Rate)
        </h2>
        {fillRows.length === 0 ? (
          <EmptyChart />
        ) : (
          <div className="space-y-2">
            {fillRows.map((r) => (
              <div key={r.id} className="text-xs">
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-slate-700 truncate flex-1">{r.label}</span>
                  <span className="text-slate-500 tabular-nums ml-2">
                    {r.hired} / {r.vacancies} ({r.fill_pct.toFixed(0)}%)
                  </span>
                </div>
                <div className="h-3 bg-slate-100 rounded overflow-hidden">
                  <div className={`h-full transition-all ${
                    r.fill_pct >= 100 ? "bg-emerald-500"
                      : r.fill_pct >= 50 ? "bg-amber-400"
                      : "bg-rose-400"
                  }`}
                    style={{ width: `${Math.min(100, r.fill_pct)}%` }} />
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5">
                  📩 ใบสมัคร {r.app_count} ใน {days} วัน
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Monthly applications */}
      <ChartCard title="📅 ใบสมัครเข้ามา · 12 เดือนล่าสุด">
        <MonthlyBars rows={monthlyApps} />
      </ChartCard>
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
        {typeof value === "number" && Number.isFinite(value)
          ? value.toLocaleString("th-TH")
          : "—"}
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
      ยังไม่มีข้อมูลในช่วงเวลานี้
    </div>
  );
}

function BarChart({
  rows, color
}: { rows: Array<{ label: string; count: number }>; color: string }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="space-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="text-xs">
          <div className="flex items-center justify-between mb-0.5">
            <span className="text-slate-600 truncate flex-1">{r.label}</span>
            <span className="font-bold text-slate-800 tabular-nums ml-2">{r.count}</span>
          </div>
          <div className="h-3 bg-slate-100 rounded overflow-hidden">
            <div className="h-full rounded transition-all"
              style={{ width: `${(r.count / max) * 100}%`, backgroundColor: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({
  rows, unit
}: { rows: Array<{ label: string; count: number }>; unit?: string }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0) return <EmptyChart />;
  const COLORS = ["#3b82f6", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#64748b", "#ec4899"];
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
          <circle key={i} cx={80} cy={80} r={r}
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
              {((row.count / total) * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlyBars({ rows }: { rows: Array<{ label: string; count: number }> }) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-1 min-w-full" style={{ minHeight: 140 }}>
        {rows.map((r) => {
          const month = r.label.slice(5, 7);
          const h = (r.count / max) * 120;
          return (
            <div key={r.label} className="flex-1 min-w-[36px] flex flex-col items-center justify-end gap-1">
              <div className="w-full bg-sky-500 rounded-t"
                style={{ height: `${h}px` }}
                title={`${r.label}: ${r.count} ใบสมัคร`} />
              <div className="text-[10px] text-slate-500">{Number(month)}</div>
              {r.count > 0 && (
                <div className="text-[9px] text-slate-400">{r.count}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
