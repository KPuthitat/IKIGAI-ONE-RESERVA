"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { fmtMoney } from "@/lib/format";

type LedgerPeriod = "week" | "month" | "year";

type CatItem = {
  code: string | null; name: string; spent: number;
  pct: number | null; targetMin: number | null; targetMax: number | null;
  status: "over" | "under" | "ok" | "na";
};
type Dash = {
  period: LedgerPeriod; start: string; end: string; label: string;
  revenue: number; expense: number; net: number;
  inputVat: number; outputVat: number; vatPayable: number; vatRegistered: boolean;
  daysWithRevenue: number; avgPerDay: number; avgWeekday: number; avgWeekend: number;
  forecast: number | null; categories: CatItem[]; uncategorized: number;
  dailyRows: Array<{ date: string; revenue: number; expense: number; net: number; balance: number }>;
  incomeByChannel: Array<{ channel: string; amount: number }>;
  incomeRows: Array<{ date: string; channel: string; amount: number; ar: number; cash: number }>;
  byVendor: Array<{ vendor: string; amount: number }>;
  byPaymentMethod: Array<{ method: string; amount: number }>;
  cashReceived: number;
  outstandingTotal: number;
  outstandingByEntity: Array<{ channel: string; amount: number; count: number }>;
};
type MonthlyRow = { month: number; revenue: number; expense: number; profit: number };
type Payables = { whtUnpaid: number; ssoUnpaid: number; branchUnpaidTotal: number; branchUnpaidCount: number };
type CashAccount = { id: number; name: string; type: string; bank_label: string | null; balance: number; balance_as_of: string | null; company_wide: boolean };
export type LedgerExpenseRow = {
  id: number; bill_date: string; vendor_name: string | null; doc_type: string | null;
  category: string | null; amount_total: number; vat_amount: number;
  payment_status: "paid" | "unpaid"; has_doc: boolean;
};

const PERIOD_LABEL: Record<LedgerPeriod, string> = { week: "สัปดาห์", month: "เดือน", year: "ปี" };

function shiftAnchor(anchor: string, period: LedgerPeriod, dir: 1 | -1): string {
  const [y, m, d] = anchor.split("-").map(Number);
  if (period === "year") return `${y + dir}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (period === "month") {
    const nd = new Date(Date.UTC(y, m - 1 + dir, 15));
    return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, "0")}-15`;
  }
  return new Date(Date.UTC(y, m - 1, d) + dir * 7 * 86400_000).toISOString().slice(0, 10);
}

const TH_DOW_FULL = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const TH_MON_FULL = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
// Full Thai date, e.g. "วันพุธที่ 27 พฤษภาคม 2569" (owner 2026-06-22 — no abbreviations).
function fmtDayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = TH_DOW_FULL[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `วัน${dow}ที่ ${d} ${TH_MON_FULL[m]} ${y + 543}`;
}

const CAT_STATUS = {
  over: { c: "text-rose-600", t: "เกินเป้า" },
  under: { c: "text-emerald-600", t: "ต่ำกว่าเป้า" },
  ok: { c: "text-slate-600", t: "อยู่ในเป้า" },
  na: { c: "text-slate-400", t: "—" }
} as const;

// Donut palette (income channels / expense categories). Stable order so the
// same slice keeps the same colour across renders.
const DONUT_COLORS = ["#10b981", "#3b82f6", "#6366f1", "#f59e0b", "#ec4899", "#14b8a6", "#a855f7", "#94a3b8"];

