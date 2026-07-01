"use client";

import { Fragment, useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiUrl } from "@/lib/url";
import { fmtMoney, grpMoney, parseMoney } from "@/lib/format";
import PinPromptModal from "@/app/components/PinPromptModal";
import Combobox, { type ComboOption } from "@/app/components/Combobox";
import ExpenseEditModal from "./ExpenseEditModal";
import IncomeEditModal from "./IncomeEditModal";
import { STARTUP_CATEGORY_LABEL } from "@/lib/feasibility";
import Select from "@/app/components/Select";
import { useConfirm } from "@/app/components/useConfirm";

// grpMoney / parseMoney now shared from @/lib/format (separators in every money input).

type LedgerPeriod = "week" | "month" | "year";

type CatItem = {
  code: string | null; name: string; spent: number;
  pct: number | null; targetMin: number | null; targetMax: number | null;
  status: "over" | "under" | "ok" | "na";
};
type Dash = {
  period: LedgerPeriod; start: string; end: string; label: string;
  revenue: number; salesRevenue: number; financing: number; expense: number; net: number;
  inputVat: number; outputVat: number; vatPayable: number; vatRegistered: boolean;
  daysWithRevenue: number; avgPerDay: number; avgWeekday: number; avgWeekend: number;
  salesPerBillMonth: number | null; salesPerBillYear: number | null;
  forecast: number | null; categories: CatItem[]; uncategorized: number;
  dailyRows: Array<{ date: string; revenue: number; financing: number; expense: number; net: number; balance: number; billCount: number | null }>;
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
  payment_status: "paid" | "unpaid"; has_doc: boolean; due_date: string | null;
  // extra fields so the in-page edit modal has the full row (owner 2026-06-29)
  capex_bucket: string | null; description: string | null; has_tax_invoice: boolean;
  payment_method: string | null; paid_date: string | null;
  branch_id: number | null; company_id: number | null;
};
// Raw income row (matches /api/accounta/income) — id + source let the inline
// daybook detail edit manual rows while leaving shift-close rows read-only.
type IncomeDayRow = {
  id: number; branch_id: number | null; company_id: number | null;
  income_date: string; channel: string | null; amount: number; note: string | null;
  source: string; is_outstanding: number; settled_date: string | null;
  is_vat?: number; is_revenue?: number;
};
// Pending scanned-bill draft the รายจ่าย panel can pull in (owner 2026-06-25).
type DraftLite = {
  id: number; vendor_name: string | null; category: string | null;
  amount_total: number; has_tax_invoice: boolean; payment_status: "paid" | "unpaid";
  has_doc: boolean; doc_mime: string | null; bill_date: string;
};

// Vendor picker option — name is shown/saved; tax_id is searchable + shown muted.
type VendorOpt = { name: string; tax_id: string | null };

const WEEKDAY_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

// Next occurrence of `weekday` (0=Sun..6=Sat) on or after `isoDate` (YYYY-MM-DD).
// "จ่ายตามรอบบริษัท": a credit bill with no explicit due date defaults to the
// company's weekly pay day. Same weekday as the bill date → that day.
function nextPayDate(isoDate: string, weekday: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const add = (weekday - dt.getUTCDay() + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() + add);
  return dt.toISOString().slice(0, 10);
}

