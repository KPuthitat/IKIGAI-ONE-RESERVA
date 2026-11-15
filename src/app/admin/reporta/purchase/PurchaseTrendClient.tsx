"use client";

import { useState } from "react";
import Link from "next/link";
import { fmtMoney } from "@/lib/format";
import { ratioPct, type PurchaseTrend, type VendorShift } from "@/lib/purchase-trend";

// Purchase ÷ sales per supplier (owner 2026-11-15). Inline SVG, no chart library: the top chart is the ratio over time for the
// chosen supplier (with its own average dashed), the bars underneath are sales and what was bought, so a rising ratio can be
// told apart from "sales fell" and "bought more".

const W = 640, H = 190, PAD = { l: 46, r: 12, t: 12, b: 26 };
const UNIT: Record<string, string> = { day: "วัน", week: "สัปดาห์", month: "เดือน" };
const FLAG: Record<VendorShift["flag"], { text: string; cls: string }> = {
  up_while_sales_down: { text: "ซื้อมากขึ้น ขณะยอดขายลด", cls: "bg-rose-100 text-rose-700" },
  ratio_up: { text: "สัดส่วนซื้อสูงขึ้น", cls: "bg-amber-100 text-amber-800" },
  ratio_down: { text: "สัดส่วนซื้อลดลง", cls: "bg-sky-100 text-sky-700" },
  steady: { text: "ใกล้เคียงเดิม", cls: "bg-slate-100 text-slate-600" },
  no_data: { text: "ข้อมูลยังไม่พอเทียบ", cls: "bg-slate-100 text-slate-400" }
};

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const pct = (v: number | null, d = 1) => (v == null ? "—" : `${v.toFixed(d)}%`);
const signed = (v: number | null, suffix: string) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}${suffix}`);

function RatioChart({ labels, ratios }: { labels: string[]; ratios: Array<number | null> }) {
  const n = labels.length;
  const vals = ratios.filter((v): v is number => v != null);
  if (vals.length === 0) return <div className="text-xs text-slate-400 py-8 text-center">ยังไม่มีข้อมูลเทียบ (ต้องมีทั้งยอดขายและการซื้อ)</div>;
  const top = niceMax(Math.max(...vals));
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  let path = "", pen = false;
  ratios.forEach((v, i) => { if (v == null) { pen = false; return; } path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true; });
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const step = Math.max(1, Math.ceil(n / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="สัดส่วนซื้อต่อยอดขาย">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(f * top)} y2={y(f * top)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={PAD.l - 6} y={y(f * top) + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{(f * top).toFixed(top < 10 ? 1 : 0)}%</text>
        </g>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={y(mean)} y2={y(mean)} stroke="#a06820" strokeDasharray="4 3" strokeWidth="1" />
      <text x={W - PAD.r} y={y(mean) - 4} textAnchor="end" fontSize="10" fill="#a06820">ค่าเฉลี่ย {mean.toFixed(1)}%</text>
      <path d={path.trim()} fill="none" stroke="#a06820" strokeWidth="2" />
      {ratios.map((v, i) => v == null ? null : (
        <circle key={i} cx={x(i)} cy={y(v)} r="3" fill="#a06820"><title>{`${labels[i]} · ${v.toFixed(2)}%`}</title></circle>
      ))}
      {labels.map((l, i) => (i % step === 0 || i === n - 1) ? <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#94a3b8">{l}</text> : null)}
    </svg>
  );
}

function Bars({ labels, series, colors, names }: { labels: string[]; series: number[][]; colors: string[]; names: string[] }) {
  const n = labels.length;
  const top = niceMax(Math.max(1, ...series.flat()));
  const bh = 150, gw = (W - PAD.l - PAD.r) / Math.max(1, n), bw = Math.max(2, Math.min(22, gw / (series.length + 0.6)));
  const step = Math.max(1, Math.ceil(n / 8));
  return (
    <div>
      <div className="flex items-center gap-3 text-[11px] text-slate-500 mb-1">
        {names.map((nm, k) => <span key={nm} className="inline-flex items-center gap-1"><i className="inline-block h-2 w-3 rounded-sm" style={{ background: colors[k] }} />{nm}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${bh + 30}`} className="w-full" role="img" aria-label="ยอดขายและยอดซื้อ">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD.l} x2={W - PAD.r} y1={8 + (1 - f) * bh} y2={8 + (1 - f) * bh} stroke="#e2e8f0" strokeWidth="1" />
            <text x={PAD.l - 6} y={8 + (1 - f) * bh + 3} textAnchor="end" fontSize="10" fill="#94a3b8">{short(f * top)}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          const cx = PAD.l + gw * i + gw / 2;
          return (
            <g key={i}>
              {series.map((s, k) => {
                const h = (s[i] / top) * bh;
                return <rect key={k} x={cx - (series.length * bw) / 2 + k * bw} y={8 + bh - h} width={bw - 1} height={Math.max(0, h)} rx="1" fill={colors[k]}><title>{`${l} · ${names[k]} ${fmtMoney(s[i])}`}</title></rect>;
              })}
              {(i % step === 0 || i === n - 1) && <text x={cx} y={bh + 24} textAnchor="middle" fontSize="10" fill="#94a3b8">{l}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export default function PurchaseTrendClient({ trend, shifts, windowSize }: { trend: PurchaseTrend; shifts: VendorShift[]; windowSize: number }) {
  const [sel, setSel] = useState<string>(trend.vendors[0]?.name ?? "รวมทุกผู้ขาย");
  const unit = UNIT[trend.bucket];
  const amounts = sel === "รวมทุกผู้ขาย" ? trend.total : trend.vendors.find((v) => v.name === sel)?.amounts ?? trend.total;
  const ratios = trend.keys.map((_, i) => (trend.sales[i] > 0 && amounts[i] > 0 ? ratioPct(amounts[i], trend.sales[i]) : trend.sales[i] > 0 ? 0 : null));
  const chip = (href: string, label: string, active: boolean) => (
    <Link key={label} href={href} className={`chip ${active ? "chip-active" : ""}`}>{label}</Link>
  );
  const row = shifts.find((s) => s.name === sel);

  if (trend.vendors.length === 0) {
    return <div className="card text-sm text-slate-500">ยังไม่มีบิลซื้อที่ระบุผู้ขายในช่วงนี้ — บันทึกรายจ่ายใน ACCOUNTA พร้อมชื่อผู้ขายก่อน แล้วเปิดหน้านี้อีกครั้ง</div>;
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-slate-500">ดูเป็น</span>
        {chip("?b=day", "รายวัน (30 วัน)", trend.bucket === "day")}
        {chip("?b=week", "รายสัปดาห์ (16 สัปดาห์)", trend.bucket === "week")}
        {chip("?b=month", "รายเดือน (12 เดือน)", trend.bucket === "month")}
      </div>

      <div className="card overflow-x-auto">
        <div className="text-sm font-semibold text-slate-800">สัดส่วนที่เปลี่ยนไป · {windowSize} {unit}ล่าสุด เทียบ {windowSize} {unit}ก่อนหน้า</div>
        <p className="text-xs text-slate-500 mt-0.5">สัดส่วน = ยอดซื้อ ÷ ยอดขายในช่วงเดียวกัน · ตัวอย่าง: ขาย 30,000 ซื้อ 2,000 = 6.7% → ขาย 20,000 ซื้อ 4,000 = 20%</p>
        <table className="w-full text-sm mt-3 min-w-[720px]">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="py-2 pr-3">ผู้ขาย</th>
              <th className="py-2 pr-3 text-right">ก่อนหน้า<br />ขาย / ซื้อ</th>
              <th className="py-2 pr-3 text-right">สัดส่วน</th>
              <th className="py-2 pr-3 text-right">ล่าสุด<br />ขาย / ซื้อ</th>
              <th className="py-2 pr-3 text-right">สัดส่วน</th>
              <th className="py-2 pr-3 text-right">เปลี่ยน</th>
              <th className="py-2">สรุป</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => (
              <tr key={s.name} onClick={() => setSel(s.name)} className={`border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 ${sel === s.name ? "bg-amber-50" : ""}`}>
                <td className="py-2 pr-3 font-medium text-slate-800">{s.name}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-xs text-slate-600">{short(s.previous.sales)} / {short(s.previous.purchase)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{pct(s.previous.ratio)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-xs text-slate-600">{short(s.recent.sales)} / {short(s.recent.purchase)}</td>
                <td className="py-2 pr-3 text-right tabular-nums font-semibold">{pct(s.recent.ratio)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-xs">
                  <div>{signed(s.ratioDeltaPct, " จุด")}</div>
                  <div className="text-slate-400">ซื้อ {signed(s.purchaseChangePct, "%")} · ขาย {signed(s.salesChangePct, "%")}</div>
                </td>
                <td className="py-2"><span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${FLAG[s.flag].cls}`}>{FLAG[s.flag].text}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] text-slate-400 mt-2">กดแถวเพื่อดูกราฟของผู้ขายนั้นด้านล่าง · ใช้บิลที่ยืนยันแล้วใน ACCOUNTA (ยอดรวมภาษี) เทียบกับยอดขายสุทธิจาก POS เฉพาะวันที่นำเข้าแล้ว</p>
      </div>

      <div className="card space-y-4">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="text-sm font-semibold text-slate-800">{sel}</div>
          {row && row.recent.ratio != null && <div className="text-xs text-slate-500">ล่าสุด {pct(row.recent.ratio)} ของยอดขาย{row.previous.ratio != null ? ` (ก่อนหน้า ${pct(row.previous.ratio)})` : ""}</div>}
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">สัดส่วนซื้อ ÷ ยอดขาย ราย{unit}</div>
          <RatioChart labels={trend.labels} ratios={ratios} />
        </div>
        <Bars labels={trend.labels} series={[trend.sales, amounts]} colors={["#cbd5e1", "#a06820"]} names={["ยอดขาย", `ซื้อจาก ${sel}`]} />
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer text-slate-500">ดูเป็นตัวเลข</summary>
          <table className="w-full mt-2">
            <thead><tr className="text-left text-slate-500 border-b border-slate-200"><th className="py-1">{unit}</th><th className="py-1 text-right">ยอดขาย</th><th className="py-1 text-right">ซื้อ</th><th className="py-1 text-right">สัดส่วน</th></tr></thead>
            <tbody>
              {[...trend.keys.keys()].reverse().map((i) => (
                <tr key={trend.keys[i]} className="border-b border-slate-100">
                  <td className="py-1">{trend.labels[i]}</td>
                  <td className="py-1 text-right tabular-nums">{fmtMoney(trend.sales[i])}</td>
                  <td className="py-1 text-right tabular-nums">{fmtMoney(amounts[i])}</td>
                  <td className="py-1 text-right tabular-nums">{ratios[i] == null ? "—" : `${ratios[i]!.toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}
