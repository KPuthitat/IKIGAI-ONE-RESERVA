"use client";

import { useState } from "react";
import { fmtMoney } from "@/lib/format";
import { movingAverage } from "@/lib/trend-math";
import type { BranchTrend, BranchYearTrend, TrendDay } from "@/lib/salesa-analytics";

// Sales-per-day and spend-per-head trends (owner 2026-11-07, whole year + branch filter 2026-11-08). Plain inline SVG (no
// chart library). "เดือนนี้" = daily lines with a 7-day moving average and last month faint behind; "ทั้งปี" = 12 monthly
// points with last year faint behind. A chip row picks all branches or a single one.

const W = 560, H = 170, PAD = { l: 46, r: 10, t: 10, b: 22 };
const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));

function LineChart({ title, unit, cur, prev, ma, xTicks, tip, color, curLabel, maLabel, prevLabel }: {
  title: string; unit: string; cur: Array<number | null>; prev: Array<number | null>; ma?: Array<number | null>;
  xTicks: Array<{ i: number; label: string }>; tip: (i: number) => string; color: string; curLabel: string; maLabel?: string; prevLabel: string;
}) {
  const n = cur.length;
  const all = [...cur, ...prev].filter((v): v is number => v != null);
  if (all.length === 0) return <div className="text-xs text-slate-400 py-6 text-center">{title}: ยังไม่มีข้อมูล</div>;
  const top = niceMax(Math.max(...all));
  const x = (i: number) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  // Break the line where a point has no figure, so a closed day is a gap and not a slope to zero.
  const path = (vals: Array<number | null>) => {
    let out = "", pen = false;
    vals.forEach((v, i) => { if (v == null) { pen = false; return; } out += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; });
    return out.trim();
  };
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const own = cur.filter((v): v is number => v != null);
  const mean = own.length ? own.reduce((s, v) => s + v, 0) / own.length : null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1 flex-wrap">
        <div className="text-xs font-semibold text-slate-700">{title}</div>
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-3" style={{ background: color }} />{curLabel}</span>
          {ma && <span className="inline-flex items-center gap-1"><i className="inline-block h-0.5 w-3 border-t border-dashed" style={{ borderColor: color }} />{maLabel}</span>}
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
        {xTicks.map((t) => <text key={t.i} x={x(t.i)} y={H - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">{t.label}</text>)}
        {mean != null && <line x1={PAD.l} x2={W - PAD.r} y1={y(mean)} y2={y(mean)} stroke={color} strokeOpacity="0.25" strokeWidth="1" />}
        <path d={path(prev)} fill="none" stroke="#cbd5e1" strokeWidth="1.5" />
        {ma && <path d={path(ma)} fill="none" stroke={color} strokeWidth="1.5" strokeDasharray="4 3" strokeOpacity="0.8" />}
        <path d={path(cur)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {cur.map((v, i) => v == null ? null : (
          <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={color}><title>{`${tip(i)}: ${fmtMoney(v)} ${unit}`}</title></circle>
        ))}
      </svg>
    </div>
  );
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  return <span className={pct > 0 ? "text-emerald-600" : pct < 0 ? "text-rose-500" : "text-slate-400"}>{pct > 0 ? `▲ +${pct}` : pct < 0 ? `▼ ${pct}` : "± 0"}%</span>;
}

type Mode = "month" | "year";

export default function BranchTrendCharts({ trends, yearTrends, year, month }: { trends: BranchTrend[]; yearTrends: BranchYearTrend[]; year: number; month: number }) {
  const [mode, setMode] = useState<Mode>("month");
  const [branch, setBranch] = useState<number | null>(null);   // null = all branches; 0 = combined (year mode only)
  const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const names = trends.map((t) => ({ id: t.branchId, name: t.branchName }));
  const pillCls = (on: boolean) => `rounded-full px-3 py-1 text-xs font-semibold border ${on ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`;

  const dayChart = (b: BranchTrend) => {
    const series = (list: TrendDay[], pick: (d: TrendDay) => number | null) => Array.from({ length: dim }, (_, i) => { const d = list.find((x) => x.day === i + 1); return d ? pick(d) : null; });
    const xt = [1, 5, 10, 15, 20, 25, dim].filter((d, i, a) => d <= dim && a.indexOf(d) === i).map((d) => ({ i: d - 1, label: String(d) }));
    const mk = (title: string, unit: string, pick: (d: TrendDay) => number | null, color: string) => {
      const cur = series(b.days, pick);
      return <LineChart title={title} unit={unit} cur={cur} prev={series(b.prevDays, pick)} ma={movingAverage(cur, 7)} xTicks={xt} tip={(i) => `วันที่ ${i + 1}`}
        color={color} curLabel="เดือนนี้" maLabel="เฉลี่ย 7 วัน" prevLabel="เดือนก่อน" />;
    };
    return <>{mk("ยอดขายต่อวัน", "บาท", (d) => d.nett, "#10b981")}{mk("ยอดต่อหัว", "บาท/คน", (d) => d.perHead, "#6366f1")}</>;
  };
  const yearChart = (b: BranchYearTrend) => {
    const xt = TH_MON.map((label, i) => ({ i, label }));
    const mk = (title: string, unit: string, pick: (m: BranchYearTrend["months"][number]) => number | null, color: string) => (
      <LineChart title={title} unit={unit} cur={b.months.map(pick)} prev={b.prevMonths.map(pick)} xTicks={xt} tip={(i) => `${TH_MON[i]} ${year + 543}`}
        color={color} curLabel={`ปี ${year + 543}`} prevLabel={`ปี ${year + 542}`} />
    );
    return <>{mk("ยอดขายเฉลี่ยต่อวัน (รายเดือน)", "บาท/วัน", (m) => m.avgPerDay, "#10b981")}{mk("ยอดต่อหัวเฉลี่ย (รายเดือน)", "บาท/คน", (m) => m.avgPerHead, "#6366f1")}</>;
  };

  const sel = branch ?? -1;
  const monthCards = trends.filter((b) => sel === -1 || b.branchId === sel);
  const yearCards = yearTrends.filter((b) => sel === -1 ? true : b.branchId === sel);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-bold text-slate-800">แนวโน้มยอดต่อวัน และยอดต่อหัว · แยกสาขา</h2>
          <p className="text-[11px] text-slate-400">ยอดต่อหัว = ยอดขายสุทธิ ÷ จำนวนลูกค้า · เส้นจางคือ{mode === "month" ? "เดือนก่อนในวันที่เดียวกัน" : "ปีก่อนในเดือนเดียวกัน"} · ช่วงที่ไม่มีข้อมูลเป็นช่องว่าง</p>
        </div>
        <div className="flex gap-1.5">
          <button type="button" className={pillCls(mode === "month")} onClick={() => { setMode("month"); if (branch === 0) setBranch(null); }}>เดือนนี้ (รายวัน)</button>
          <button type="button" className={pillCls(mode === "year")} onClick={() => setMode("year")}>ทั้งปี (รายเดือน)</button>
        </div>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <button type="button" className={pillCls(branch === null)} onClick={() => setBranch(null)}>ทุกสาขา</button>
        {mode === "year" && <button type="button" className={pillCls(branch === 0)} onClick={() => setBranch(0)}>รวมทุกสาขา</button>}
        {names.map((b) => <button key={b.id} type="button" className={pillCls(branch === b.id)} onClick={() => setBranch(b.id)}>{b.name}</button>)}
      </div>

      {mode === "month" ? monthCards.map((b) => (
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
          ) : <div className="grid lg:grid-cols-2 gap-4">{dayChart(b)}</div>}
        </div>
      )) : yearCards.map((b) => {
        const has = b.months.some((m) => m.salesDays > 0) || b.prevMonths.some((m) => m.salesDays > 0);
        return (
          <div key={b.branchId} className="card space-y-3">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <div className="font-bold text-slate-800">{b.branchName}{b.branchId === 0 && <span className="ml-2 text-[11px] font-normal text-slate-400">ยอดรวมของทุกสาขาในวันเดียวกัน</span>}</div>
              {has && (
                <div className="text-[11px] text-slate-500 tabular-nums flex gap-x-4 gap-y-0.5 flex-wrap">
                  <span>ทั้งปีเฉลี่ยต่อวัน <b className="text-slate-700">{b.avgPerDay != null ? fmtMoney(b.avgPerDay) : "—"}</b> <Delta pct={b.perDayYoyPct} /></span>
                  <span>เฉลี่ยต่อหัว <b className="text-slate-700">{b.avgPerHead != null ? fmtMoney(b.avgPerHead) : "—"}</b> <Delta pct={b.perHeadYoyPct} /></span>
                  <span className="text-slate-400">เทียบปีก่อน</span>
                </div>
              )}
            </div>
            {!has ? <div className="text-xs text-slate-400">ยังไม่มียอดขาย POS ของสาขานี้ในปีนี้หรือปีก่อน</div> : <div className="grid lg:grid-cols-2 gap-4">{yearChart(b)}</div>}
          </div>
        );
      })}
    </div>
  );
}