// Build Combobox options so the field matches on name OR 13-digit tax id
// (with or without dashes). The name is what gets stored.
function vendorOptions(vendors: VendorOpt[]): ComboOption[] {
  return vendors.map((v) => {
    const digits = (v.tax_id ?? "").replace(/\D/g, "");
    return {
      value: v.name,
      hint: v.tax_id ?? undefined,
      search: `${v.name} ${v.tax_id ?? ""} ${digits}`
    };
  });
}

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
// ISO-8601 week number (Mon-start) of a YYYY-MM-DD date — for "สัปดาห์ที่ x".
function isoWeekNo(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((dt.getTime() - firstThu.getTime()) / 604800000);
}
// Date range of a week, e.g. "14 – 20 มิถุนายน 2570" — collapses the month/year
// when the week sits inside one month; expands when it straddles months/years.
function weekDateRange(start: string, end: string): string {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  const beS = sy + 543, beE = ey + 543;
  if (sy === ey && sm === em) return `${sd} – ${ed} ${TH_MON_FULL[sm]} ${beE}`;
  if (sy === ey) return `${sd} ${TH_MON_FULL[sm]} – ${ed} ${TH_MON_FULL[em]} ${beE}`;
  return `${sd} ${TH_MON_FULL[sm]} ${beS} – ${ed} ${TH_MON_FULL[em]} ${beE}`;
}
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
// Smooth (Catmull-Rom → bezier) path through points, so the profit line flows
// instead of zig-zagging. Gentle tension to avoid big overshoot on spikes.
function smoothPath(pts: Array<{ x: number; y: number }>, tension = 0.16): string {
  if (pts.length === 0) return "";
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const d = [`M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d.push(`C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`);
  }
  return d.join(" ");
}

type ComboPoint = { key: string; label: string; revenue: number; financing: number; expense: number; profit: number; tip: string };

// Revenue/expense bars + value labels + thin profit line — pure SVG (no chart
// lib), "style C" (owner 2026-06-23). Period-aware (owner 2026-06-25): year →
// one bar per month, month/week → one bar per day. Value labels only show when
// the bars are few enough not to crowd; x-labels thin out for long series.
function ComboChart({ points }: { points: ComboPoint[] }) {
  const W = 900, Lm = 40, H = 132, padTop = 16, padBottom = 4, labelBand = 24;
  const plotW = W - Lm;
  const n = Math.max(points.length, 1);
  const maxV = Math.max(...points.map((m) => m.revenue + m.financing), ...points.map((m) => m.expense), ...points.map((m) => m.profit), 0);
  const minV = Math.min(...points.map((m) => m.profit), 0);
  const top = niceTop(maxV);
  const bottom = minV < 0 ? -niceTop(-minV) : 0;
  const span = top - bottom || 1;
  const mapY = (v: number) => padTop + ((top - v) / span) * (H - padTop - padBottom);
  const zeroY = mapY(0);
  const colW = plotW / n;
  const barW = Math.min(13, Math.max(2.5, colW / 3.4));
  const N = 4;
  const ticks = Array.from({ length: N + 1 }, (_, i) => bottom + (span * i) / N);
  const linePoints = points.map((m, i) => ({ x: Lm + i * colW + colW / 2, y: mapY(m.profit) }));
  const lineD = smoothPath(linePoints);
  const areaD = linePoints.length
    ? `${lineD} L${linePoints[linePoints.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${linePoints[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`
    : "";
  const showValues = n <= 14;            // skip per-bar value labels for long series
  const showDots = n <= 14;              // dots clutter a long daily series
  const stride = Math.ceil(n / 13);      // keep ~13 x-axis labels at most
  const [hover, setHover] = useState<number | null>(null);
  return (
    <svg viewBox={`0 0 ${W} ${H + labelBand}`} preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="กราฟรายรับ รายจ่าย และกำไร"
      style={{ display: "block", width: "100%", height: "auto", aspectRatio: `${W} / ${H + labelBand}`, maxHeight: 260 }}>
      <defs>
        <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
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
      {points.map((m, i) => {
        const cx = Lm + i * colW + colW / 2;
        const rY = mapY(m.revenue), eY = mapY(m.expense);
        const fTopY = mapY(m.revenue + m.financing);   // financing stacks on top of sales
        const inX = cx - barW - 1;                       // money-in bar (sales + financing)
        return (
          <g key={m.key}>
            <rect x={inX} y={Math.min(rY, zeroY)} width={barW} height={Math.abs(zeroY - rY)} rx={3} fill="#10b981" opacity={0.92}>
              <title>{`${m.tip} ยอดขาย ฿${fmtMoney(m.revenue)}`}</title>
            </rect>
            {m.financing > 0 && (
              <rect x={inX} y={fTopY} width={barW} height={Math.max(0, rY - fTopY)} rx={3} fill="#38bdf8" opacity={0.9}>
                <title>{`${m.tip} เงินกู้/เงินเข้าอื่น ฿${fmtMoney(m.financing)}`}</title>
              </rect>
            )}
            <rect x={cx + 1} y={Math.min(eY, zeroY)} width={barW} height={Math.abs(zeroY - eY)} rx={3} fill="#f5c97a">
              <title>{`${m.tip} รายจ่าย ฿${fmtMoney(m.expense)}`}</title>
            </rect>
            {showValues && m.revenue + m.financing > 0 && (
              <text x={cx - barW / 2 - 0.5} y={fTopY - 3} textAnchor="middle" fontSize={7.5} fontWeight={600} fill="#0F6E56">{fmtK(m.revenue + m.financing)}</text>
            )}
            {(i % stride === 0 || i === n - 1) && (
              <text x={cx} y={H + 17} fontSize={n > 16 ? 9 : 11} fontWeight={600} fill="#475569" textAnchor="middle">{m.label}</text>
            )}
          </g>
        );
      })}
      {/* Soft profit area + smooth line + dots (dots only when few points) */}
      {areaD && <path d={areaD} fill="url(#profitFill)" stroke="none" />}
      <path d={lineD} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {showDots && points.map((m, i) => (
        <circle key={m.key} cx={Lm + i * colW + colW / 2} cy={mapY(m.profit)} r={2} fill="#6366f1" />
      ))}
      {/* Hover layer: full-column capture + a value tooltip for the pointed day */}
      {points.map((m, i) => (
        <rect key={`h${m.key}`} x={Lm + i * colW} y={padTop} width={colW} height={H - padTop} fill="transparent"
          onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))} />
      ))}
      {hover != null && points[hover] && (() => {
        const m = points[hover];
        const cx = Lm + hover * colW + colW / 2;
        const hasFin = m.financing > 0;
        const boxH = hasFin ? 68 : 56;
        const boxW = 160, by = 4;
        const bx = Math.min(Math.max(cx - boxW / 2, Lm), W - boxW);
        let yy = by + 28;
        return (
          <g pointerEvents="none">
            <line x1={cx} y1={padTop} x2={cx} y2={H} stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" />
            <rect x={bx} y={by} width={boxW} height={boxH} rx={5} fill="#1e293b" opacity={0.95} />
            <text x={bx + 8} y={by + 15} fontSize={9} fontWeight={700} fill="#ffffff">{m.tip}</text>
            <text x={bx + 8} y={yy} fontSize={8.5} fill="#6ee7b7">ยอดขาย ฿{fmtMoney(m.revenue)}</text>
            {hasFin && (<text x={bx + 8} y={(yy += 11)} fontSize={8.5} fill="#7dd3fc">เงินกู้/เงินเข้าอื่น ฿{fmtMoney(m.financing)}</text>)}
            <text x={bx + 8} y={(yy += 11)} fontSize={8.5} fill="#fcd34d">รายจ่าย ฿{fmtMoney(m.expense)}</text>
            <text x={bx + 8} y={(yy += 11)} fontSize={8.5} fill="#c7d2fe">กำไร ฿{fmtMoney(m.profit)}</text>
          </g>
        );
      })()}
    </svg>
  );
}

// All YYYY-MM-DD dates in [start, end] inclusive (for the per-day chart axis).
function enumerateDays(start: string, end: string): string[] {
  const out: string[] = [];
  const [ys, ms, ds] = start.split("-").map(Number);
  const [ye, me, de] = end.split("-").map(Number);
  let t = Date.UTC(ys, ms - 1, ds);
  const tEnd = Date.UTC(ye, me - 1, de);
  let guard = 0;
  while (t <= tEnd && guard++ < 400) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400_000;
  }
  return out;
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

// Inline drill-down under a day row (owner 2026-06-24): the two-sided ledger
// for one day — รายรับ (per-channel, manual rows editable in place) on the left,
// รายจ่าย on the right, day totals beneath. shift-close income mirrors the
// daily close report and stays read-only here (edit it at ยอดขายรายวัน).
function DayDetail({
  date, rows, loading, err, expenses, channels, categories, branchId, companyId, billCount,
  draftExpenses, expenseVendors, payCycleWeekday, onChanged, removeExpense, onEditExpense, onEditIncome, busyExpenseId
}: {
  date: string;
  rows: IncomeDayRow[] | undefined;
  loading: boolean;
  err: string | null;
  expenses: LedgerExpenseRow[];
  channels: Array<{ id: number; name: string }>;
  categories: Array<{ code: string | null; name: string }>;
  branchId: number;
  companyId: number | null;
  billCount: number | null;
  draftExpenses: DraftLite[];
  expenseVendors: VendorOpt[];
  payCycleWeekday: number;
  onChanged: () => void;
  removeExpense: (e: LedgerExpenseRow) => void;
  onEditExpense: (e: LedgerExpenseRow) => void;
  onEditIncome: (r: IncomeDayRow) => void;
  busyExpenseId: number | null;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  // Bangkok today — for measuring whether a credit bill is past due / due today.
  const todayStr = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [editId, setEditId] = useState<number | null>(null);
  const [editAmt, setEditAmt] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);
  const [addChannel, setAddChannel] = useState(channels[0]?.name ?? "");
  const [addAmt, setAddAmt] = useState("");
  const [adding, setAdding] = useState(false);
  const [rowErr, setRowErr] = useState<string | null>(null);
  // รายจ่าย quick-add (vendor + category + amount + VAT + paid/unpaid)
  const [expVendor, setExpVendor] = useState("");
  const [expCategory, setExpCategory] = useState("");
  const [expAmt, setExpAmt] = useState("");
  const [expVat, setExpVat] = useState(false);
  const [expUnpaid, setExpUnpaid] = useState(false);
  // Credit-bill due date: "cycle" = บริษัทจ่ายตามรอบ (วันจ่ายถัดไป) | "date" = ระบุวันเอง
  const [expDueMode, setExpDueMode] = useState<"cycle" | "date">("cycle");
  const [expDueDate, setExpDueDate] = useState("");
  const [expAdding, setExpAdding] = useState(false);
  const [expErr, setExpErr] = useState<string | null>(null);
  const [pinRow, setPinRow] = useState<IncomeDayRow | null>(null); // auto row pending PIN-delete
  const [draftPickerOpen, setDraftPickerOpen] = useState(false);
  const [fromDraft, setFromDraft] = useState<DraftLite | null>(null); // pulling a scanned draft
  // Mark-a-credit-bill-paid inline form: which row + the chosen cash-out date.
  const [payId, setPayId] = useState<number | null>(null);
  const [payDate, setPayDate] = useState("");
  const [payBusy, setPayBusy] = useState(false);

  function openPay(e: LedgerExpenseRow) {
    // Default the cash-out date to today (you're usually marking a bill paid now);
    // editable, and the API rejects a future date.
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    setPayId(e.id); setPayDate(today); setExpErr(null);
  }
  async function confirmPay() {
    if (payId == null) return;
    setPayBusy(true); setExpErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${payId}/pay`), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paid_date: payDate || undefined })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setExpErr(j.message || "บันทึกการจ่ายไม่สำเร็จ"); return; }
      setPayId(null); onChanged();
    } finally { setPayBusy(false); }
  }

  function pickDraft(d: DraftLite) {
    setExpVendor(d.vendor_name || "");
    setExpCategory(d.category || "");
    setExpAmt(d.amount_total > 0 ? grpMoney(String(d.amount_total)) : "");
    setExpVat(d.has_tax_invoice);
    setExpUnpaid(d.payment_status === "unpaid");
    setFromDraft(d);
    setDraftPickerOpen(false);
    setExpErr(null);
  }
  function clearDraft() {
    setFromDraft(null);
    setExpVendor(""); setExpCategory(""); setExpAmt(""); setExpVat(false); setExpUnpaid(false);
    setExpDueMode("cycle"); setExpDueDate("");
  }

  // Insertion order: earliest added on top, latest at the bottom (owner 2026-06-25).
  const allRows = (rows ?? []).slice().sort((a, b) => a.id - b.id);
  const isChannelled = (r: IncomeDayRow) => !!(r.channel && r.channel.trim());
  // Supersede rule (owner 2026-06-25): once a day has a per-channel breakdown,
  // the channel-less close lump is redundant — hide it + drop it from the sum so
  // the breakdown REPLACES it (no double-count, and it's harmless if it regenerates).
  const hasBreakdown = allRows.some(isChannelled);
  const inc = hasBreakdown
    ? allRows.filter((r) => !(r.source === "shift_close" && !isChannelled(r)))
    : allRows;
  const usedChannels = new Set(inc.map((r) => (r.channel || "").trim()).filter(Boolean));
  const availableChannels = channels.filter((c) => !usedChannels.has(c.name));
  const incTotal = inc.reduce((s, r) => s + r.amount, 0);
  const incAR = inc.reduce((s, r) => s + (r.is_outstanding ? r.amount : 0), 0);
  const incCash = incTotal - incAR;
  const expTotal = expenses.reduce((s, e) => s + e.amount_total, 0);
  const net = incTotal - expTotal;

  // Group รายจ่าย by category so a shared category shows once (owner 2026-06-25).
  const expGroups = (() => {
    const order: string[] = [];
    const m = new Map<string, LedgerExpenseRow[]>();
    for (const e of expenses) {
      const k = e.category || "ไม่ระบุหมวด";
      if (!m.has(k)) { m.set(k, []); order.push(k); }
      m.get(k)!.push(e);
    }
    return order.map((cat) => {
      const grp = m.get(cat)!;
      return { cat, rows: grp, subtotal: grp.reduce((s, e) => s + e.amount_total, 0) };
    });
  })();

  async function saveAmount(r: IncomeDayRow) {
    const amt = parseMoney(editAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setRowErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setSavingId(r.id); setRowErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/income/${r.id}`), {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: r.branch_id, company_id: r.company_id, income_date: r.income_date,
          channel: r.channel, amount: amt, note: r.note
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setRowErr(j.message || "บันทึกไม่สำเร็จ"); return; }
      setEditId(null); onChanged();
    } finally { setSavingId(null); }
  }

  async function del(r: IncomeDayRow) {
    const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบรายรับ ${r.channel ?? ""} ฿${fmtMoney(r.amount)} ?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setSavingId(r.id); setRowErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/income/${r.id}`), { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setRowErr(j.message || "ลบไม่สำเร็จ"); return; }
      onChanged();
    } finally { setSavingId(null); }
  }

  // Auto (Check list หลังเลิกงาน) row → confirm with a PIN before deleting.
  async function delAuto(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = pinRow;
    if (!r) return { ok: false, message: "ไม่พบรายการ" };
    const res = await fetch(apiUrl(`/api/accounta/income/${r.id}?pin=${encodeURIComponent(pin)}`), { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) return { ok: false, message: j.message === undefined ? "ลบไม่สำเร็จ" : (j.error === "pin_required" ? "PIN ไม่ถูกต้อง" : j.message) };
    setPinRow(null); onChanged();
    return { ok: true };
  }

  async function add() {
    const amt = parseMoney(addAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setRowErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setAdding(true); setRowErr(null);
    try {
      const res = await fetch(apiUrl("/api/accounta/income"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_id: branchId, company_id: null, income_date: date,
          channel: addChannel || null, amount: amt, note: null
        })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setRowErr(j.message || "เพิ่มไม่สำเร็จ"); return; }
      setAddAmt(""); onChanged();
    } finally { setAdding(false); }
  }

  async function addExpense() {
    const amt = parseMoney(expAmt);
    if (!Number.isFinite(amt) || amt <= 0) { setExpErr("กรอกยอดเงินให้ถูกต้อง"); return; }
    setExpAdding(true); setExpErr(null);
    const dueDate = expUnpaid
      ? (expDueMode === "date" ? (expDueDate || null) : nextPayDate(date, payCycleWeekday))
      : null;
    const body = {
      branch_id: branchId, company_id: companyId, bill_date: date,
      vendor_name: expVendor.trim() || null, category: expCategory || null,
      amount_total: amt, has_tax_invoice: expVat,
      payment_status: expUnpaid ? "unpaid" : "paid",
      paid_date: expUnpaid ? null : date,
      due_date: dueDate
    };
    try {
      if (fromDraft != null) {
        // Pulling a scanned draft → update it with the reviewed fields then post
        // it (keeps the attached document; no duplicate row).
        const pr = await fetch(apiUrl(`/api/accounta/expenses/${fromDraft.id}`), {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const pj = await pr.json().catch(() => ({}));
        if (!pr.ok || !pj.ok) { setExpErr(pj.message || "บันทึกไม่สำเร็จ"); return; }
        const cr = await fetch(apiUrl(`/api/accounta/expenses/${fromDraft.id}/confirm`), { method: "POST" });
        const cj = await cr.json().catch(() => ({}));
        if (!cr.ok || !cj.ok) { setExpErr(cj.message || "ยืนยันลงบัญชีไม่สำเร็จ"); return; }
      } else {
        const res = await fetch(apiUrl("/api/accounta/expenses"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setExpErr(j.message || "เพิ่มไม่สำเร็จ"); return; }
      }
      setFromDraft(null);
      setExpVendor(""); setExpAmt(""); setExpVat(false); setExpUnpaid(false); setExpCategory("");
      setExpDueMode("cycle"); setExpDueDate(""); onChanged();
    } finally { setExpAdding(false); }
  }

  return (
    <div className="space-y-3 px-1 py-2">
      {ConfirmDialog}
      {rowErr && <p className="text-xs text-rose-600">{rowErr}</p>}
      {err && <p className="text-xs text-rose-600">{err}</p>}
      <div className="relative grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-7 items-start">
        {/* Centre rule — ledger / T-account look between รายรับ | รายจ่าย */}
        <div className="hidden lg:block absolute left-1/2 top-1 bottom-1 -translate-x-1/2 border-l border-slate-300" aria-hidden />
        {/* รายรับ — per-channel, manual rows editable */}
        <div className="rounded-lg border border-emerald-100 overflow-hidden">
          <div className="bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-800">รายรับ (แยกช่องทาง)</div>
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {loading && inc.length === 0 ? (
                <tr><td className="px-3 py-2 text-xs text-slate-400">กำลังโหลด…</td></tr>
              ) : inc.length === 0 ? (
                <tr><td className="px-3 py-2 text-xs text-slate-400">ไม่มีรายรับในวันนี้</td></tr>
              ) : inc.map((r) => {
                const auto = r.source === "shift_close";
                const editing = editId === r.id;
                return (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="py-1 px-2">
                      <div className="text-slate-700 flex items-center gap-1.5 flex-wrap">
                        {r.channel || (auto ? "ยอดขายรวม" : "—")}
                        {auto && <span className="text-[9px] font-normal bg-sky-50 text-sky-700 border border-sky-200 rounded-full px-1.5 py-px">Check list หลังเลิกงาน</span>}
                        {!!r.is_outstanding && (r.settled_date
                          ? <span className="text-[9px] font-normal bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-1.5 py-px">รับชำระแล้ว</span>
                          : <span className="text-[9px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">ค้างชำระ</span>)}
                      </div>
                    </td>
                    <td className="py-1 px-2 text-right">
                      {editing ? (
                        <input type="text" inputMode="decimal" autoFocus value={editAmt}
                          onChange={(e) => setEditAmt(grpMoney(e.target.value))}
                          onKeyDown={(e) => { if (e.key === "Enter") saveAmount(r); if (e.key === "Escape") setEditId(null); }}
                          className="input !w-28 !py-1 text-right font-mono" />
                      ) : (
                        <span className="font-mono text-emerald-700">{fmtMoney(r.amount)}</span>
                      )}
                    </td>
                    <td className="py-1 px-2 text-right whitespace-nowrap">
                      {auto ? (
                        <button type="button" onClick={() => { setPinRow(r); setRowErr(null); }} disabled={savingId === r.id}
                          className="text-[11px] text-slate-400 hover:text-rose-600 disabled:opacity-50"
                          title="ยอดนี้มาจาก Check list หลังเลิกงาน — กดแล้วจะให้ใส่ PIN ยืนยัน">ลบออก</button>
                      ) : editing ? (
                        <>
                          <button type="button" onClick={() => saveAmount(r)} disabled={savingId === r.id}
                            className="text-[11px] text-brand hover:underline disabled:opacity-50">บันทึก</button>
                          <button type="button" onClick={() => setEditId(null)}
                            className="text-[11px] text-slate-400 hover:underline ml-2">ยกเลิก</button>
                        </>
                      ) : (
                        <>
                          <button type="button" onClick={() => onEditIncome(r)}
                            className="text-[11px] text-slate-500 hover:text-brand">แก้ไข</button>
                          <button type="button" onClick={() => del(r)} disabled={savingId === r.id}
                            className="text-[11px] text-slate-400 hover:text-rose-600 ml-2 disabled:opacity-50">ลบออก</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {/* add a manual channel row */}
              <tr className="bg-slate-50/60">
                <td className="py-1 px-2">
                  <Select value={usedChannels.has(addChannel) ? "" : addChannel} onChange={setAddChannel}
                    buttonClassName="!py-1" placeholder="— เลือกช่องทาง —"
                    options={availableChannels.map((c) => ({ value: c.name, label: c.name }))} />
                </td>
                <td className="py-1 px-2 text-right">
                  <input type="text" inputMode="decimal" value={addAmt} placeholder="0.00"
                    onChange={(e) => setAddAmt(grpMoney(e.target.value))}
                    onKeyDown={(e) => { if (e.key === "Enter") add(); }}
                    className="input !w-28 !py-1 text-right font-mono" />
                </td>
                <td className="py-1 px-2 text-right">
                  <button type="button" onClick={add} disabled={adding || !addAmt}
                    className="text-[11px] text-brand hover:underline disabled:opacity-40">+ เพิ่ม</button>
                </td>
              </tr>
            </tbody>
            <tfoot><tr className="border-t border-slate-200 font-bold bg-slate-50">
              <td className="py-1 px-2 text-slate-700">รวมรายรับ</td>
              <td className="py-1 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(incTotal)}</td>
              <td className="py-1 px-2 text-right text-[10px] font-normal text-slate-400 whitespace-nowrap">
                {incAR > 0 ? `ค้าง ฿${fmtMoney(incAR)} · เข้าจริง ฿${fmtMoney(incCash)}` : ""}
              </td>
            </tr></tfoot>
          </table>
        </div>

        {/* รายจ่าย */}
        <div className="rounded-lg border border-rose-100 overflow-hidden">
          <div className="bg-rose-50 px-3 py-1.5 flex items-center justify-between">
            <span className="text-[11px] font-bold text-rose-800">รายจ่าย ({expenses.length} รายการ)</span>
            <Link href={`/admin/accounta/expenses?month=${date.slice(0, 7)}`} className="text-[10px] text-brand hover:underline">ไปหน้ารายจ่าย →</Link>
          </div>
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {expenses.length === 0 ? (
                <tr><td className="px-3 py-2 text-xs text-slate-400">ไม่มีรายจ่ายในวันนี้</td></tr>
              ) : expGroups.map((g) => (
                <Fragment key={g.cat}>
                  <tr className="bg-rose-50/40 border-b border-rose-100">
                    <td className="py-1 px-2 text-[11px] font-bold text-rose-800">{g.cat}{g.rows.length > 1 ? ` (${g.rows.length})` : ""}</td>
                    <td className="py-1 px-2 text-right font-mono text-[11px] text-rose-700">{fmtMoney(g.subtotal)}</td>
                    <td />
                  </tr>
                  {g.rows.map((e) => {
                    const unpaid = e.payment_status === "unpaid";
                    // Overdue/due is measured against TODAY (a bill sits under its
                    // bill_date row, but whether it's past due depends on now).
                    const overdue = unpaid && e.due_date != null && e.due_date < todayStr;
                    const dueToday = unpaid && e.due_date != null && e.due_date === todayStr;
                    const tag = [
                      unpaid ? "ค้างชำระ" : "",
                      e.vat_amount > 0 ? `VAT ฿${fmtMoney(e.vat_amount)}` : ""
                    ].filter(Boolean).join(" · ");
                    return (
                      <tr key={e.id} className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="py-1 px-2 pl-5">
                          <div className="text-slate-700 flex items-center gap-1.5 flex-wrap">
                            {e.vendor_name || "—"}
                            {e.capex_bucket && <span className="text-[9px] font-normal bg-violet-50 text-violet-700 border border-violet-200 rounded-full px-1.5 py-px" title="ผูกกับ FEASIBILITY (เงินลงทุนตั้งต้น)">FEASIBILITY · {STARTUP_CATEGORY_LABEL[e.capex_bucket as keyof typeof STARTUP_CATEGORY_LABEL] ?? "ลงทุน"}</span>}
                            {overdue && <span className="text-[9px] font-normal bg-rose-50 text-rose-700 border border-rose-200 rounded-full px-1.5 py-px">เลยกำหนด</span>}
                            {dueToday && <span className="text-[9px] font-normal bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-1.5 py-px">ครบกำหนดวันนี้</span>}
                          </div>
                          {tag && <div className="text-[10px] text-slate-400">{tag}{unpaid && e.due_date && !overdue && !dueToday ? ` · ครบกำหนด ${e.due_date}` : ""}</div>}
                          {payId === e.id && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <input type="date" value={payDate}
                                onChange={(ev) => setPayDate(ev.target.value)} className="input !py-0.5 !w-auto text-[11px]" />
                              <button type="button" onClick={confirmPay} disabled={payBusy || !payDate}
                                className="text-[10px] text-white bg-emerald-600 hover:bg-emerald-700 rounded px-2 py-0.5 disabled:opacity-50">ยืนยันจ่าย</button>
                              <button type="button" onClick={() => setPayId(null)} disabled={payBusy}
                                className="text-[10px] text-slate-400 hover:text-slate-600">ยกเลิก</button>
                            </div>
                          )}
                        </td>
                        <td className="py-1 px-2 text-right font-mono text-rose-700">{fmtMoney(e.amount_total)}</td>
                        <td className="py-1 px-2 text-right whitespace-nowrap">
                          {unpaid && payId !== e.id && (
                            <button type="button" onClick={() => openPay(e)} className="text-[10px] text-emerald-600 hover:underline mr-2">จ่ายแล้ว</button>
                          )}
                          <button type="button" onClick={() => onEditExpense(e)} className="text-[10px] text-brand hover:underline mr-2">แก้ไข</button>
                          <button type="button" onClick={() => removeExpense(e)} disabled={busyExpenseId === e.id} className="text-[10px] text-rose-500 hover:underline disabled:opacity-50">ลบออก</button>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              {/* quick-add an expense for this day */}
              <tr className="bg-slate-50/60 border-t border-slate-100">
                <td colSpan={3} className="px-2 py-2">
                  {expErr && <p className="text-[11px] text-rose-600 mb-1">{expErr}</p>}
                  {/* pull from scanned-bill drafts */}
                  <div className="mb-1.5">
                    <button type="button" onClick={() => setDraftPickerOpen((v) => !v)}
                      className="text-[11px] text-brand hover:underline disabled:opacity-40" disabled={draftExpenses.length === 0}>
                      ดึงจากเอกสารรอลงบัญชี ({draftExpenses.length})
                    </button>
                    {draftPickerOpen && draftExpenses.length > 0 && (
                      <div className="mt-1 border border-slate-200 rounded-md bg-white max-h-44 overflow-y-auto divide-y divide-slate-50">
                        {draftExpenses.map((d) => (
                          <button type="button" key={d.id} onClick={() => pickDraft(d)}
                            className="w-full text-left px-2 py-1.5 hover:bg-slate-50 flex items-center justify-between gap-2">
                            <span className="text-[11px] text-slate-700 truncate">
                              {d.vendor_name || "— ยังไม่ระบุร้าน —"}
                              <span className="text-slate-400"> · {fmtDayLabel(d.bill_date).replace("วัน", "")}</span>
                              {d.has_doc && <span className="text-brand"> · มีเอกสาร</span>}
                            </span>
                            <span className="text-[11px] font-mono text-rose-700 shrink-0">฿{fmtMoney(d.amount_total)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {fromDraft != null && (
                      <div className="mt-1 space-y-1.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                            กำลังลงจากเอกสาร #{fromDraft.id} — ตรวจแล้วกด “ยืนยันลงบัญชี”
                          </span>
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => { clearDraft(); setDraftPickerOpen(true); }}
                              className="text-[11px] text-brand hover:underline">เลือกใบอื่น</button>
                            <button type="button" onClick={clearDraft}
                              className="text-[11px] text-rose-500 hover:underline">ยกเลิก</button>
                          </div>
                        </div>
                        {fromDraft.has_doc ? (
                          <div className="rounded-lg border border-slate-200 overflow-hidden bg-slate-100">
                            {(fromDraft.doc_mime ?? "").startsWith("image/") ? (
                              // Fit the whole page in the box first; tap "เต็มจอ" to zoom.
                              <img src={apiUrl(`/api/accounta/expenses/${fromDraft.id}/doc`)} alt="เอกสาร"
                                className="w-full h-[42vh] md:h-[55vh] object-contain" />
                            ) : (
                              <iframe src={apiUrl(`/api/accounta/expenses/${fromDraft.id}/doc#view=FitH`)} title="เอกสาร"
                                className="w-full h-[42vh] md:h-[55vh]" />
                            )}
                            <a href={apiUrl(`/api/accounta/expenses/${fromDraft.id}/doc`)} target="_blank" rel="noreferrer"
                              className="block text-center text-[11px] text-brand hover:underline py-1 border-t border-slate-200 bg-white">เปิดเอกสารเต็มจอ (ซูมได้)</a>
                          </div>
                        ) : (
                          <p className="text-[10px] text-amber-600">เอกสารนี้ไม่มีไฟล์แนบ</p>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Combobox value={expVendor} onChange={setExpVendor} options={vendorOptions(expenseVendors)}
                      placeholder="ผู้จำหน่าย / รายการ (พิมพ์ชื่อหรือเลขภาษี)" className="flex-[3] !min-w-[15rem]" inputClassName="!py-1" />
                    <Select value={expCategory} onChange={setExpCategory} title="หมวดหมู่"
                      className="!w-auto !min-w-[5.5rem]" buttonClassName="!py-1" placeholder="หมวด"
                      options={categories.map((c) => ({ value: c.name, label: c.code || c.name }))} />
                    <input type="text" inputMode="decimal" value={expAmt} placeholder="0.00"
                      onChange={(e) => setExpAmt(grpMoney(e.target.value))}
                      onKeyDown={(e) => { if (e.key === "Enter") addExpense(); }}
                      className="input !w-28 !py-1 text-right font-mono" />
                    <label className="flex items-center gap-1 text-[11px] text-slate-500"><input type="checkbox" checked={expVat} onChange={(e) => setExpVat(e.target.checked)} />VAT</label>
                    <label className="flex items-center gap-1 text-[11px] text-slate-500"><input type="checkbox" checked={expUnpaid} onChange={(e) => setExpUnpaid(e.target.checked)} />ค้างชำระ</label>
                    <button type="button" onClick={addExpense} disabled={expAdding || !expAmt}
                      className="text-[11px] text-brand hover:underline disabled:opacity-40">{fromDraft != null ? "+ ยืนยันลงบัญชี" : "+ เพิ่ม"}</button>
                  </div>
                  {expUnpaid && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
                      <span className="text-slate-400">ครบกำหนดชำระ</span>
                      <Select value={expDueMode} onChange={(v) => setExpDueMode(v as "cycle" | "date")}
                        className="!w-auto !min-w-[12rem]" buttonClassName="!py-1"
                        options={[
                          { value: "cycle", label: `ตามรอบบริษัท (ทุกวัน${WEEKDAY_TH[payCycleWeekday]})` },
                          { value: "date", label: "ระบุวันเอง" }
                        ]} />
                      {expDueMode === "date" ? (
                        <input type="date" value={expDueDate} onChange={(e) => setExpDueDate(e.target.value)}
                          className="input !py-1 !w-auto" />
                      ) : (
                        <span className="text-slate-500">→ {fmtDayLabel(nextPayDate(date, payCycleWeekday))}</span>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            </tbody>
            <tfoot><tr className="border-t border-slate-200 font-bold bg-slate-50">
              <td className="py-1 px-2 text-slate-700">รวมรายจ่าย</td>
              <td className="py-1 px-2 text-right font-mono text-rose-700">฿{fmtMoney(expTotal)}</td>
              <td />
            </tr></tfoot>
          </table>
        </div>
      </div>

      {/* Day totals */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
        <div className="text-center"><div className="text-[10px] text-slate-400">รายรับรวม</div><div className="font-mono font-bold text-emerald-700">฿{fmtMoney(incTotal)}</div></div>
        <div className="text-center"><div className="text-[10px] text-slate-400">รายจ่ายรวม</div><div className="font-mono font-bold text-rose-700">฿{fmtMoney(expTotal)}</div></div>
        <div className="text-center"><div className="text-[10px] text-slate-400">กำไร/ขาดทุนวันนี้</div><div className={`font-mono font-bold ${net >= 0 ? "text-slate-800" : "text-rose-600"}`}>{net < 0 ? `(฿${fmtMoney(-net)})` : `฿${fmtMoney(net)}`}</div></div>
        <div className="text-center"><div className="text-[10px] text-slate-400">จำนวนบิลวันนี้</div><div className="font-mono font-bold text-slate-700">{billCount != null ? `${billCount.toLocaleString("en-US")} ใบ` : "—"}</div>{billCount != null && billCount > 0 && <div className="text-[10px] text-slate-400">฿{fmtMoney(incTotal / billCount)}/บิล</div>}</div>
      </div>

      {pinRow && (
        <PinPromptModal
          title="ลบยอดจาก Check list หลังเลิกงาน"
          description={<>ยอด <b>{pinRow.channel || "ยอดขายรวม"} ฿{fmtMoney(pinRow.amount)}</b> มาจากรายงานปิดกะ — ใส่ PIN เพื่อยืนยันการลบ (จะกลับมาอีกถ้าปิดกะวันนี้ใหม่)</>}
          submitLabel="ลบ"
          onSubmit={delAuto}
          onClose={() => setPinRow(null)}
        />
      )}
    </div>
  );
}

export default function LedgerDashboardClient({
  dash, expenses, period, anchor, monthly, trendYear, payables, cashAccounts, cashTotal,
  branchId, companyId, branchName, incomeChannels, expenseCategories, draftExpenses, expenseVendors,
  paymentMethods, payCycleWeekday
}: {
  dash: Dash; expenses: LedgerExpenseRow[]; period: LedgerPeriod; anchor: string;
  monthly: MonthlyRow[]; trendYear: number; payables: Payables;
  cashAccounts: CashAccount[]; cashTotal: number;
  branchId: number; companyId: number | null; branchName: string;
  incomeChannels: Array<{ id: number; name: string }>;
  expenseCategories: Array<{ code: string | null; name: string }>;
  draftExpenses: DraftLite[];
  expenseVendors: VendorOpt[];
  paymentMethods: Array<{ id: number; name: string }>;
  payCycleWeekday: number;
}) {
  const { confirm, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // In-page รายจ่าย edit modal (owner 2026-06-29) — the daybook is the main
  // workspace, so editing a bill opens here instead of jumping to หน้ารายจ่าย.
  const [editExpense, setEditExpense] = useState<LedgerExpenseRow | null>(null);
  const [editIncome, setEditIncome] = useState<IncomeDayRow | null>(null);
  // Top spending view: sum per vendor (default — "พรชัยการไฟฟ้า ทั้งเดือนเท่าไหร่")
  // or biggest individual bills (owner 2026-06-30).
  const [topMode, setTopMode] = useState<"vendor" | "bill">("vendor");
  // SVG charts render client-only — their <title> tooltips otherwise produce
  // an SSR/hydration text-node mismatch with Thai labels. Cards/tables SSR fine.
  const [chartsReady, setChartsReady] = useState(false);
  useEffect(() => { setChartsReady(true); }, []);

  // Per-day income rows (with id + source) for the inline drill-down — fetched
  // on demand and cached by date, so the manual rows can be edited in place.
  // (The dashboard ships only channel-aggregated rows, which can't be edited.)
  const [incCache, setIncCache] = useState<Record<string, IncomeDayRow[]>>({});
  const [incLoading, setIncLoading] = useState<string | null>(null);
  const [incErr, setIncErr] = useState<string | null>(null);

  async function loadDayIncome(date: string, force = false) {
    if (!force && incCache[date]) return;
    setIncLoading(date); setIncErr(null);
    try {
      const q = new URLSearchParams({ month: date.slice(0, 7), branch: String(branchId) });
      const res = await fetch(apiUrl(`/api/accounta/income?${q}`));
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setIncErr("โหลดรายรับไม่สำเร็จ"); return; }
      const rows = (j.income as IncomeDayRow[]).filter((r) => r.income_date === date);
      setIncCache((c) => ({ ...c, [date]: rows }));
    } catch { setIncErr("โหลดรายรับไม่สำเร็จ"); }
    finally { setIncLoading(null); }
  }

  function toggleDay(date: string) {
    setSelectedDate((d) => {
      const next = d === date ? null : date;
      if (next) loadDayIncome(next);
      return next;
    });
  }

  function go(nextPeriod: LedgerPeriod, nextAnchor: string) {
    const q = new URLSearchParams({ period: nextPeriod, anchor: nextAnchor });
    startTransition(() => router.push(`/admin/accounta/daybook?${q.toString()}`));
  }

  // Direct add (owner 2026-06-25): add รายรับ/รายจ่าย for ANY date right here,
  // always scoped to the ACTIVE branch (no cross-branch keying). Lets you record
  // a day that never had a shift-close.
  const bkkToday = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const [addMode, setAddMode] = useState<null | "income" | "expense">(null);
  const [aDate, setADate] = useState(bkkToday);
  const [aChannel, setAChannel] = useState(incomeChannels[0]?.name ?? "");
  const [aAmt, setAAmt] = useState("");
  const [aVendor, setAVendor] = useState("");
  const [aCategory, setACategory] = useState("");
  const [aVat, setAVat] = useState(false);
  // รายรับ: ประเภท sale_vat (default) | sale_novat | financing(เงินกู้ ไม่นับยอดขาย)
  const [aIncKind, setAIncKind] = useState<"sale_vat" | "sale_novat" | "financing">("sale_vat");
  const [aUnpaid, setAUnpaid] = useState(false);
  const [aDueMode, setADueMode] = useState<"cycle" | "date">("cycle");
  const [aDueDate, setADueDate] = useState("");
  const [aBusy, setABusy] = useState(false);
  const [aErr, setAErr] = useState<string | null>(null);

  function openAdd(mode: "income" | "expense") {
    setADate(selectedDate ?? bkkToday);
    setAChannel(incomeChannels[0]?.name ?? ""); setAAmt("");
    setAVendor(""); setACategory(""); setAVat(false); setAUnpaid(false);
    setADueMode("cycle"); setADueDate(""); setAIncKind("sale_vat");
    setAErr(null); setAddMode(mode);
  }
  function afterAdd() {
    const d = aDate;
    setAddMode(null);
    setSelectedDate(d);
    loadDayIncome(d, true);
    if (d >= dash.start && d <= dash.end) startTransition(() => router.refresh());
    else go("month", d); // jump to the month that now has the new entry
  }
  async function submitAdd() {
    const amt = parseMoney(aAmt);
    if (addMode === "income") {
      if (!Number.isFinite(amt) || amt <= 0) { setAErr("กรอกยอดเงินให้ถูกต้อง"); return; }
      setABusy(true); setAErr(null);
      try {
        const res = await fetch(apiUrl("/api/accounta/income"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch_id: branchId, company_id: companyId, income_date: aDate, channel: aChannel || null, amount: amt, note: null, is_vat: aIncKind === "sale_vat", is_revenue: aIncKind !== "financing" })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setAErr(j.message || "บันทึกไม่สำเร็จ"); return; }
        afterAdd();
      } finally { setABusy(false); }
    } else {
      if (!Number.isFinite(amt) || amt <= 0) { setAErr("กรอกยอดเงินให้ถูกต้อง"); return; }
      setABusy(true); setAErr(null);
      try {
        const res = await fetch(apiUrl("/api/accounta/expenses"), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branch_id: branchId, company_id: companyId, bill_date: aDate,
            vendor_name: aVendor.trim() || null, category: aCategory || null,
            amount_total: amt, has_tax_invoice: aVat,
            payment_status: aUnpaid ? "unpaid" : "paid", paid_date: aUnpaid ? null : aDate,
            due_date: aUnpaid
              ? (aDueMode === "date" ? (aDueDate || null) : nextPayDate(aDate, payCycleWeekday))
              : null
          })
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.ok) { setAErr(j.message || "บันทึกไม่สำเร็จ"); return; }
        afterAdd();
      } finally { setABusy(false); }
    }
  }

  async function remove(e: LedgerExpenseRow) {
    const ok = await confirm({ title: "ยืนยันการลบ", body: `ลบรายจ่าย "${e.vendor_name ?? "รายการนี้"}" ฿${fmtMoney(e.amount_total)} ? กู้คืนไม่ได้`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    setBusyId(e.id);
    try {
      const res = await fetch(apiUrl(`/api/accounta/expenses/${e.id}`), { method: "DELETE" });
      if (res.ok) startTransition(() => router.refresh());
    } finally { setBusyId(null); }
  }

  const margin = dash.salesRevenue > 0 ? Math.round((dash.net / dash.salesRevenue) * 100) : null;
  const payableTotal = payables.whtUnpaid + payables.ssoUnpaid + payables.branchUnpaidTotal;
  const payableCount = payables.branchUnpaidCount + (payables.whtUnpaid > 0 ? 1 : 0) + (payables.ssoUnpaid > 0 ? 1 : 0);
  const dayRowMap = new Map(dash.dailyRows.map((r) => [r.date, r]));
  // Daybook footer totals: financing (loans/other inflows) + running cash on hand
  // = sales + financing − expense (owner 2026-06-29).
  const financingTotal = dash.dailyRows.reduce((s, r) => s + r.financing, 0);
  const runningCashTotal = Math.round((dash.revenue + financingTotal - dash.expense) * 100) / 100;
  const incomeTop = [...dash.incomeByChannel].slice(0, 8);
  // Top spending — the biggest individual bills this period (owner 2026-06-29).
  // From the already-loaded `expenses`; tap a row to edit it in place.
  const topExpenses = [...expenses].sort((a, b) => b.amount_total - a.amount_total).slice(0, 10);
  // Aggregated per vendor: total spent + bill count this period, biggest first.
  const topVendors = (() => {
    const m = new Map<string, { vendor: string; amount: number; count: number }>();
    for (const e of expenses) {
      const v = (e.vendor_name || "").trim() || "ไม่ระบุผู้จำหน่าย";
      const g = m.get(v) ?? { vendor: v, amount: 0, count: 0 };
      g.amount += e.amount_total; g.count += 1;
      m.set(v, g);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
  })();
  const expenseTop = [...dash.categories].sort((a, b) => b.spent - a.spent).slice(0, 8)
    .map((c) => ({ label: c.code ? `${c.code} · ${c.name}` : c.name, amount: c.spent }));

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {editExpense && (
        <ExpenseEditModal
          expense={editExpense}
          categories={expenseCategories}
          vendors={expenseVendors}
          paymentMethods={paymentMethods}
          onClose={() => setEditExpense(null)}
          onSaved={() => { setEditExpense(null); startTransition(() => router.refresh()); }}
        />
      )}
      {editIncome && (
        <IncomeEditModal
          income={editIncome}
          channels={incomeChannels}
          onClose={() => setEditIncome(null)}
          onSaved={() => { const d = editIncome.income_date; setEditIncome(null); loadDayIncome(d, true); startTransition(() => router.refresh()); }}
        />
      )}
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
          <button type="button" onClick={() => openAdd("income")} className="rounded-md bg-emerald-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-emerald-700">+ เพิ่มรายรับ</button>
          <button type="button" onClick={() => openAdd("expense")} className="rounded-md bg-rose-600 text-white px-3 py-1.5 text-sm font-medium hover:bg-rose-700">+ เพิ่มรายจ่าย</button>
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
        ) : period === "year" ? (
          <div className="text-center min-w-[7rem]">
            <div className="text-4xl font-bold text-slate-800 tracking-tight tabular-nums leading-none">{Number(anchor.slice(0, 4)) + 543}</div>
          </div>
        ) : (
          <div className="text-center">
            <div className="text-2xl font-bold text-slate-800 tracking-tight leading-none whitespace-nowrap">สัปดาห์ที่ {isoWeekNo(dash.start)}</div>
            <div className="text-xs text-slate-500 leading-none mt-1">{weekDateRange(dash.start, dash.end)}</div>
          </div>
        )}
        <button type="button" onClick={() => go(period, shiftAnchor(anchor, period, 1))}
          className="w-9 h-9 rounded-full border border-slate-300 text-slate-500 flex items-center justify-center hover:bg-brand hover:text-white hover:border-brand transition disabled:opacity-40" disabled={pending} aria-label="ถัดไป">→</button>
      </div>

      {/* Hero metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="card py-3">
          <div className="text-[11px] text-slate-400">รายรับ (ยอดขาย)</div>
          <div className="text-2xl font-bold text-emerald-600">฿{fmtMoney(dash.salesRevenue)}</div>
          {dash.financing > 0
            ? <div className="text-[11px] text-sky-600">+ เงินกู้/เงินเข้าอื่น ฿{fmtMoney(dash.financing)}</div>
            : <div className="text-[11px] text-slate-400">เงินเข้าจริง ฿{fmtMoney(dash.cashReceived)}</div>}
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

      {/* Overview chart — period-aware: year → per month, month/week → per day */}
      {(() => {
        const comboPoints: ComboPoint[] = period === "year"
          ? monthly.map((m) => ({
              key: `m${m.month}`, label: String(m.month).padStart(2, "0"),
              revenue: m.revenue, financing: 0, expense: m.expense, profit: m.profit, tip: `${TH_MON_FULL[m.month]} ${trendYear + 543}`
            }))
          : enumerateDays(dash.start, dash.end).map((d) => {
              const r = dayRowMap.get(d);
              return {
                key: d, label: String(Number(d.slice(8, 10))),
                revenue: r?.revenue ?? 0, financing: r?.financing ?? 0, expense: r?.expense ?? 0, profit: r?.net ?? 0, tip: fmtDayLabel(d)
              };
            });
        const chartTitle = period === "year"
          ? `ภาพรวมรายรับและรายจ่าย · ปี ${trendYear + 543}`
          : `ภาพรวมรายรับและรายจ่ายรายวัน · ${dash.label}`;
        return (
          <div className="card space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm font-bold text-slate-800">{chartTitle}</div>
              <div className="flex items-center gap-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />ยอดขาย</span>
                {dash.financing > 0 && <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#38bdf8" }} />เงินกู้/เงินเข้าอื่น</span>}
                <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#f5c97a" }} />รายจ่าย</span>
                <span className="flex items-center gap-1"><span className="w-3.5 h-[3px] rounded bg-indigo-500" />กำไร</span>
              </div>
            </div>
            {chartsReady ? <ComboChart points={comboPoints} /> : <div style={{ height: 136 }} />}
          </div>
        );
      })()}

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
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">ยอดขายต่อบิล (เฉลี่ยเดือนนี้)</div>
          <div className="text-lg font-bold text-slate-800">{dash.salesPerBillMonth != null ? `฿${fmtMoney(dash.salesPerBillMonth)}` : "—"}</div>
          <div className="text-[10px] text-slate-400">ยอดขาย ÷ จำนวนบิล</div>
        </div>
        <div className="card text-center py-3">
          <div className="text-[11px] text-slate-400">ยอดขายต่อบิล (เฉลี่ยปีนี้)</div>
          <div className="text-lg font-bold text-slate-800">{dash.salesPerBillYear != null ? `฿${fmtMoney(dash.salesPerBillYear)}` : "—"}</div>
          <div className="text-[10px] text-slate-400">ทั้งปีปัจจุบัน</div>
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
          <div className="text-sm font-bold text-slate-800">บัญชีรายวัน · เปรียบเทียบรายรับ–รายจ่ายรายวัน</div>
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
                  <th className="text-right py-1.5 px-2">รายรับ (ขาย)</th>
                  <th className="text-right py-1.5 px-2">เงินกู้/เข้าอื่น</th>
                  <th className="text-right py-1.5 px-2">รายจ่าย</th>
                  <th className="text-right py-1.5 px-2">กำไร/ขาดทุนวันนี้</th>
                  <th className="text-right py-1.5 px-2">คงเหลือสะสม (เงินสด)</th>
                </tr>
              </thead>
              <tbody>
                {dash.dailyRows.map((r) => (
                  <Fragment key={r.date}>
                    <tr
                      onClick={() => toggleDay(r.date)}
                      className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${selectedDate === r.date ? "bg-brand/5" : ""}`}>
                      <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">
                        {selectedDate === r.date ? "▾ " : "▸ "}{fmtDayLabel(r.date)}
                      </td>
                      <td className={`py-1.5 px-2 text-right font-mono ${r.revenue > 0 ? "text-emerald-600" : "text-slate-300"}`}>{fmtMoney(r.revenue)}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${r.financing > 0 ? "text-sky-600" : "text-slate-300"}`}>{fmtMoney(r.financing)}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${r.expense > 0 ? "text-rose-600" : "text-slate-300"}`}>{fmtMoney(r.expense)}</td>
                      <td className={`py-1.5 px-2 text-right font-mono ${r.net >= 0 ? "text-slate-700" : "text-rose-600"}`}>{r.net < 0 ? `(${fmtMoney(-r.net)})` : fmtMoney(r.net)}</td>
                      <td className={`py-1.5 px-2 text-right font-mono font-bold ${r.balance >= 0 ? "text-slate-700" : "text-rose-600"}`}>{fmtMoney(r.balance)}</td>
                    </tr>
                    {selectedDate === r.date && (
                      <tr className="bg-brand/5">
                        <td colSpan={6} className="p-0 border-b border-brand/20">
                          <DayDetail
                            date={r.date}
                            rows={incCache[r.date]}
                            loading={incLoading === r.date}
                            err={incErr}
                            expenses={expenses.filter((e) => e.bill_date === r.date)}
                            channels={incomeChannels}
                            categories={expenseCategories}
                            branchId={branchId}
                            companyId={companyId}
                            billCount={r.billCount}
                            draftExpenses={draftExpenses}
                            expenseVendors={expenseVendors}
                            payCycleWeekday={payCycleWeekday}
                            onChanged={() => { loadDayIncome(r.date, true); startTransition(() => router.refresh()); }}
                            removeExpense={remove}
                            onEditExpense={setEditExpense}
                            onEditIncome={setEditIncome}
                            busyExpenseId={busyId}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-200 font-bold">
                  <td className="py-1.5 px-2 text-slate-700">รวมทั้งสิ้น</td>
                  <td className="py-1.5 px-2 text-right font-mono text-emerald-700">฿{fmtMoney(dash.revenue)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-sky-700">฿{fmtMoney(financingTotal)}</td>
                  <td className="py-1.5 px-2 text-right font-mono text-rose-700">฿{fmtMoney(dash.expense)}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${dash.net >= 0 ? "text-slate-800" : "text-rose-600"}`}>{dash.net < 0 ? `(฿${fmtMoney(-dash.net)})` : `฿${fmtMoney(dash.net)}`}</td>
                  <td className={`py-1.5 px-2 text-right font-mono ${runningCashTotal >= 0 ? "text-slate-800" : "text-rose-600"}`}>{runningCashTotal < 0 ? `(฿${fmtMoney(-runningCashTotal)})` : `฿${fmtMoney(runningCashTotal)}`}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

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

      {/* Top spending — per vendor (summed) or biggest individual bills */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-slate-800">รายจ่ายสูงสุด · Top spending</div>
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-[11px]">
            <button type="button" onClick={() => setTopMode("vendor")}
              className={`px-2.5 py-1 rounded-md ${topMode === "vendor" ? "bg-white shadow-sm font-semibold text-slate-700" : "text-slate-500"}`}>รวมตามผู้จำหน่าย</button>
            <button type="button" onClick={() => setTopMode("bill")}
              className={`px-2.5 py-1 rounded-md ${topMode === "bill" ? "bg-white shadow-sm font-semibold text-slate-700" : "text-slate-500"}`}>รายใบ</button>
          </div>
        </div>
        {topExpenses.length === 0 ? (
          <p className="text-xs text-slate-400">ไม่พบรายการรายจ่ายในช่วงเวลานี้</p>
        ) : topMode === "vendor" ? (
          <div className="space-y-1">
            {topVendors.map((v, i) => {
              const pct = topVendors[0].amount > 0 ? (v.amount / topVendors[0].amount) * 100 : 0;
              return (
                <div key={v.vendor} className="w-full flex items-center gap-2 px-1.5 py-1">
                  <span className="w-5 text-xs font-bold text-slate-400 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-700 truncate">{v.vendor}</div>
                    <div className="text-[11px] text-slate-400">{v.count.toLocaleString("en-US")} บิล</div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-rose-300" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                  <span className="font-mono text-sm text-rose-700 shrink-0 text-right">฿{fmtMoney(v.amount)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {topExpenses.map((e, i) => {
              const pct = topExpenses[0].amount_total > 0 ? (e.amount_total / topExpenses[0].amount_total) * 100 : 0;
              return (
                <button type="button" key={e.id} onClick={() => setEditExpense(e)}
                  className="w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 hover:bg-slate-50">
                  <span className="w-5 text-xs font-bold text-slate-400 text-right shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-700 truncate">{e.vendor_name || e.description || e.category || "ไม่ระบุ"}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {fmtDayLabel(e.bill_date)}{e.category ? ` · ${e.category}` : ""}{e.payment_status === "unpaid" ? " · ค้างชำระ" : ""}{e.capex_bucket ? " · " : ""}
                      {e.capex_bucket ? <span className="text-violet-600">FEASIBILITY</span> : null}
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-rose-300" style={{ width: `${Math.min(100, pct)}%` }} />
                    </div>
                  </div>
                  <span className="font-mono text-sm text-rose-700 shrink-0 text-right">฿{fmtMoney(e.amount_total)}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-slate-400">{topMode === "vendor" ? "รวมยอดทั้งช่วงต่อผู้จำหน่าย" : "บิลใหญ่สุดรายใบ · กดเพื่อแก้ไข"}</p>
      </div>

      {/* Direct add modal — date picker, locked to the active branch */}
      {addMode && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget && !aBusy) setAddMode(null); }}>
          <div className="card w-full max-w-md my-8 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-slate-800">{addMode === "income" ? "เพิ่มรายรับ" : "เพิ่มรายจ่าย"}</h3>
              <button type="button" onClick={() => setAddMode(null)} className="text-slate-400 hover:text-slate-700">✕</button>
            </div>
            <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded px-2 py-1">
              บันทึกเข้าสาขา <b>{branchName}</b> (สาขาที่เปิดอยู่) — สลับสาขาที่มุมบนซ้ายหากต้องการบันทึกสาขาอื่น
            </div>
            {aErr && <p className="text-sm text-rose-600">{aErr}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label !text-xs">วันที่</label>
                <input type="date" className="input" value={aDate} onChange={(e) => setADate(e.target.value)} />
              </div>
              {addMode === "income" ? (
                <>
                  <div>
                    <label className="label !text-xs">ช่องทาง</label>
                    <Select value={aChannel} onChange={setAChannel} placeholder="— เลือกช่องทาง —"
                      options={incomeChannels.map((c) => ({ value: c.name, label: c.name }))} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label !text-xs">จำนวนเงิน</label>
                    <input type="text" inputMode="decimal" className="input text-right font-mono" value={aAmt} placeholder="0.00"
                      onChange={(e) => setAAmt(grpMoney(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label !text-xs">ประเภทรายรับ</label>
                    <Select value={aIncKind} onChange={(v) => setAIncKind(v as typeof aIncKind)}
                      options={[
                        { value: "sale_vat", label: "ขาย/บริการ — มี VAT 7%" },
                        { value: "sale_novat", label: "ขาย/บริการ — ยกเว้น VAT" },
                        { value: "financing", label: "เงินกู้/เงินเข้าอื่น — ไม่นับยอดขาย" }
                      ]} />
                    <p className="text-[11px] text-slate-400 mt-0.5">เงินกู้/เงินยืมกรรมการ เลือก “ไม่นับยอดขาย” — เป็นเงินเข้าแต่ไม่รวมในยอดขาย/ภาษี</p>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="label !text-xs">หมวด</label>
                    <Select value={aCategory} onChange={setACategory} placeholder="— เลือกหมวด —"
                      options={expenseCategories.map((c) => ({ value: c.name, label: c.code ? `${c.code} · ${c.name}` : c.name }))} />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label !text-xs">ผู้จำหน่าย / รายการ</label>
                    <Combobox value={aVendor} onChange={setAVendor} options={vendorOptions(expenseVendors)}
                      placeholder="พิมพ์ชื่อหรือเลขผู้เสียภาษี" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="label !text-xs">จำนวนเงิน</label>
                    <input type="text" inputMode="decimal" className="input text-right font-mono" value={aAmt} placeholder="0.00"
                      onChange={(e) => setAAmt(grpMoney(e.target.value))} onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }} />
                  </div>
                  <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={aVat} onChange={(e) => setAVat(e.target.checked)} />มี VAT</label>
                  <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={aUnpaid} onChange={(e) => setAUnpaid(e.target.checked)} />ค้างชำระ</label>
                  {aUnpaid && (
                    <div className="sm:col-span-2">
                      <label className="label !text-xs">ครบกำหนดชำระ</label>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select value={aDueMode} onChange={(v) => setADueMode(v as "cycle" | "date")}
                          className="!w-auto !min-w-[12rem]"
                          options={[
                            { value: "cycle", label: `ตามรอบบริษัท (ทุกวัน${WEEKDAY_TH[payCycleWeekday]})` },
                            { value: "date", label: "ระบุวันเอง" }
                          ]} />
                        {aDueMode === "date" ? (
                          <input type="date" value={aDueDate} onChange={(e) => setADueDate(e.target.value)} className="input !w-auto" />
                        ) : (
                          <span className="text-xs text-slate-500">→ {fmtDayLabel(nextPayDate(aDate, payCycleWeekday))}</span>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={() => setAddMode(null)} className="btn-secondary" disabled={aBusy}>ยกเลิก</button>
              <button type="button" onClick={submitAdd} className="btn-primary disabled:opacity-50" disabled={aBusy || !aAmt}>
                {aBusy ? "กำลังบันทึก…" : "บันทึก"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
