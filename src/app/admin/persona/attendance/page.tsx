import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { personaAttendanceDashboard } from "@/lib/persona-attendance-dashboard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "PERSONA · ภาพรวม ขาด/ลา/มาสาย" };

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
function monthLabel(m: string): string { const [y, mo] = m.split("-").map(Number); return `${TH_MONTHS[mo]} ${y + 543}`; }
function shortMonth(m: string): string { const [y, mo] = m.split("-").map(Number); return `${TH_MONTHS[mo].slice(0, 3)} ${String(y + 543).slice(2)}`; }
function shiftMonth(m: string, dir: number): string {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + dir, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const fmt = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 1 });

export default function PersonaAttendancePage({ searchParams }: { searchParams: { month?: string } }) {
  const user = requireAdmin();
  const month = /^\d{4}-\d{2}$/.test(searchParams.month ?? "")
    ? searchParams.month! : new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
  const branchIds = user.adminBranchIds;
  const d = personaAttendanceDashboard(branchIds, month);

  // 6-month trend chart geometry.
  const W = 560, H = 200, PAD = 28;
  const maxY = Math.max(1, ...d.trend.flatMap((t) => [t.late, t.leaveDays, t.absent]));
  const xAt = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, d.trend.length - 1);
  const yAt = (v: number) => H - PAD - (v / maxY) * (H - 2 * PAD);
  const line = (key: "late" | "leaveDays" | "absent") =>
    d.trend.map((t, i) => `${xAt(i)},${yAt(t[key])}`).join(" ");
  const series: Array<{ key: "absent" | "leaveDays" | "late"; color: string; label: string }> = [
    { key: "absent", color: "#2563eb", label: "ขาดงาน" },
    { key: "leaveDays", color: "#16a34a", label: "ลางาน (วัน)" },
    { key: "late", color: "#f59e0b", label: "มาสาย" }
  ];
  const maxBucket = Math.max(1, ...d.lateByBucket.map((b) => b.count));
  const maxLeave = Math.max(1, ...d.leaveByType.map((l) => l.count));
  const maxLate = Math.max(1, ...d.topLate.map((t) => t.late));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">ภาพรวม การขาด ลา มาสาย</h1>
          <p className="text-sm text-slate-500">ข้อมูลพนักงานประจำเดือน · จากข้อมูลลงเวลา/ลา/ตารางเวรจริง</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/admin/persona/attendance?month=${shiftMonth(month, -1)}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-50">←</Link>
          <span className="text-sm font-bold text-slate-700 w-32 text-center">{monthLabel(month)}</span>
          <Link href={`/admin/persona/attendance?month=${shiftMonth(month, 1)}`} className="rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-50">→</Link>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card label="ขาดงาน (ครั้ง)" value={fmt(d.totals.absent)} color="text-blue-600" />
        <Card label="ลางาน (วัน)" value={fmt(d.totals.leaveDays)} color="text-emerald-600" />
        <Card label="มาสาย (ครั้ง)" value={fmt(d.totals.late)} color="text-amber-600" />
        <Card label="พนักงานทั้งหมด (คน)" value={fmt(d.staffCount)} color="text-violet-600" />
        <Card label="อัตราขาด/ลา/มาสาย" value={`${fmt(d.rate)}%`} color="text-slate-800" />
      </div>

      {/* 6-month trend */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">แนวโน้มการขาด ลา มาสาย ย้อนหลัง 6 เดือน</div>
        <div className="flex gap-4 text-[11px]">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: s.color }} />{s.label}</span>
          ))}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 220 }}>
          {[0, 0.5, 1].map((f) => (
            <line key={f} x1={PAD} x2={W - PAD} y1={yAt(maxY * f)} y2={yAt(maxY * f)} stroke="#e2e8f0" strokeWidth="1" />
          ))}
          {series.map((s) => (
            <g key={s.key}>
              <polyline points={line(s.key)} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" />
              {d.trend.map((t, i) => <circle key={i} cx={xAt(i)} cy={yAt(t[s.key])} r="3" fill={s.color} />)}
            </g>
          ))}
          {d.trend.map((t, i) => (
            <text key={i} x={xAt(i)} y={H - 8} fontSize="9" fill="#94a3b8" textAnchor="middle">{shortMonth(t.month)}</text>
          ))}
        </svg>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Late by time bucket */}
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">มาสายแยกตามช่วงเวลา (ลงเวลาเข้า)</div>
          <div className="space-y-1.5">
            {d.lateByBucket.map((b) => (
              <div key={b.label} className="flex items-center gap-2 text-sm">
                <span className="w-28 shrink-0 text-slate-600 text-xs">{b.label}</span>
                <div className="flex-1 h-3 rounded bg-slate-100 overflow-hidden">
                  <div className="h-full bg-violet-400" style={{ width: `${(b.count / maxBucket) * 100}%` }} />
                </div>
                <span className="w-10 text-right font-mono text-slate-700">{b.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Leave by type */}
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">ประเภทการลา (ครั้ง)</div>
          {d.leaveByType.length === 0 ? (
            <p className="text-xs text-slate-400">ไม่มีการลาในเดือนนี้</p>
          ) : (
            <div className="space-y-1.5">
              {d.leaveByType.map((l) => (
                <div key={l.type} className="flex items-center gap-2 text-sm">
                  <span className="w-28 shrink-0 text-slate-600 text-xs">{l.label}</span>
                  <div className="flex-1 h-3 rounded bg-slate-100 overflow-hidden">
                    <div className="h-full bg-emerald-400" style={{ width: `${(l.count / maxLeave) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right font-mono text-slate-700">{l.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* By branch */}
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">สถิติแยกตามสาขา</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-100">
                  <th className="text-left py-1.5 px-2">สาขา</th>
                  <th className="text-right py-1.5 px-2">ขาด</th>
                  <th className="text-right py-1.5 px-2">ลา(วัน)</th>
                  <th className="text-right py-1.5 px-2">สาย</th>
                  <th className="text-right py-1.5 px-2">อัตรา</th>
                </tr>
              </thead>
              <tbody>
                {d.byBranch.map((b) => (
                  <tr key={b.branch} className="border-b border-slate-50">
                    <td className="py-1.5 px-2 text-slate-700">{b.branch}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-blue-600">{b.absent}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-emerald-600">{fmt(b.leaveDays)}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-amber-600">{b.late}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-700">{fmt(b.rate)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top-5 late */}
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">พนักงานมาสายสูงสุด 5 อันดับ</div>
          {d.topLate.length === 0 ? (
            <p className="text-xs text-slate-400">ไม่มีพนักงานมาสายในเดือนนี้</p>
          ) : (
            <div className="space-y-1.5">
              {d.topLate.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="w-5 text-slate-400 font-bold">{i + 1}</span>
                  <span className="flex-1 min-w-0 truncate text-slate-700">{t.name} <span className="text-[11px] text-slate-400">· {t.branch}</span></span>
                  <div className="w-24 h-3 rounded bg-slate-100 overflow-hidden">
                    <div className="h-full bg-amber-400" style={{ width: `${(t.late / maxLate) * 100}%` }} />
                  </div>
                  <span className="w-10 text-right font-mono text-amber-700">{t.late}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="text-[11px] text-slate-400">
        อัตราขาด/ลา/มาสาย = (ขาด + วันลา + มาสาย) ÷ วันตามตารางเวรทั้งหมด × 100 · นับเฉพาะพนักงานสถานะใช้งาน
      </p>
    </div>
  );
}

function Card({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="card text-center py-3">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
    </div>
  );
}