// Compact money label for the chart axis/bars: 232000 → "232k", 1.5e6 → "1.5M".
function fmtK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (a >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(Math.round(v));
}
// Round a value up to a clean 1/2/2.5/5/10 × 10ⁿ for tidy gridline labels.
function niceTop(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

// 12-month revenue/expense bars + value labels + thin profit line — pure SVG
// (no chart lib), "style C" (owner 2026-06-23). Y-axis gridlines + labels;
// value above each revenue bar; peach expense bars; muted profit line. Wide,
// short viewBox + aspect-ratio so it stays a tidy band, not a 700px wall.
function MonthlyCombo({ rows }: { rows: MonthlyRow[] }) {
  const W = 900, Lm = 40, H = 132, padTop = 16, padBottom = 4, labelBand = 24;
  const plotW = W - Lm;
  const maxV = Math.max(...rows.map((m) => m.revenue), ...rows.map((m) => m.expense), ...rows.map((m) => m.profit), 0);
  const minV = Math.min(...rows.map((m) => m.profit), 0);
  const top = niceTop(maxV);
  const bottom = minV < 0 ? -niceTop(-minV) : 0;
  const span = top - bottom || 1;
  const mapY = (v: number) => padTop + ((top - v) / span) * (H - padTop - padBottom);
  const zeroY = mapY(0);
  const colW = plotW / rows.length;
  const barW = Math.min(13, colW / 3.4);
  const N = 4;
  const ticks = Array.from({ length: N + 1 }, (_, i) => bottom + (span * i) / N);
  const linePts = rows.map((m, i) => `${(Lm + i * colW + colW / 2).toFixed(1)},${mapY(m.profit).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H + labelBand}`} preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="กราฟรายรับ รายจ่าย และกำไรรายเดือน"
      style={{ display: "block", width: "100%", height: "auto", aspectRatio: `${W} / ${H + labelBand}`, maxHeight: 260 }}>
      {/* Y gridlines + labels */}
      {ticks.map((t, i) => {
        const y = mapY(t);
        return (
          <g key={i}>
            <line x1={Lm} y1={y} x2={W} y2={y} stroke={t === 0 && bottom < 0 ? "#cbd5e1" : "#eef2f7"} strokeWidth={1} />
            <text x={Lm - 5} y={y + 3} textAnchor="end" fontSize={8} fill="#94a3b8">{fmtK(t)}</text>
          </g>
        );
      })}
      {/* Bars + value label on revenue */}
      {rows.map((m, i) => {
        const cx = Lm + i * colW + colW / 2;
        const rY = mapY(m.revenue), eY = mapY(m.expense);
        return (
          <g key={m.month}>
            <rect x={cx - barW - 1} y={Math.min(rY, zeroY)} width={barW} height={Math.abs(zeroY - rY)} rx={2} fill="#10b981">
              <title>{`${TH_MON_FULL[m.month]} รายรับ ฿${fmtMoney(m.revenue)}`}</title>
            </rect>
            <rect x={cx + 1} y={Math.min(eY, zeroY)} width={barW} height={Math.abs(zeroY - eY)} rx={2} fill="#f5c97a">
              <title>{`${TH_MON_FULL[m.month]} รายจ่าย ฿${fmtMoney(m.expense)}`}</title>
            </rect>
            {m.revenue > 0 && (
              <text x={cx - barW / 2 - 0.5} y={rY - 3} textAnchor="middle" fontSize={7.5} fontWeight={600} fill="#0F6E56">{fmtK(m.revenue)}</text>
            )}
            <text x={cx} y={H + 17} fontSize={11} fontWeight={600} fill="#475569" textAnchor="middle">{String(m.month).padStart(2, "0")}</text>
          </g>
        );
      })}
      {/* Thin profit line + dots */}
      <polyline points={linePts} fill="none" stroke="#6366f1" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {rows.map((m, i) => (
        <circle key={m.month} cx={Lm + i * colW + colW / 2} cy={mapY(m.profit)} r={2} fill="#6366f1">
          <title>{`${TH_MON_FULL[m.month]} กำไร ฿${fmtMoney(m.profit)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Donut chart — pure SVG. items already sorted desc; colour by index.
function Donut({ items }: { items: Array<{ label: string; amount: number }> }) {
  const size = 132, sw = 16, r = size / 2 - sw / 2, cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = items.reduce((s, d) => s + d.amount, 0);
  let offset = 0;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="shrink-0" role="img"
      aria-label="แผนภูมิวงกลมสัดส่วน">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#f1f5f9" strokeWidth={sw} />
      {total > 0 && items.map((d, i) => {
        const len = (d.amount / total) * circ;
        const seg = (
          <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={DONUT_COLORS[i % DONUT_COLORS.length]}
            strokeWidth={sw} strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}>
            <title>{`${d.label}: ฿${fmtMoney(d.amount)}`}</title>
          </circle>
        );
        offset += len;
        return seg;
      })}
    </svg>
  );
}

export default function LedgerDashboardClient({
  dash, expenses, period, anchor, monthly, trendYear, payables, cashAccounts, cashTotal
}: {
  dash: Dash; expenses: LedgerExpenseRow[]; period: LedgerPeriod; anchor: string;
  monthly: MonthlyRow[]; trendYear: number; payables: Payables;
  cashAccounts: CashAccount[]; cashTotal: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // SVG charts render client-only — their <title> tooltips otherwise produce
  // an SSR/hydration text-node mismatch with Thai labels. Cards/tables SSR fine.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => { setChartsReady(true); }, []);
  const dayExpenses = selectedDate ? expenses.filter((e) => e.bill_date === selectedDate) : [];
  const dayIncome = selectedDate ? dash.incomeRows.filter((r) => r.date === selectedDate) : [];

  function go(nextPeriod: LedgerPeriod, nextAnchor: string) {
    const q = new URLSearchParams({ period: nextPeriod, anchor: nextAnchor });
    startTransition(() => router.push(`/admin/accounta/daybook?${q.toString()}`));
  }

  async function remove(e: LedgerExpenseRow) {
    if (!window.confirm(`ลบรายจ่าย "${e.vendor_name ?? "รายการนี้"}" ฿${fmtMoney(e.amount_total)} ? กู้คืนไม่ได้`)) return;
    setBusyId(e.id);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${e.id}`), { method: "DELETE" });
      if (res.ok) startTransition(() => router.refresh());
    } finally { setBusyId(null); }
  }

  const margin = dash.revenue > 0 ? Math.round((dash.net / dash.revenue) * 100) : null;
  const payableTotal = payables.whtUnpaid + payables.ssoUnpaid + payables.branchUnpaidTotal;
  const payableCount = payables.branchUnpaidCount + (payables.whtUnpaid > 0 ? 1 : 0) + (payables.ssoUnpaid > 0 ? 1 : 0);
  const incomeTop = [...dash.incomeByChannel].slice(0, 8);
  const expenseTop = [...dash.categories].sort((a, b) => b.spent - a.spent).slice(0, 8)
    .map((c) => ({ label: c.code ? `${c.code} · ${c.name}` : c.name, amount: c.spent }));

  return (
    <div className="space-y-4">
      {/* Period selector + add buttons */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {(["week", "month", "year"] as LedgerPeriod[]).map((p) => (
            <button key={p} type="button" onClick={() => go(p, anchor)}
              className={`text-sm px-3 py-1.5 rounded-md border ${period === p
                ? "bg-brand text-white border-brand" : "border-slate-300 text-slate-600 hover:bg-slate-50"}`}>
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/accounta/income" className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700">+ เพิ่มรายรับ</Link>
          <Link href="/admin/accounta/expenses" className="rounded-md bg-rose-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-rose-700">+ เพิ่มรายจ่าย</Link>
        </div>
      </div>

      {/* Range nav — month shows a big number + small month/year (owner 2026-06-23) */}
      <div className="flex items-center justify-center gap-5">
        <button type="button" onClick={() => go(period, shiftAnchor(anchor, period, -1))}
          className="w-9 h-9 rounded-full border border-slate-300 text-slate-500 flex items-center justify-center hover:bg-brand hover:text-white hover:border-brand transition disabled:opacity-40" disabled={pending} aria-label="ก่อนหน้า">←</button>
        {period === "month" ? (
          <div className="text-center min-w-[7rem]">
            <div className="text-4xl font-bold text-slate-800 tracking-tight tabular-nums leading-none">{anchor.slice(5, 7)}</div>
            <div className="text-xs text-slate-500 leading-none mt-0.5">{TH_MON_FULL[Number(anchor.slice(5, 7))]} {Number(anchor.slice(0, 4)) + 543}</div>
          </div>
        ) : (
          <span className="text-sm font-bold text-slate-700">{dash.label}</span>
        )}
        <button type="button" onClick={() => go(period, shiftAnchor(anchor, period, 1))}
          className="w-9 h-9 rounded-full border border-slate-300 text-slate-500 flex items-center justify-center hover:bg-brand hover:text-white hover:border-brand transition disabled:opacity-40" disabled={pending} aria-label="ถัดไป">→</button>
      </div>

      {/* Hero metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">รายรับ</div>
          <div className="text-2xl font-bold text-emerald-600">฿{fmtMoney(dash.revenue)}</div>
          <div className="text-[11px] text-slate-400">เงินเข้าจริง ฿{fmtMoney(dash.cashReceived)}</div>
        </div>
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">รายจ่าย</div>
          <div className="text-2xl font-bold text-rose-600">฿{fmtMoney(dash.expense)}</div>
          <div className="text-[11px] text-slate-400">ภาษีซื้อ ฿{fmtMoney(dash.inputVat)}</div>
        </div>
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">กำไร / ขาดทุน</div>
          <div className={`text-2xl font-bold ${dash.net >= 0 ? "text-indigo-600" : "text-rose-600"}`}>
            {dash.net < 0 ? `(฿${fmtMoney(-dash.net)})` : `฿${fmtMoney(dash.net)}`}
          </div>
          <div className="text-[11px] text-slate-400">{margin != null ? `อัตรากำไร ${margin}%` : "—"}</div>
        </div>
      </div>

      {/* Insight cards — AR + payables (click through) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Link href="/admin/accounta/receivables" className="card flex items-center gap-3 py-3 hover:ring-1 hover:ring-amber-200 transition">
          <span className="w-1.5 h-10 rounded-full bg-amber-400 shrink-0" />
          <div className="flex-1">
            <div className="text-[11px] text-slate-400">ลูกหนี้ค้างชำระคงค้าง</div>
            <div className="text-lg font-bold text-amber-700">฿{fmtMoney(dash.outstandingTotal)}</div>
          </div>
          <span className="text-slate-300">›</span>
        </Link>
        <Link href="/admin/accounta/expenses" className="card flex items-center gap-3 py-3 hover:ring-1 hover:ring-rose-200 transition">
          <span className="w-1.5 h-10 rounded-full bg-rose-400 shrink-0" />
          <div className="flex-1">
            <div className="text-[11px] text-slate-400">บิล + ภาษีรอจ่าย</div>
            <div className="text-lg font-bold text-rose-700">฿{fmtMoney(payableTotal)} <span className="text-[11px] font-normal text-slate-400">· {payableCount} รายการ</span></div>
          </div>
          <span className="text-slate-300">›</span>
        </Link>
      </div>

      {/* 12-month overview chart */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">ภาพรวมรายรับและรายจ่าย · ปี {trendYear + 543}</div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />รายรับ</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#f5c97a" }} />รายจ่าย</span>
            <span className="flex items-center gap-1"><span className="w-3.5 h-[3px] rounded bg-indigo-500" />กำไร</span>
          </div>
        </div>
        {chartsReady ? <MonthlyCombo rows={monthly} /> : <div style={{ height: 136 }} />}
      </div>

      {/* Two donuts — income by channel + expense by category */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">รายรับแยกตามช่องทาง</div>
          {incomeTop.length === 0 ? (
            <p className="text-xs text-slate-400">ยังไม่มีข้อมูลรายรับในช่วงเวลานี้</p>
          ) : (
            <div className="flex items-center gap-4">
              {chartsReady ? <Donut items={incomeTop.map((c) => ({ label: c.channel, amount: c.amount }))} /> : <div style={{ width: 132, height: 132 }} className="shrink-0" />}
              <div className="flex-1 space-y-1 min-w-0">
                {incomeTop.map((c, i) => {
                  const pct = dash.revenue > 0 ? Math.round((c.amount / dash.revenue) * 100) : 0;
                  return (
                    <div key={c.channel} className="flex items-center gap-2 text-xs">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.channel}</span>
                      <span className="font-mono text-slate-800 shrink-0">฿{fmtMoney(c.amount)}</span>
                      <span className="font-mono text-slate-400 w-9 text-right shrink-0">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {dash.incomeByChannel.some((c) => c.channel === "(ไม่ระบุช่องทาง)") && (
            <p className="text-[11px] text-slate-400">หมายเหตุ: ยอดที่บันทึกก่อนเปิดใช้การแยกช่องทาง จะรวมอยู่ใน “(ไม่ระบุช่องทาง)”</p>
          )}
        </div>

        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">รายจ่ายแยกตามหมวด</div>
          {expenseTop.length === 0 ? (
            <p className="text-xs text-slate-400">ไม่พบรายการรายจ่ายในช่วงเวลานี้</p>
          ) : (
            <div className="flex items-center gap-4">
              {chartsReady ? <Donut items={expenseTop} /> : <div style={{ width: 132, height: 132 }} className="shrink-0" />}
              <div className="flex-1 space-y-1 min-w-0">
                {expenseTop.map((c, i) => {
                  const pct = dash.expense > 0 ? Math.round((c.amount / dash.expense) * 100) : 0;
                  return (
                    <div key={c.label} className="flex items-center gap-2 text-xs">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                      <span className="text-slate-600 truncate flex-1">{c.label}</span>
                      <span className="font-mono text-slate-800 shrink-0">฿{fmtMoney(c.amount)}</span>
                      <span className="font-mono text-slate-400 w-9 text-right shrink-0">{pct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Tax / payable cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">ภาษีขาย ภพ.30 (ช่วงนี้)</div>
          {dash.vatRegistered ? (
            <div className={`text-lg font-bold ${dash.vatPayable >= 0 ? "text-rose-600" : "text-emerald-600"}`}>
              {dash.vatPayable >= 0 ? `฿${fmtMoney(dash.vatPayable)}` : `เครดิต ฿${fmtMoney(-dash.vatPayable)}`}
            </div>
          ) : (
            <div className="text-sm font-bold text-slate-400">ไม่จด VAT</div>
          )}
          <div className="text-[10px] text-slate-400">ขาย ฿{fmtMoney(dash.outputVat)} − ซื้อ ฿{fmtMoney(dash.inputVat)}</div>
        </div>
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">ภาษีหัก ณ ที่จ่าย</div>
          <div className={`text-lg font-bold ${payables.whtUnpaid > 0 ? "text-amber-700" : "text-slate-400"}`}>฿{fmtMoney(payables.whtUnpaid)}</div>
          <div className="text-[10px] text-slate-400">รอนำส่ง</div>
        </div>
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">ประกันสังคม</div>
          <div className={`text-lg font-bold ${payables.ssoUnpaid > 0 ? "text-amber-700" : "text-slate-400"}`}>฿{fmtMoney(payables.ssoUnpaid)}</div>
          <div className="text-[10px] text-slate-400">รอนำส่ง</div>
        </div>
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">บิลค้างจ่ายของสาขา</div>
          <div className={`text-lg font-bold ${payables.branchUnpaidTotal > 0 ? "text-rose-600" : "text-slate-400"}`}>฿{fmtMoney(payables.branchUnpaidTotal)}</div>
          <div className="text-[10px] text-slate-400">{payables.branchUnpaidCount} รายการ</div>
        </div>
      </div>

      {/* Cash / bank balances (manual snapshots) */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">เงินสด / บัญชีธนาคาร · เงินคงเหลือ</div>
          <Link href="/admin/accounta/cash-accounts" className="text-xs text-brand hover:underline">จัดการบัญชี →</Link>
        </div>
        {cashAccounts.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่ได้ตั้งบัญชีเงินสด/ธนาคาร — <Link href="/admin/accounta/cash-accounts" className="text-brand hover:underline">เพิ่มบัญชีเพื่อเริ่มติดตามยอดเงิน</Link></p>
        ) : (
          <>
            <div className="space-y-1">
              {cashAccounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-slate-600 truncate">
                    {a.name}
                    <span className="text-[10px] text-slate-400 ml-1">{a.type === "bank" ? "ธนาคาร" : "เงินสด"}{a.company_wide ? " · ทั้งบริษัท" : ""}</span>
                    {a.balance_as_of && <span className="text-[10px] text-slate-300 ml-1">ณ {(() => { const [y, m, d] = a.balance_as_of!.split("-").map(Number); return `${d} ${TH_MON_FULL[m]} ${y + 543}`; })()}</span>}
                  </span>
                  <span className="font-mono text-slate-800 shrink-0">฿{fmtMoney(a.balance)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-slate-100 pt-1.5 flex items-center justify-between">
              <span className="text-sm font-bold text-slate-700">เงินคงเหลือรวม</span>
              <span className="font-mono font-bold text-slate-900">฿{fmtMoney(cashTotal)}</span>
            </div>
            <p className="text-[10px] text-slate-400">ยอดเป็นการบันทึกเอง (snapshot) ไม่ได้ผูกกับบิลอัตโนมัติ</p>
          </>
        )}
      </div>

      {/* Sales analytics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">ยอดขายเฉลี่ยต่อวัน</div>
          <div className="text-lg font-bold text-slate-800">฿{fmtMoney(dash.avgPerDay)}</div>
          <div className="text-[10px] text-slate-400">{dash.daysWithRevenue} วันที่มียอดขาย</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">เฉลี่ยวันธรรมดา</div>
          <div className="text-lg font-bold text-slate-800">฿{fmtMoney(dash.avgWeekday)}</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">เฉลี่ยวันหยุดสุดสัปดาห์</div>
          <div className="text-lg font-bold text-slate-800">฿{fmtMoney(dash.avgWeekend)}</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">ประมาณการยอดขายทั้งเดือน</div>
          <div className="text-lg font-bold text-brand">{dash.forecast != null ? `฿${fmtMoney(dash.forecast)}` : "—"}</div>
          {dash.forecast != null && <div className="text-[10px] text-slate-400">เฉลี่ย × จำนวนวันในเดือน</div>}
        </div>
      </div>

      {/* Outstanding by entity */}
      {dash.outstandingByEntity.length > 0 && (
        <div className="card space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-slate-800">ลูกหนี้ค้างชำระ แยกตามเจ้า</div>
            <Link href="/admin/accounta/receivables" className="text-xs text-brand hover:underline">จัดการ / รับชำระ →</Link>
          </div>
          <div className="space-y-1">
            {dash.outstandingByEntity.map((e) => (
              <div key={e.channel} className="flex justify-between text-sm">
                <span className="text-slate-700">{e.channel} <span className="text-[11px] text-slate-400">({e.count})</span></span>
                <span className="font-mono text-amber-700">฿{fmtMoney(e.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Excel-style daily comparison — revenue (shift-close) vs expense, running balance */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">สมุดรายวัน · เปรียบเทียบรายรับ–รายจ่ายรายวัน</div>
          <span className="text-[11px] text-slate-400">กดที่วันเพื่อดูเอกสารของวันนั้น</span>
        </div>
        {dash.dailyRows.length === 0 ? (
          <p className="text-xs text-slate-400">ไม่พบความเคลื่อนไหวในช่วงเวลานี้</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-200">
                  <th className="text-left py-1.5 px-2">วันที่</th>
                  <th className="text-right py-1.5 px-2">รายรับ</th>
                  <th className="text-right py-1.5 px-2">รายจ่าย</th>
                  <th className="text-right py-1.5 px-2">กำไร/ขาดทุนวันนี้</th>
                  <th className="text-right py-1.5 px-2">คงเหลือสะสม</th>
                </tr>
              </thead>
              <tbody>
                {dash.dailyRows.map((r) => (
                  <tr key={r.date}
                    onClick={() => setSelectedDate((d) => (d === r.date ? null : r.date))}
                    className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${selectedDate === r.date ? "bg-brand/5 ring-1 ring-brand/20" : ""}`}>
                    <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">
                      {selectedDate === r.date ? "▾ " : "▸ "}{fmtDayLabel(r.date)}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-emerald-600">{r.revenue > 0 ? fmtMoney(r.revenue) : "—"}</td>
                    <td className="py-1.5 px-2 text-right font-mono text-rose-600">{r.expense > 0 ? fmtMoney(r.expense) : "—"}</td>
                    <td className={`py-1.5 px-2 text-right font-mono ${r.net >= 0 ? "text-slate-700" : "text-rose-600"}`}>{r.net < 0 ? `(${fmtMoney(-r.net)})` : fmtMoney(r.net)}</td>
                    <td className={`py-1.5 px-2 text-right font-mono font-bold ${r.balance >= 0 ? "text-slate-700" : "text-rose-600"}`}>{fmtMoney(r.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-bold">
                  <td className="py-1.5 px-2 text-slate-700">รวมทั้งสิ้น</td>
                  <td className="py-1.5 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(dash.revenue)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-rose-700">฿{fmtMoney(dash.expense)}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${dash.net >= 0 ? "text-slate-800" : "text-rose-600"}`}>{dash.net < 0 ? `(฿${fmtMoney(-dash.net)})` : `฿${fmtMoney(dash.net)}`}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${dash.net >= 0 ? "text-slate-800" : "text-rose-600"}`}>฿{fmtMoney(dash.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Selected-day detail — Excel-style two-sided ledger (owner 2026-06-23):
          รายรับ (แยกช่องทาง, ค้างชำระ/AR vs เงินเข้าจริง) left · รายจ่าย right ·
          day totals + net at the bottom. */}
      {selectedDate && (() => {
        const incTotal = dayIncome.reduce((s, r) => s + r.amount, 0);
        const incAR = dayIncome.reduce((s, r) => s + r.ar, 0);
        const incCash = dayIncome.reduce((s, r) => s + r.cash, 0);
        const expTotal = dayExpenses.reduce((s, e) => s + e.amount_total, 0);
        const net = incTotal - expTotal;
        return (
        <div className="card space-y-3 ring-1 ring-brand/20">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-800">สมุดรายวัน · {fmtDayLabel(selectedDate)}</div>
            <button type="button" onClick={() => setSelectedDate(null)} className="text-xs text-slate-400 hover:text-slate-700">✕ ปิด</button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
            {/* รายรับ */}
            <div className="rounded-lg border border-emerald-100 overflow-hidden">
              <div className="bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-800">รายรับ (แยกช่องทาง)</div>
              {dayIncome.length === 0 ? (
                <p className="text-xs text-slate-400 px-3 py-2">ไม่มีรายรับในวันนี้</p>
              ) : (
                <table className="w-full text-sm tabular-nums">
                  <thead><tr className="text-[10px] text-slate-400 border-b border-slate-100">
                    <th className="text-left py-1 px-2">ช่องทาง</th>
                    <th className="text-right py-1 px-2">ค้างชำระ</th>
                    <th className="text-right py-1 px-2">เงินเข้าจริง</th>
                    <th className="text-right py-1 px-2">รวม</th>
                  </tr></thead>
                  <tbody>
                    {dayIncome.map((r) => (
                      <tr key={r.channel} className="border-b border-slate-50">
                        <td className="py-1 px-2 text-slate-600">{r.channel}</td>
                        <td className="py-1 px-2 text-right font-mono text-amber-700">{r.ar > 0 ? fmtMoney(r.ar) : "—"}</td>
                        <td className="py-1 px-2 text-right font-mono text-slate-600">{r.cash > 0 ? fmtMoney(r.cash) : "—"}</td>
                        <td className="py-1 px-2 text-right font-mono text-emerald-700">{fmtMoney(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="border-t border-slate-200 font-bold bg-slate-50">
                    <td className="py-1 px-2 text-slate-700">รวมรายรับ</td>
                    <td className="py-1 px-2 text-right font-mono text-amber-700">{incAR > 0 ? fmtMoney(incAR) : "—"}</td>
                    <td className="py-1 px-2 text-right font-mono text-slate-600">{fmtMoney(incCash)}</td>
                    <td className="py-1 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(incTotal)}</td>
                  </tr></tfoot>
                </table>
              )}
            </div>

            {/* รายจ่าย */}
            <div className="rounded-lg border border-rose-100 overflow-hidden">
              <div className="bg-rose-50 px-3 py-1.5 flex items-center justify-between">
                <span className="text-[11px] font-bold text-rose-800">รายจ่าย ({dayExpenses.length} รายการ)</span>
                <Link href="/admin/accounta/expenses" className="text-[10px] text-brand hover:underline">ไปหน้ารายจ่าย →</Link>
              </div>
              {dayExpenses.length === 0 ? (
                <p className="text-xs text-slate-400 px-3 py-2">ไม่มีรายจ่ายในวันนี้</p>
              ) : (
                <table className="w-full text-sm tabular-nums">
                  <tbody>
                    {dayExpenses.map((e) => (
                      <tr key={e.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="py-1 px-2">
                          <div className="text-slate-700">{e.vendor_name || "—"}</div>
                          <div className="text-[10px] text-slate-400">{e.category || "ไม่ระบุหมวด"}{e.payment_status === "unpaid" ? " · ค้างชำระ" : ""}{e.vat_amount > 0 ? ` · VAT ฿${fmtMoney(e.vat_amount)}` : ""}</div>
                        </td>
                        <td className="py-1 px-2 text-right font-mono text-rose-700">{fmtMoney(e.amount_total)}</td>
                        <td className="py-1 px-2 text-right whitespace-nowrap">
                          <Link href={`/admin/accounta/expenses?edit=${e.id}`} className="text-[10px] text-brand hover:underline mr-2">แก้</Link>
                          <button type="button" onClick={() => remove(e)} disabled={busyId === e.id} className="text-[10px] text-rose-500 hover:underline disabled:opacity-50">ลบ</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr className="border-t border-slate-200 font-bold bg-slate-50">
                    <td className="py-1 px-2 text-slate-700">รวมรายจ่าย</td>
                    <td className="py-1 px-2 text-right font-mono text-rose-700">฿{fmtMoney(expTotal)}</td>
                    <td />
                  </tr></tfoot>
                </table>
              )}
            </div>
          </div>

          {/* Day totals */}
          <div className="grid grid-cols-3 gap-3 pt-1">
            <div className="text-center"><div className="text-[10px] text-slate-400">รายรับรวม</div><div className="font-mono font-bold text-emerald-700">฿{fmtMoney(incTotal)}</div></div>
            <div className="text-center"><div className="text-[10px] text-slate-400">รายจ่ายรวม</div><div className="font-mono font-bold text-rose-700">฿{fmtMoney(expTotal)}</div></div>
            <div className="text-center"><div className="text-[10px] text-slate-400">กำไร/ขาดทุนวันนี้</div><div className={`font-mono font-bold ${net >= 0 ? "text-slate-800" : "text-rose-600"}`}>{net < 0 ? `(฿${fmtMoney(-net)})` : `฿${fmtMoney(net)}`}</div></div>
          </div>
        </div>
        );
      })()}

      {/* VAT detail (full) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ภาษีมูลค่าเพิ่ม (ยอดสะสมในช่วงเวลานี้)</div>
        {dash.vatRegistered ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
            <div><div className="text-[11px] text-slate-400">ภาษีขาย</div><div className="text-lg font-bold text-slate-700">฿{fmtMoney(dash.outputVat)}</div></div>
            <div><div className="text-[11px] text-slate-400">ภาษีซื้อ</div><div className="text-lg font-bold text-slate-700">฿{fmtMoney(dash.inputVat)}</div></div>
            <div>
              <div className="text-[11px] text-slate-400">ภพ.30 (ขาย − ซื้อ)</div>
              <div className={`text-lg font-bold ${dash.vatPayable >= 0 ? "text-rose-600" : "text-emerald-600"}`}>
                {dash.vatPayable >= 0 ? `ต้องชำระ ฿${fmtMoney(dash.vatPayable)}` : `เครดิตยกไป ฿${fmtMoney(-dash.vatPayable)}`}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            บริษัทนี้ยังไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม — แสดงเฉพาะ <b>ภาษีซื้อสะสม ฿{fmtMoney(dash.inputVat)}</b> (ไม่มีภาษีขายและ ภพ.30)
            <div className="text-[11px] text-slate-400 mt-0.5">หากสาขานี้ออกใบกำกับภาษีขาย สามารถเปิดสถานะ “จดทะเบียนภาษีมูลค่าเพิ่ม” ได้ที่เมนูบริษัทในเครือ</div>
          </div>
        )}
      </div>

      {/* Category vs target (detail table) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">รายจ่ายจำแนกตามหมวด · สัดส่วน % เทียบยอดขาย</div>
        {dash.categories.length === 0 ? (
          <p className="text-xs text-slate-400">ไม่พบรายการรายจ่ายในช่วงเวลานี้</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-slate-400 border-b border-slate-100">
                  <th className="text-left py-1.5 px-2">หมวด</th>
                  <th className="text-right py-1.5 px-2">ยอด</th>
                  <th className="text-right py-1.5 px-2">% ของยอดขาย</th>
                  <th className="text-right py-1.5 px-2">เป้า</th>
                  <th className="text-right py-1.5 px-2">สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {dash.categories.map((c) => (
                  <tr key={c.name} className="border-b border-slate-50">
                    <td className="py-1.5 px-2 text-slate-700">{c.code ? `${c.code} · ${c.name}` : c.name}</td>
                    <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(c.spent)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{c.pct != null ? `${c.pct.toFixed(1)}%` : "—"}</td>
                    <td className="py-1.5 px-2 text-right text-[11px] text-slate-400">
                      {c.targetMin != null || c.targetMax != null ? `${c.targetMin ?? 0}–${c.targetMax ?? "∞"}%` : "—"}
                    </td>
                    <td className={`py-1.5 px-2 text-right text-[11px] font-bold ${CAT_STATUS[c.status].c}`}>{CAT_STATUS[c.status].t}</td>
                  </tr>
                ))}
                {dash.uncategorized > 0 && (
                  <tr className="border-b border-slate-50 text-slate-400 italic">
                    <td className="py-1.5 px-2">(ไม่ระบุหมวด)</td>
                    <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(dash.uncategorized)}</td>
                    <td colSpan={3} />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Expense analysis — by vendor and by payment method */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">รายจ่ายแยกตามผู้จำหน่าย</div>
          {dash.byVendor.length === 0 ? (
            <p className="text-xs text-slate-400">ไม่พบรายการรายจ่ายในช่วงเวลานี้</p>
          ) : (
            <div className="space-y-1">
              {dash.byVendor.slice(0, 12).map((v) => (
                <div key={v.vendor} className="flex justify-between text-sm">
                  <span className="text-slate-600 truncate pr-2">{v.vendor}</span>
                  <span className="font-mono text-slate-800 shrink-0">฿{fmtMoney(v.amount)}</span>
                </div>
              ))}
              {dash.byVendor.length > 12 && <p className="text-[11px] text-slate-400">และอีก {dash.byVendor.length - 12} ราย</p>}
            </div>
          )}
        </div>
        <div className="card space-y-2">
          <div className="text-sm font-bold text-slate-800">รายจ่ายแยกตามวิธีจ่าย</div>
          {dash.byPaymentMethod.length === 0 ? (
            <p className="text-xs text-slate-400">ไม่พบรายการรายจ่ายในช่วงเวลานี้</p>
          ) : (
            <div className="space-y-1.5">
              {dash.byPaymentMethod.map((m) => {
                const pct = dash.expense > 0 ? (m.amount / dash.expense) * 100 : 0;
                return (
                  <div key={m.method} className="flex items-center gap-2 text-sm">
                    <span className="text-slate-600 w-32 sm:w-40 shrink-0 truncate">{m.method}</span>
                    <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-rose-300" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                    <span className="font-mono text-slate-800 w-24 text-right shrink-0">฿{fmtMoney(m.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
