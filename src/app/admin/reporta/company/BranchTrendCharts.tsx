import { fmtMoney } from "@/lib/format";
import { movingAverage, type BranchTrend, type TrendDay } from "@/lib/salesa-analytics";

// Daily sales and spend-per-head trend, one card per branch (owner 2026-11-07). Plain inline SVG (no chart library):
// this month's daily line, the 7-day moving average, and last month's line faint behind it for the same day of month.

const W = 560, H = 170, PAD = { l: 46, r: 10, t: 10, b: 22 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));

function TrendChart({ title, unit, days, prevDays, pick, daysInMonth, color, prevLabel }: {
  title: string; unit: string; days: TrendDay[]; prevDays: TrendDay[]; pick: (d: TrendDay) => number | null;
  daysInMonth: number; color: string; prevLabel: string;
}) {
  const byDay = (list: TrendDay[]) => Array.from({ length: daysInMonth }, (_, i) => { const d = list.find((x) => x.day === i + 1); return d ? pick(d) : null; });
  const cur = byDay(days), prev = byDay(prevDays), ma = movingAverage(cur, 7);
  const all = [...cur, ...prev].filter((v): v is number => v != null);
  if (all.length === 0) return <div className="text-xs text-slate-400 py-6 text-center">{title}: ยังไม่มีข้อมูล</div>;
  const top = niceMax(Math.max(...all));
  const x = (i: number) => PAD.l + (daysInMonth <= 1 ? 0 : (i / (daysInMonth - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  // Break the line where a day has no figure, so a closed day is a gap and not a slope to zero.
  const path = (vals: Array<number | null>) => {
    let out = "", pen = false;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } out += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; });
    return out.trim();
  };
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const xTicks = [1, 5, 10, 15, 20, 25, daysInMonth].filter((d, i, a) => d <= daysInMonth && a.indexOf(d) === i);
  const avg = all.length ? cur.filter((v): v is number => v != null) : [];
  const mean = avg.length ? avg.reduce((s, v) => s + v, 0) / avg.length : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="text-xs font-semibold text-slate-700">{title}</div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-3" style={{ background: color }} />เดือนนี้</span>
          <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-3 border-t border-dashed" style={{ borderColor: color }} />เฉลี่ย 7 วัน</span>
          <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-3 bg-slate-300" />{prevLabel}</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`${title} (${unit})`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" />
            <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{short(t)}</text>
          </g>
        ))}
        {xTicks.map((d) => <text key={d} x={x(d - 1)} y={H - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">{d}</text>)}
        {mean != null && <line x1={PAD.l} x2={W - PAD.r} y1={y(mean)} y2={y(mean)} stroke={color} strokeOpacity="0.25" strokeWidth="1" />}
        <path d={path(prev)} fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
        <path d={path(ma)} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.8" />
        <path d={path(cur)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {cur.map((v, i) => v == null ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={color}><title>{`วันที่ ${i + 1}: ${fmtMoney(v)} ${unit}`}</title></circle>
        ))}
      </svg>
    </div>
  );
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  return <span className={pct > 0 ? "text-emerald-600" : pct < 0 ? "text-rose-500" : "text-slate-400"}>{pct > 0 ? `▲ +${pct}` : pct < 0 ? `▼ ${pct}` : "± 0"}%</span>;
}

export default function BranchTrendCharts({ trends, year, month }: { trends: BranchTrend[]; year: number; month: number }) {
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-bold text-slate-800">แนวโน้มยอดต่อวัน และยอดต่อหัว · แยกสาขา</h2>
        <p className="text-[11px] text-slate-400">ยอดต่อหัว = ยอดขายสุทธิ ÷ จำนวนลูกค้าของวันนั้น · เส้นจางคือเดือนก่อนในวันที่เดียวกัน · วันที่ไม่มีข้อมูลเป็นช่องว่าง</p>
      </div>
      {trends.map((b) => (
        <div key={b.branchId} className="card space-y-3">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="font-bold text-slate-800">{b.branchName}</div>
            {b.days.length > 0 && (
              <div className="text-[11px] text-slate-500 tabular-nums flex gap-x-4 gap-y-0.5 flex-wrap">
                <span>เฉลี่ยต่อวัน <b className="text-slate-700">{b.avgPerDay != null ? fmtMoney(b.avgPerDay) : "—"}</b> <Delta pct={b.perDayMomPct} /></span>
                <span>เฉลี่ยต่อหัว <b className="text-slate-700">{b.avgPerHead != null ? fmtMoney(b.avgPerHead) : "—"}</b> <Delta pct={b.perHeadMomPct} /></span>
                <span className="text-slate-400">{b.days.length} วันที่มียอด</span>
              </div>
            )}
          </div>
          {b.days.length === 0 && b.prevDays.length === 0 ? (
            <div className="text-xs text-slate-400">ยังไม่มียอดขาย POS ของสาขานี้ในช่วงนี้ (สาขาคลินิกหรือยังไม่ได้นำเข้าไฟล์รายวัน)</div>
          ) : (
            <div className="grid lg:grid-cols-2 gap-4">
              <TrendChart title="ยอดขายต่อวัน" unit="บาท" days={b.days} prevDays={b.prevDays} pick={(d) => d.nett} daysInMonth={dim} color="#10b981" prevLabel="เดือนก่อน" />
              <TrendChart title="ยอดต่อหัว" unit="บาท/คน" days={b.days} prevDays={b.prevDays} pick={(d) => d.perHead} daysInMonth={dim} color="#6366f1" prevLabel="เดือนก่อน" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
