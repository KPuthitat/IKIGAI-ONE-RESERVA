"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import OwlMascot from "@/app/components/OwlMascot";
import ClinicaSection, { type ClinicaMonth } from "./ClinicaSection";

// REPORTA dashboard (owner 2026-09-16): import the POS files, review the day's
// deep analytics + menu ranking, and push the summary card to the HOD LINE group
// (daily) or the weekly rollup (Mon–Sun). Send is PIN-gated.

const TH_MONTHS = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
const baht = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intTh = (n: number) => n.toLocaleString("th-TH");

function thaiDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${TH_MONTHS[m]} ${y + 543}`;
}
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function todayBkk(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

type MonthDay = { date: string; nett: number; billCount: number; pax: number; hasSales: boolean; hasMenu: boolean; hasReceipt?: boolean; dailySentAt: string | null };
type MenuRank = { name: string; nett: number; rank: number; units?: number | null };
type MtdMetric = { key: string; label: string; kind: "baht" | "int"; value: number; prev: number | null; pct: number | null };
type DailyAnalytics = {
  date: string; dateLabel: string;
  row: {
    nett: number; gross: number; discount: number; service_charge: number; vat: number;
    bill_count: number; pax: number; void_amount: number; void_bill_count: number; refund: number;
    avg_sales: number; avg_pax: number; avg_sales_pax: number;
    payments: Array<{ name: string; qty: number; total: number }>;
    types: Array<{ name: string; qty: number; sales: number }>;
    has_sales: number; has_menu: number; daily_sent_at: string | null;
  };
  discountPct: number | null; voidPct: number | null;
  weekdayTh: string; dom: number; wowLabel: string; momLabel: string;
  wowHasData: boolean; momHasData: boolean;
  metrics: MetricCompare[];
  topItems: MenuRank[]; bottomItems: MenuRank[]; topCategories: MenuRank[];
  peakHour: number | null; advice: string[];
};
type MetricCompare = { key: string; label: string; value: number; kind: "baht" | "int"; wowPct: number | null; momPct: number | null };
type MonthCompare = { throughDay: number; mtdNett: number; prevMonthNett: number | null; prevMonthPct: number | null; lastYearNett: number | null; lastYearPct: number | null; trend?: MtdMetric[] };
type MenuMomentum = { name: string; thisNett: number; prevNett: number; deltaPct: number | null; isNew: boolean };
type WeeklyAnalytics = {
  weekStart: string; weekEnd: string; label: string;
  days: Array<{ date: string; dateLabel: string; nett: number; billCount: number; pax: number }>;
  dayCount: number; totalNett: number; totalBills: number; totalPax: number; totalDiscount: number;
  avgPerDay: number | null; avgPerBill: number | null; bestDate: string | null; bestNett: number | null;
  prevWeekDays: number; prevWeekNett: number | null; wowNettPct: number | null; wowBillsPct: number | null; wowPaxPct: number | null;
  topItems: MenuRank[]; topCategories: MenuRank[];
  menuRisers: MenuMomentum[]; menuFallers: MenuMomentum[];
};
type WeekdayStat = { dow: number; label: string; avgNett: number; days: number; avgBills: number };
type DiscountInsight = { avgDiscountPct: number | null; totalDiscount: number; highDiscAvgNett: number | null; lowDiscAvgNett: number | null; days: number };
type ChannelSlice = { name: string; sales: number; qty: number; pct: number; avgTicket: number | null };
type ChannelMix = { types: ChannelSlice[]; payments: ChannelSlice[]; sources: ChannelSlice[] };
type MenuClass = { name: string; nett: number; units: number | null; deltaPct: number | null; isNew: boolean };
type Insights = {
  menuEngineering: { stars: MenuClass[]; plowhorses: MenuClass[]; puzzles: MenuClass[]; dogs: MenuClass[]; medianNett: number };
  beverage: { total: number; beverageNett: number; beveragePct: number; dessertNett: number; dessertPct: number; foodNett: number; foodPct: number; bevToFoodPct: number | null };
  concentration: { itemCount: number; total: number; top5Pct: number | null; countFor80: number };
  guests: { avgPartySize: number | null; avgSpendPerHead: number | null; prevPartySize: number | null; partyMomPct: number | null; prevSpendPerHead: number | null; spendMomPct: number | null };
  rhythm: { paydayAvgNett: number | null; otherAvgNett: number | null; paydayLiftPct: number | null; paydayDays: number; weekendAvgNett: number | null; weekdayAvgNett: number | null; weekendLiftPct: number | null };
  quality: { voidAmount: number; voidBillCount: number; refund: number; voidRatePct: number | null; voidBillRatePct: number | null; prevVoidRatePct: number | null; flag: boolean };
  receipt: {
    hasData: boolean; peakHour: number | null;
    hourly: Array<{ hour: number; bills: number; nett: number }>;
    topUnits: Array<{ name: string; units: number; bills: number }>;
    bottomUnits: Array<{ name: string; units: number; bills: number }>;
    basket: Array<{ a: string; b: string; count: number }>;
  };
};
type InsightRange = { period: "month" | "week"; start: string; end: string; rangeLabel: string; prevLabel: string; nowLabel: string };
type PushMenu = { name: string; nett: number };
type PushDay = { date: string; label: string; weekdayTh: string; expectedNett: number | null };
type SalesPushPlan = {
  targetBaht: number; days: number; fromDate: string; toDate: string;
  requiredPerDay: number; baselineProjected: number; baselinePerDay: number; recentAvgPerDay: number;
  gap: number; liftPct: number | null; hasBaseline: boolean;
  avgTicket: number | null; avgBillsPerDay: number | null; extraBillsPerDay: number | null; extraTicketBaht: number | null;
  topEarners: PushMenu[]; risers: PushMenu[]; bevPct: number | null; bevToFoodPct: number | null;
  crossSell: Array<{ a: string; b: string; count: number }>;
  upcoming: PushDay[]; strongestDate: string | null;
  verdict: "no_data" | "easy" | "ontrack" | "stretch" | "hard" | "unrealistic";
  verdictText: string; advice: string[];
};
type MonthTarget = { target: number; mtdNett: number; throughDay: number; daysInMonth: number; pctOfTarget: number; projectedNett: number; projectedPct: number; onTrack: boolean };
type Annual = { year: number; annualTarget: number; fullYearTarget: number; prorated: boolean; openedIso: string | null; ytdNett: number; pctOfTarget: number; projectedNett: number; projectedPct: number; onTrack: boolean; throughDate: string; branchCount: number };
type OutlookBenchmark = { label: string; expected: number; avgPerDay: number; monthsUsed?: number };
type RemainingOutlook = { year: number; month: number; todayDom: number; remainingDays: number; windowStartDom: number; windowEndDom: number; mtdNett: number; prevMonth: OutlookBenchmark | null; avg3: OutlookBenchmark | null };
type ExpenseCategoryRow = { name: string; spent: number; pctOfSales: number | null };
type ExpenseAnalysis = { month: string; salesNett: number; expenseTotal: number; expensePrev: number | null; expensePrevPct: number | null; expenseToSalesPct: number | null; netProxy: number; categories: ExpenseCategoryRow[] };
type TodayCol = { date: string; headcount: number; ftCount: number; ptCount: number; otherCount: number; laborCost: number; salesNett: number | null; colPct: number | null };
// Festival / important-day analysis (owner 2026-09-20): each วันสำคัญ × each branch.
type FestivalCell = { branchId: number; branchName: string; sales: number | null; monthAvg: number | null; upliftPct: number | null };
type FestivalRow = { date: string; dateLabel: string; nameTh: string; branches: FestivalCell[] };
type FestivalData = { year: number; branches: Array<{ id: number; name: string }>; rows: FestivalRow[] };
// Full-year growth bars (owner 2026-09-21): per branch, monthly nett across the year.
type YearBar = { branchId: number; branchName: string; months: Array<number | null>; total: number; growthPct: number | null; peakMonth: number | null };
type YearBarsData = { year: number; monthCount: number; branches: YearBar[] };
// Full-year DAILY bars (owner 2026-09-21): one bar per day across the year.
type DayBar = { branchId: number; branchName: string; values: Array<number | null>; total: number; peakIdx: number | null; lowIdx: number | null; avgPerDay: number | null };
type DayBarsData = { year: number; dayCount: number; startIso: string; branches: DayBar[] };
// Menu-name merging (owner 2026-09-20): similar spellings that might be one dish.
type NameStat = { nett: number; units: number };
type MergeSuggestion = { a: string; b: string; score: number; reason: "exact" | "contains" | "fuzzy"; aStats: NameStat; bStats: NameStat };
type MergeGroup = { root: string; members: string[]; label: string };
type MonthlyAnalytics = {
  year: number; month: number; ym: string; label: string; dayCount: number;
  totalNett: number; revshareIncome: number; totalBills: number; totalPax: number; totalDiscount: number;
  avgPerDay: number | null; avgPerBill: number | null; bestDate: string | null; bestNett: number | null;
  prevMonthNett: number | null; prevMonthPct: number | null; lastYearNett: number | null; lastYearPct: number | null;
  topItems: MenuRank[]; topCategories: MenuRank[];
};

/** Modern rounded ← [eyebrow / label] → stepper, shared by the day/week/month
 *  card headers so every "top of the box" navigator looks the same and never
 *  wraps its label on mobile (owner 2026-09-20). */
function NavStepper({ eyebrow, label, onPrev, onNext, prevDisabled, nextDisabled, prevTitle, nextTitle }: {
  eyebrow: string; label: string; onPrev: () => void; onNext: () => void;
  prevDisabled?: boolean; nextDisabled?: boolean; prevTitle?: string; nextTitle?: string;
}) {
  const btn = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-white hover:text-slate-800 hover:shadow-sm disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:shadow-none transition";
  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50/60 p-1">
      <button type="button" onClick={onPrev} disabled={prevDisabled} title={prevTitle} aria-label={prevTitle} className={btn}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 6l-6 6 6 6" /></svg>
      </button>
      <div className="px-2 text-center leading-tight min-w-[8.5rem]">
        <div className="text-[9px] uppercase tracking-[1.5px] text-slate-400">{eyebrow}</div>
        <div className="font-bold text-slate-800 text-[14px]">{label}</div>
      </div>
      <button type="button" onClick={onNext} disabled={nextDisabled} title={nextTitle} aria-label={nextTitle} className={btn}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" /></svg>
      </button>
    </div>
  );
}

function MenuList({ title, list, muted }: { title: string; list: MenuRank[]; muted?: boolean }) {
  if (!list.length) return null;
  return (
    <div>
      <div className={`text-xs font-bold mb-1 ${muted ? "text-slate-500" : "text-emerald-800"}`}>{title}</div>
      <ol className="space-y-1">
        {list.map((m, i) => (
          <li key={m.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-700 truncate">{i + 1}. {m.name}</span>
            <span className="text-slate-900 font-medium whitespace-nowrap">
              {m.units != null && <span className="text-slate-400 font-normal">{intTh(m.units)} ครั้ง · </span>}{baht(m.nett)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Preview + PIN → confirm send. */
function PinModal({ title, preview, onConfirm, onClose }: { title: string; preview?: ReactNode; onConfirm: (pin: string) => Promise<{ ok: boolean; message?: string }>; onClose: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!/^\d{4}$/.test(pin)) { setErr("PIN ต้องเป็นตัวเลข 4 หลัก"); return; }
    setSending(true); setErr(null);
    const r = await onConfirm(pin);
    setSending(false);
    if (!r.ok) setErr(r.message ?? "ส่งไม่สำเร็จ");
    else onClose();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3 max-h-[90vh] overflow-y-auto">
        <h3 className="font-bold text-slate-800">{title}</h3>
        {preview && (
          <div>
            <p className="text-xs text-slate-400 mb-1.5">ตัวอย่างการ์ดที่จะส่งเข้ากลุ่ม LINE</p>
            <div className="rounded-xl overflow-hidden shadow-sm border border-slate-100">{preview}</div>
          </div>
        )}
        <p className="text-sm text-slate-500">ยืนยันด้วย PIN เพื่อส่งรายงานผู้บริหารเข้ากลุ่ม LINE</p>
        <div>
          <label className="label text-center">PIN (4 หลัก)</label>
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            className="input text-center tracking-[0.6em] text-lg" />
        </div>
        {err && <p className="text-rose-600 text-xs font-medium">✗ {err === "wrong_pin" || err === "pin_invalid" ? "PIN ไม่ถูกต้อง" : err === "no_pin" ? "ยังไม่ได้ตั้ง PIN (ตั้งที่หน้าโปรไฟล์)" : err}</p>}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} className="flex-1 py-2.5 rounded-lg border border-slate-200 text-sm font-semibold text-slate-600">ยกเลิก</button>
          <button type="button" onClick={submit} disabled={sending || pin.length < 4} className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold disabled:opacity-50">{sending ? "กำลังส่ง…" : "ยืนยันส่ง"}</button>
        </div>
      </div>
    </div>
  );
}

export default function ReportaClient({ branchName, operatorName, defaultColor }: { branchName: string; operatorName: string; defaultColor: string }) {
  const initial = todayBkk();
  const [year, setYear] = useState(Number(initial.slice(0, 4)));
  const [month, setMonth] = useState(Number(initial.slice(5, 7)));
  const [days, setDays] = useState<MonthDay[]>([]);
  const [monthCompare, setMonthCompare] = useState<MonthCompare | null>(null);
  const [weekdays, setWeekdays] = useState<WeekdayStat[]>([]);
  const [discount, setDiscount] = useState<DiscountInsight | null>(null);
  const [channels, setChannels] = useState<ChannelMix | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [panelPeriod, setPanelPeriod] = useState<"month" | "week">("month");
  const [insightRange, setInsightRange] = useState<InsightRange | null>(null);
  const [monthTarget, setMonthTarget] = useState<MonthTarget | null>(null);
  const [annual, setAnnual] = useState<Annual | null>(null);
  const [remainingOutlook, setRemainingOutlook] = useState<RemainingOutlook | null>(null);
  const [expenseAnalysis, setExpenseAnalysis] = useState<ExpenseAnalysis | null>(null);
  const [todayCol, setTodayCol] = useState<TodayCol | null>(null);
  const [clinica, setClinica] = useState<ClinicaMonth | null>(null);
  const [revshareIncome, setRevshareIncome] = useState(0);   // ส่วนแบ่งยอดขาย this month
  const [monthSentAt, setMonthSentAt] = useState<string | null>(null);
  const [pushDays, setPushDays] = useState(3);
  const [pushTarget, setPushTarget] = useState("");
  // Staffing planner assumptions (owner 2026-09-20): labor cost target % of sales
  // and monthly cost per head. Default 15% / ฿15,000 → every ฿100k of sales funds
  // ~1 head. Adjustable on the fly.
  const [laborPct, setLaborPct] = useState(15);
  const [perHeadCost, setPerHeadCost] = useState(15000);
  const [plan, setPlan] = useState<SalesPushPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [hasLineGroup, setHasLineGroup] = useState(true);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailyAnalytics | null>(null);
  const [weekStart, setWeekStart] = useState<string>(mondayOf(addDays(initial, -7)));
  const [weekly, setWeekly] = useState<WeeklyAnalytics | null>(null);
  const [weeklySentAt, setWeeklySentAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAllDays, setShowAllDays] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [pin, setPin] = useState<null | { title: string; preview?: ReactNode; run: (pin: string) => Promise<{ ok: boolean; message?: string }> }>(null);
  const [cardColor, setCardColor] = useState(defaultColor);
  const fileRef = useRef<HTMLInputElement>(null);
  // Menu-name merging (owner 2026-09-20).
  const [mergeSuggestions, setMergeSuggestions] = useState<MergeSuggestion[]>([]);
  const [mergeGroups, setMergeGroups] = useState<MergeGroup[]>([]);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [showMerged, setShowMerged] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);   // collapsed by default (owner 2026-09-21)
  // Festival / important-day analysis (owner 2026-09-20) — lazy-loaded on expand.
  const [festOpen, setFestOpen] = useState(false);
  const [festYear, setFestYear] = useState(Number(initial.slice(0, 4)));
  const [festData, setFestData] = useState<FestivalData | null>(null);
  const festReqRef = useRef(0);
  const [festBusy, setFestBusy] = useState(false);
  // Full-year growth bars (owner 2026-09-21) — shown by default (owner 2026-09-21).
  const [ybOpen, setYbOpen] = useState(true);
  const [ybYear, setYbYear] = useState(Number(initial.slice(0, 4)));
  const [ybData, setYbData] = useState<YearBarsData | null>(null);
  const ybReqRef = useRef(0);
  const [ybBusy, setYbBusy] = useState(false);
  // Full-year DAILY bars (owner 2026-09-21) — shown by default (owner 2026-09-21).
  const [dbOpen, setDbOpen] = useState(true);
  const [dbYear, setDbYear] = useState(Number(initial.slice(0, 4)));
  const [dbData, setDbData] = useState<DayBarsData | null>(null);
  const dbReqRef = useRef(0);
  const [dbBusy, setDbBusy] = useState(false);
  const [picked, setPicked] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const xlsx = Array.from(list).filter((f) => /\.xlsx?$/i.test(f.name));
    if (xlsx.length) setPicked((prev) => [...prev, ...xlsx].filter((f, i, a) => a.findIndex((g) => g.name === f.name && g.size === f.size) === i));
  };

  // Accepts an explicit year/month so a caller can reload a specific month even
  // when it equals the current state (setState-to-same-value doesn't re-fire the
  // load effect) — e.g. importing another day of the month already on screen.
  const loadMonth = useCallback(async (y: number = year, m: number = month) => {
    const r = await fetch(`/api/admin/reporta/view?year=${y}&month=${m}&period=${panelPeriod}`, { cache: "no-store" }).then((x) => x.json());
    if (r.ok) {
      setDays(r.view.days); setHasLineGroup(r.hasLineGroup); setMonthCompare(r.monthCompare ?? null);
      setWeekdays(r.weekdays ?? []); setDiscount(r.discount ?? null); setChannels(r.channels ?? null);
      setMonthTarget(r.monthTarget ?? null); setAnnual(r.annual ?? null); setRevshareIncome(r.revshareIncome ?? 0); setMonthSentAt(r.monthSentAt ?? null); setInsights(r.insights ?? null);
      setInsightRange(r.insightRange ?? null);
      setRemainingOutlook(r.remainingOutlook ?? null);
      setExpenseAnalysis(r.expenseAnalysis ?? null);
      setTodayCol(r.todayCol ?? null);
      setClinica(r.clinica ?? null);
      if (r.cardColor) setCardColor(r.cardColor);
    }
  }, [year, month, panelPeriod]);

  const loadDay = useCallback(async (date: string) => {
    setSelDate(date); setDaily(null);
    const r = await fetch(`/api/admin/reporta/view?date=${date}`, { cache: "no-store" }).then((x) => x.json());
    if (r.ok) { setDaily(r.daily); if (r.cardColor) setCardColor(r.cardColor); } else setMsg({ kind: "err", text: r.message ?? "โหลดข้อมูลวันไม่สำเร็จ" });
  }, []);

  const loadWeek = useCallback(async (ws: string) => {
    const r = await fetch(`/api/admin/reporta/view?week=${ws}`, { cache: "no-store" }).then((x) => x.json());
    if (r.ok) { setWeekly(r.weekly); setWeeklySentAt(r.weeklySentAt); }
  }, []);

  // Menu-name merging (owner 2026-09-20): pull the possible-duplicate suggestions
  // and the already-merged groups. Best-effort — never blocks the dashboard.
  const loadMerges = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/reporta/menu-aliases", { cache: "no-store" }).then((x) => x.json());
      if (r.ok) { setMergeSuggestions(r.suggestions ?? []); setMergeGroups(r.groups ?? []); }
    } catch { /* ignore */ }
  }, []);

  // Apply a merge decision, then refresh both the suggestions and the analytics
  // (numbers change once names fold together). The POST returns fresh state.
  const decideMerge = async (
    body: { action: "merge"; names: string[] } | { action: "ignore"; a: string; b: string } | { action: "unmerge"; root: string }
  ) => {
    setMergeBusy(true);
    try {
      const r = await fetch("/api/admin/reporta/menu-aliases", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }).then((x) => x.json());
      if (r.ok) {
        setMergeSuggestions(r.suggestions ?? []); setMergeGroups(r.groups ?? []);
        // Fold takes effect across every view — refresh what's on screen.
        await loadMonth();
        await loadWeek(weekStart);
        if (selDate) await loadDay(selDate);
        if (body.action === "merge") setMsg({ kind: "ok", text: "รวมเป็นเมนูเดียวแล้ว · ยอดถูกนับรวมกันทุกหน้า" });
        else if (body.action === "unmerge") setMsg({ kind: "ok", text: "ยกเลิกการรวมแล้ว" });
      } else {
        setMsg({ kind: "err", text: r.message ?? r.error ?? "ทำรายการไม่สำเร็จ" });
      }
    } catch { setMsg({ kind: "err", text: "ทำรายการไม่สำเร็จ" }); }
    setMergeBusy(false);
  };

  // Festival analysis (owner 2026-09-20): fetched only when the panel is opened
  // or its year changes — it's a cross-branch yearly query, not needed on every
  // dashboard render.
  const loadFestivals = useCallback(async (y: number) => {
    const seq = ++festReqRef.current;
    setFestBusy(true);
    try {
      const r = await fetch(`/api/admin/reporta/view?festivals=1&year=${y}`, { cache: "no-store" }).then((x) => x.json());
      if (seq !== festReqRef.current) return; // a newer year request superseded this one
      if (r.ok) setFestData(r.festivals);
    } catch { /* ignore */ } finally {
      if (seq === festReqRef.current) setFestBusy(false);
    }
  }, []);
  const toggleFestivals = () => {
    const next = !festOpen;
    setFestOpen(next);
    if (next && (!festData || festData.year !== festYear)) loadFestivals(festYear);
  };
  const stepFestYear = (delta: number) => {
    const y = festYear + delta;
    setFestYear(y);
    if (festOpen) loadFestivals(y);
  };

  // Full-year growth bars (owner 2026-09-21) — lazy, cross-branch yearly query.
  const loadYearBars = useCallback(async (y: number) => {
    const seq = ++ybReqRef.current;
    setYbBusy(true);
    try {
      const r = await fetch(`/api/admin/reporta/view?yearbars=1&year=${y}`, { cache: "no-store" }).then((x) => x.json());
      if (seq !== ybReqRef.current) return;
      if (r.ok) setYbData(r.yearbars);
    } catch { /* ignore */ } finally {
      if (seq === ybReqRef.current) setYbBusy(false);
    }
  }, []);
  const toggleYearBars = () => {
    const next = !ybOpen;
    setYbOpen(next);
    if (next && (!ybData || ybData.year !== ybYear)) loadYearBars(ybYear);
  };
  const stepYbYear = (delta: number) => {
    const y = ybYear + delta;
    setYbYear(y);
    if (ybOpen) loadYearBars(y);
  };

  // Full-year DAILY bars (owner 2026-09-21) — lazy, ~365-bar yearly query.
  const loadDailyBars = useCallback(async (y: number) => {
    const seq = ++dbReqRef.current;
    setDbBusy(true);
    try {
      const r = await fetch(`/api/admin/reporta/view?dailybars=1&year=${y}`, { cache: "no-store" }).then((x) => x.json());
      if (seq !== dbReqRef.current) return;
      if (r.ok) setDbData(r.dailybars);
    } catch { /* ignore */ } finally {
      if (seq === dbReqRef.current) setDbBusy(false);
    }
  }, []);
  const toggleDailyBars = () => {
    const next = !dbOpen;
    setDbOpen(next);
    if (next && (!dbData || dbData.year !== dbYear)) loadDailyBars(dbYear);
  };
  const stepDbYear = (delta: number) => {
    const y = dbYear + delta;
    setDbYear(y);
    if (dbOpen) loadDailyBars(y);
  };

  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => { loadWeek(weekStart); }, [weekStart, loadWeek]);
  useEffect(() => { loadMerges(); }, [loadMerges]);
  // The full-year growth + daily charts are open by default (owner 2026-09-21),
  // so load them once on mount rather than waiting for a toggle.
  useEffect(() => { loadYearBars(ybYear); loadDailyBars(dbYear); }, [loadYearBars, loadDailyBars]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Default the day-analysis to the latest day that has data whenever the month
  // loads/changes — the analysis sits at the top now, so the owner shouldn't
  // have to pick a day first (owner 2026-09-19).
  useEffect(() => {
    if (!days.length) return;
    if (selDate && days.some((d) => d.date === selDate)) return;
    const withSales = [...days].reverse().find((d) => d.hasSales);
    const pick = (withSales ?? days[days.length - 1]).date;
    loadDay(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  // Re-run all analytics (owner 2026-09-19: ปุ่มวิเคราะห์อีกครั้ง after importing
  // more data). Everything is computed server-side per GET, so this re-fetches.
  const reanalyze = async () => {
    setAnalyzing(true); setMsg(null);
    await loadMonth();
    await loadWeek(weekStart);
    if (selDate) await loadDay(selDate);
    await loadMerges();   // re-check for newly similar menu names
    setAnalyzing(false);
    setMsg({ kind: "ok", text: "วิเคราะห์ใหม่จากข้อมูลล่าสุดแล้ว" });
  };

  // Step the day-analysis to the adjacent day that has data (days[] is ascending).
  const dayIdx = selDate ? days.findIndex((d) => d.date === selDate) : -1;
  const gotoDay = (delta: number) => {
    if (dayIdx < 0) return;
    const j = dayIdx + delta;
    if (j < 0 || j >= days.length) return;
    loadDay(days[j].date);
  };

  // Period-aware labels for the insight panels (owner 2026-09-18 สัปดาห์/เดือน).
  const nowLabel = insightRange?.nowLabel ?? "เดือนนี้";
  const prevLabel = insightRange?.prevLabel ?? "เทียบเดือนก่อน";
  const prevWord = insightRange?.period === "week" ? "สัปดาห์ก่อน" : "เดือนก่อน";

  const sendImport = async (files: File[]) => {
    if (!files.length) { setMsg({ kind: "err", text: "เลือกไฟล์ก่อน" }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/admin/reporta/import", { method: "POST", body: fd }).then((x) => x.json());
      if (!r.ok) { setMsg({ kind: "err", text: r.message ?? r.error ?? "นำเข้าไม่สำเร็จ" }); }
      else {
        // Duplicate-file guard (owner 2026-09-19): warn when an import replaced
        // data that already existed for that day+type.
        const kindTh = (k: string) => k === "close_up" ? "ยอดขาย" : k === "overview" ? "เมนู" : "ใบเสร็จ";
        const dup = (r.imported as Array<{ date: string; kind: string; overwritten?: boolean }>).filter((x) => x.overwritten);
        if (dup.length) {
          const list = dup.map((x) => `${thaiDate(x.date)} (${kindTh(x.kind)})`).join(", ");
          setMsg({ kind: "warn", text: `นำเข้าไฟล์สำเร็จ · ⚠️ ทับข้อมูลเดิม ${dup.length} รายการ — ${list}` });
        } else {
          setMsg({ kind: "ok", text: "นำเข้าไฟล์สำเร็จ" });
        }
        setPicked([]);
        if (fileRef.current) fileRef.current.value = "";
        loadMerges();   // a new file may introduce a renamed spelling to reconcile
        // Jump the whole page to the imported file's month, so the list, weekly
        // and insights follow the data just added — not whatever month was open
        // (owner 2026-09-19: import August → show August, not September).
        const dates = (r.imported as Array<{ date: string }>).map((x) => x.date).filter(Boolean).sort();
        const target = dates[dates.length - 1];
        if (target) {
          const ty = Number(target.slice(0, 4)), tm = Number(target.slice(5, 7));
          setYear(ty);
          setMonth(tm);
          setWeekStart(mondayOf(target));
          setSelDate(target);
          // Reload the target month/week EXPLICITLY — setState to the same month
          // doesn't re-fire the load effect, so the day list would otherwise stay
          // stale (owner 2026-09-20: uploaded day 20 but list still showed 19).
          await loadMonth(ty, tm);
          await loadWeek(mondayOf(target));
          await loadDay(target);
        } else {
          await loadMonth();
          await loadWeek(weekStart);
        }
      }
    } catch { setMsg({ kind: "err", text: "อัปโหลดผิดพลาด" }); }
    setBusy(false);
  };
  const upload = () => sendImport(picked);
  // One-at-a-time import: pick a single .xlsx and import it immediately.
  const oneRef = useRef<HTMLInputElement>(null);
  const quickOne = (list: FileList | null) => {
    const f = list && list[0];
    if (oneRef.current) oneRef.current.value = "";
    if (f) sendImport([f]);
  };

  const del = async (date: string) => {
    if (!confirm(`ลบข้อมูลยอดขาย + เมนูของวันที่ ${thaiDate(date)} ?`)) return;
    setBusy(true);
    const r = await fetch("/api/admin/reporta/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date }) }).then((x) => x.json());
    setBusy(false);
    if (r.ok) { setMsg({ kind: "ok", text: `ลบข้อมูลวันที่ ${thaiDate(date)} แล้ว` }); if (selDate === date) { setSelDate(null); setDaily(null); } await loadMonth(); await loadWeek(weekStart); }
    else setMsg({ kind: "err", text: r.message ?? "ลบไม่สำเร็จ" });
  };

  const clearMismatched = async () => {
    if (!confirm("ลบทุกวันที่ชื่อร้านในไฟล์ไม่ตรงกับสาขานี้ (ข้อมูลที่นำเข้าผิดสาขา) ?")) return;
    setBusy(true); setMsg(null);
    const r = await fetch("/api/admin/reporta/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "mismatched" }) }).then((x) => x.json());
    setBusy(false);
    if (r.ok) {
      setMsg({ kind: "ok", text: r.removed > 0 ? `ลบข้อมูลที่ร้านไม่ตรงกับสาขาแล้ว ${r.removed} วัน` : "ไม่พบข้อมูลที่ร้านไม่ตรงกับสาขา" });
      setSelDate(null); setDaily(null); await loadMonth(); await loadWeek(weekStart);
    } else setMsg({ kind: "err", text: r.message ?? "ลบไม่สำเร็จ" });
  };

  const sendDaily = (date: string) => setPin({
    title: `ส่งสรุปยอดขายวันที่ ${thaiDate(date)}`,
    preview: daily && daily.date === date ? <DailyPreview a={daily} branchName={branchName} operator={operatorName} color={cardColor} /> : undefined,
    run: async (p) => {
      const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "daily", date, pin: p }) }).then((x) => x.json());
      if (r.ok) { setMsg({ kind: "ok", text: "ส่งรายงานผู้บริหาร (รายวัน) แล้ว" }); await loadMonth(); if (selDate === date) await loadDay(date); }
      return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
    }
  });

  const sendWeekly = (ws: string) => setPin({
    title: `ส่งสรุปสัปดาห์ ${weekly?.label ?? ""}`,
    preview: weekly && weekly.weekStart === ws ? <WeeklyPreview w={weekly} branchName={branchName} operator={operatorName} color={cardColor} /> : undefined,
    run: async (p) => {
      const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "weekly", week: ws, pin: p }) }).then((x) => x.json());
      if (r.ok) { setMsg({ kind: "ok", text: "ส่งรายงานผู้บริหาร (รายสัปดาห์) แล้ว" }); await loadWeek(ws); }
      return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
    }
  });

  const sendMonthly = async (y: number, m: number) => {
    // Fetch the monthly rollup so the modal can preview the exact card.
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const pv = await fetch(`/api/admin/reporta/view?monthly=${ym}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    const monthly: MonthlyAnalytics | null = pv?.ok ? pv.monthly : null;
    setPin({
      title: `ส่งสรุปเดือน ${TH_MONTHS[m]} ${y + 543}`,
      preview: monthly ? <MonthlyPreview m={monthly} branchName={branchName} operator={operatorName} color={cardColor} /> : undefined,
      run: async (p) => {
        const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "monthly", year: y, month: m, pin: p }) }).then((x) => x.json());
        if (r.ok) { setMsg({ kind: "ok", text: "ส่งรายงานผู้บริหาร (รายเดือน) แล้ว" }); await loadMonth(); }
        return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
      }
    });
  };

  // แผนดันยอด — น้องฮูกแนะนำ (owner 2026-09-18).
  const runPush = async () => {
    const target = Math.floor(Number(pushTarget.replace(/[, ]/g, "")) || 0);
    if (!pushDays || !target) { setMsg({ kind: "err", text: "กรอกจำนวนวันและยอดเป้าหมายก่อน" }); return; }
    setPlanBusy(true); setMsg(null);
    const r = await fetch(`/api/admin/reporta/view?push=1&days=${pushDays}&target=${target}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    setPlanBusy(false);
    if (r?.ok) setPlan(r.plan);
    else setMsg({ kind: "err", text: r?.message ?? "วางแผนไม่สำเร็จ" });
  };

  const sendPush = () => {
    if (!plan) return;
    setPin({
      title: `ส่งรายงานผู้บริหาร (แผนผลักดันยอดขาย ${plan.days} วัน)`,
      preview: <PushPreview plan={plan} branchName={branchName} operator={operatorName} color={cardColor} />,
      run: async (p) => {
        const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "push", days: plan.days, target: plan.targetBaht, pin: p }) }).then((x) => x.json());
        if (r.ok) setMsg({ kind: "ok", text: "ส่งรายงานผู้บริหารแล้ว" });
        return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
      }
    });
  };

  const shiftMonth = (delta: number) => {
    let y = year, m = month + delta;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    setYear(y); setMonth(m);
  };

  return (
    // Cap the single column to a comfortable reading width and center it, so the
    // dashboard doesn't sprawl across a wide desktop; full width on mobile
    // (owner 2026-09-22 — UX/UI ให้เหมาะกับอุปกรณ์).
    <div className="space-y-4 max-w-5xl mx-auto w-full">
      {!hasLineGroup && (
        <div className="card bg-amber-50 border-amber-200 text-sm text-amber-800">
          ⚠️ ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน — ปุ่มส่งสรุปจะยังใช้ไม่ได้ · <a href="/admin/reporta/settings" className="underline font-semibold">ไปตั้งค่า</a>
        </div>
      )}
      {msg && (
        <div className={`card text-sm ${msg.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : msg.kind === "warn" ? "bg-amber-50 border-amber-200 text-amber-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>{msg.text}</div>
      )}

      {/* Import — modern drop zone */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800">นำเข้าไฟล์จาก POS</h2>
          <span className="text-[11px] text-slate-400">รองรับ .xlsx · นำเข้าทีละไฟล์ หรือหลายไฟล์พร้อมกันก็ได้</span>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx" multiple className="hidden"
          onChange={(e) => addFiles(e.target.files)} />
        <input ref={oneRef} type="file" accept=".xlsx" className="hidden"
          onChange={(e) => quickOne(e.target.files)} />
        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          className={`cursor-pointer rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
            dragOver ? "border-emerald-400 bg-emerald-50" : "border-slate-200 bg-slate-50/60 hover:border-emerald-300 hover:bg-emerald-50/40"
          }`}
        >
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </div>
          <div className="text-sm font-semibold text-slate-700">ลากไฟล์มาวางที่นี่ หรือ <span className="text-emerald-600 underline">เลือกไฟล์</span></div>
          <div className="mt-1 text-xs text-slate-400">ไฟล์ <b>Close up</b> (ยอดขาย) · <b>Overview</b> (เมนู) · <b>Receipt</b> (ใบเสร็จ) — ระบบแยกประเภทและวันที่ให้เอง จะนำเข้าทีละไฟล์หรือพร้อมกันก็ได้</div>
        </div>

        {/* One-at-a-time: pick a single file and import it immediately. */}
        <button type="button" onClick={() => oneRef.current?.click()} disabled={busy}
          className="w-full rounded-xl border border-emerald-200 bg-emerald-50/60 py-2.5 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
          {busy ? "กำลังนำเข้า…" : "＋ นำเข้าทีละไฟล์ (เลือก 1 ไฟล์ นำเข้าทันที)"}
        </button>

        {picked.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {picked.map((f, i) => (
              <span key={f.name + i} className="inline-flex items-center gap-1.5 rounded-full bg-white border border-slate-200 pl-3 pr-1.5 py-1 text-xs text-slate-600 shadow-sm">
                <span className="truncate max-w-[220px]">📄 {f.name}</span>
                <button type="button" onClick={() => setPicked((prev) => prev.filter((_, j) => j !== i))}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700">✕</button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={upload} disabled={busy || picked.length === 0}
            className="btn-primary text-sm disabled:opacity-50">{busy ? "กำลังนำเข้า…" : `นำเข้า${picked.length ? ` (${picked.length})` : ""}`}</button>
          {picked.length > 0 && !busy && (
            <button onClick={() => setPicked([])} className="text-xs text-slate-400 hover:text-slate-600">ล้างรายการ</button>
          )}
          <span className="flex-1" />
          <button onClick={clearMismatched} disabled={busy} className="text-xs text-rose-500 hover:text-rose-700 disabled:opacity-50">ลบข้อมูลที่ร้านไม่ตรงกับสาขา</button>
        </div>
      </div>

      {/* Month browser — sits right under the upload box (owner 2026-09-20) with
          the per-day list collapsed by default, so managing/picking days is close
          to where you import; month header + target progress + monthly send stay. */}
      <div className="card space-y-3">
        <div className="flex items-center justify-center">
          <NavStepper eyebrow="เดือน" label={`${TH_MONTHS[month]} ${year + 543}`}
            onPrev={() => shiftMonth(-1)} onNext={() => shiftMonth(1)}
            prevTitle="เดือนก่อน" nextTitle="เดือนถัดไป" />
        </div>

        {/* Month-level cumulative comparisons (owner 2026-09-17). */}
        {monthCompare && monthCompare.throughDay > 0 && (
          <div className="rounded-xl bg-slate-50 p-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-slate-500">ยอดสะสมต้นเดือน (ถึงวันที่ {monthCompare.throughDay})</span>
              <span className="text-lg font-bold text-emerald-700">{baht(monthCompare.mtdNett + revshareIncome)}</span>
            </div>
            {revshareIncome > 0 && <div className="text-[10px] text-violet-600 -mt-1">รวมส่วนแบ่งยอดขายรายเดือน {baht(revshareIncome)} (นอก POS)</div>}
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
              <span>เทียบเดือนก่อน (ช่วงเดียวกัน · POS) <PctChip pct={monthCompare.prevMonthPct} /></span>
              <span>เทียบปีก่อน (เดือนเดียวกัน · POS) <PctChip pct={monthCompare.lastYearPct} /></span>
            </div>

            {/* Monthly target progress (owner C) */}
            {monthTarget && (
              <div className="pt-2 mt-1 border-t border-slate-200 space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-slate-500">เป้าเดือนนี้ {baht(monthTarget.target)}</span>
                  <span className={`font-bold ${monthTarget.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}`}>{monthTarget.pctOfTarget.toFixed(0)}% ของเป้า</span>
                </div>
                <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
                  <div className={`h-full ${monthTarget.pctOfTarget >= 100 ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, monthTarget.pctOfTarget)}%` }} />
                </div>
                <div className="text-[11px] text-slate-500">
                  คาดการณ์สิ้นเดือน <b className={monthTarget.onTrack ? "text-emerald-600" : "text-amber-600"}>{baht(monthTarget.projectedNett)}</b> ({monthTarget.projectedPct.toFixed(0)}% ของเป้า) · {monthTarget.onTrack ? "มีแนวโน้มถึงเป้า ✓" : "ต่ำกว่าเป้า ต้องเร่ง"}
                </div>
              </div>
            )}
            {!monthTarget && (
              <div className="text-[11px] text-slate-400 pt-1">ยังไม่ได้ตั้งเป้ายอดขาย — ตั้งได้ที่ ⚙️ ตั้งค่ากลุ่ม LINE</div>
            )}

            {/* Full-year projection (owner 2026-09-20): annual target = monthly × 12,
                prorated to the branch's open span if it opened mid-year (owner
                2026-09-21: ไฮโปเปิด 25/07 เป้าทั้งปีต้องคิดจากวันที่ available จริง). */}
            {annual && (
              <div className="pt-2 mt-1 border-t border-slate-200 space-y-1">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="text-slate-500">เป้าทั้งปี {annual.year + 543} · {baht(annual.annualTarget)}</span>
                  <span className={`font-bold ${annual.pctOfTarget >= 100 ? "text-emerald-600" : "text-slate-700"}`}>{annual.pctOfTarget.toFixed(0)}% ของเป้า</span>
                </div>
                {annual.prorated && (
                  <div className="text-[11px] text-slate-400">
                    คิดตามวันที่เปิดจริง{annual.openedIso ? ` (${thaiDate(annual.openedIso)})` : ""} — ไม่ใช่ทั้งปีเต็ม (เต็มปี {baht(annual.fullYearTarget)})
                  </div>
                )}
                <div className="h-2.5 rounded-full bg-slate-200 overflow-hidden">
                  <div className={`h-full ${annual.pctOfTarget >= 100 ? "bg-emerald-500" : "bg-emerald-400"}`} style={{ width: `${Math.min(100, annual.pctOfTarget)}%` }} />
                </div>
                <div className="text-[11px] text-slate-500">
                  YTD {baht(annual.ytdNett)} · คาดสิ้นปี <b className={annual.onTrack ? "text-emerald-600" : "text-amber-600"}>{baht(annual.projectedNett)}</b> ({annual.projectedPct.toFixed(0)}% ของเป้า) · {annual.onTrack ? "มีแนวโน้มถึงเป้าทั้งปี ✓" : "ต่ำกว่าเป้าทั้งปี ต้องเร่ง"}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Clinic (CLINICA) deep-dive — only for a branch with imported HIS data. */}
        {clinica?.hasData && <ClinicaSection c={clinica} />}

        {/* Today's COL snapshot (owner 2026-09-26): who's in today (FT/PT), the
            day's labour cost, and its % of today's sales. Payroll-view only, so
            the server sends it only to those accounts. */}
        {todayCol && (
          <div className="card space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold text-slate-800">ต้นทุนแรงงานวันนี้ · COL</h2>
              <span className="text-[11px] text-slate-400">{thaiDate(todayCol.date)}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-[11px] text-slate-500">พนักงานเข้างาน</div>
                <div className="text-lg font-bold text-slate-800 tabular-nums">{todayCol.headcount} คน</div>
                <div className="text-[10px] text-slate-400">ประจำ {todayCol.ftCount} · พาร์ทไทม์ {todayCol.ptCount}{todayCol.otherCount > 0 ? ` · อื่นๆ ${todayCol.otherCount}` : ""}</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">ต้นทุนแรงงาน</div>
                <div className="text-lg font-bold text-rose-600 tabular-nums">{baht(todayCol.laborCost)}</div>
                <div className="text-[10px] text-slate-400">บาท/วัน</div>
              </div>
              <div>
                <div className="text-[11px] text-slate-500">COL% ของยอดขาย</div>
                <div className="text-lg font-bold text-slate-800 tabular-nums">{todayCol.colPct != null ? `${todayCol.colPct}%` : "—"}</div>
                <div className="text-[10px] text-slate-400">ยอดวันนี้ {todayCol.salesNett != null ? baht(todayCol.salesNett) : "—"}</div>
              </div>
            </div>
            <p className="text-[10px] text-slate-400">
              คิดจากชั่วโมงที่ลงเวลาจริง × ค่าจ้าง (พาร์ทไทม์ รายชม. · ประจำ เงินเดือน÷22÷8) · คนที่ยังทำงานอยู่คิดถึงตอนนี้ · นับเฉพาะพนักงานจริง (ไม่รวมบัญชีทดสอบ/ลาออก)
            </p>
          </div>
        )}

        {/* Remaining-days-of-month outlook (owner 2026-09-26): how much the tail
            of the month usually brings, vs the same window last month and the
            3-month average — a heads-up for what's still to come. */}
        {remainingOutlook && (remainingOutlook.prevMonth || remainingOutlook.avg3) && (
          <div className="card space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold text-slate-800">ยอดที่เหลือของเดือน</h2>
              <span className="text-[11px] text-slate-500">
                อีก {remainingOutlook.remainingDays} วัน (วันที่ {remainingOutlook.windowStartDom}–{remainingOutlook.windowEndDom})
              </span>
            </div>
            <p className="text-[11px] text-slate-500">
              คาดการณ์ยอดของวันที่เหลือ อิงช่วงท้ายเดือน (จำนวนวันเท่ากัน) ของเดือนก่อน และค่าเฉลี่ย 3 เดือนล่าสุด
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[remainingOutlook.prevMonth, remainingOutlook.avg3]
                .filter((b): b is OutlookBenchmark => b != null)
                .map((b) => (
                  <div key={b.label} className="rounded-xl border border-slate-200 p-3">
                    <div className="text-xs font-semibold text-slate-600">
                      {b.label}{b.monthsUsed != null && b.monthsUsed < 3 ? ` (${b.monthsUsed} เดือน)` : ""}
                    </div>
                    <div className="text-lg font-bold text-emerald-700">{baht(b.expected)}</div>
                    <div className="text-[11px] text-slate-500">
                      คาดยอดวันที่เหลือ · เฉลี่ย {baht(b.avgPerDay)}/วัน
                    </div>
                  </div>
                ))}
            </div>
            <div className="text-[11px] text-slate-500">
              เดือนนี้ทำได้แล้ว {baht(remainingOutlook.mtdNett)} (ถึงวันที่ {remainingOutlook.todayDom})
            </div>
          </div>
        )}

        {/* Expense analysis from ACCOUNTA (owner 2026-09-26): the viewed month's
            confirmed spend beside sales — total + MoM, cost/sales ratio, a rough
            sales−cost figure, and the biggest categories. */}
        {expenseAnalysis && expenseAnalysis.expenseTotal > 0 && (
          <div className="card space-y-2">
            <h2 className="font-bold text-slate-800">รายจ่าย (ACCOUNTA)</h2>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-slate-500">รายจ่ายรวมเดือนนี้ (ตามบิล)</span>
              <span className="text-lg font-bold text-rose-600">{baht(expenseAnalysis.expenseTotal)}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              เทียบเดือนก่อน {expenseAnalysis.expensePrev != null ? baht(expenseAnalysis.expensePrev) : "—"}
              {expenseAnalysis.expensePrevPct != null && ` (${expenseAnalysis.expensePrevPct > 0 ? "+" : ""}${expenseAnalysis.expensePrevPct}%)`}
            </div>
            {expenseAnalysis.expenseToSalesPct != null && (
              <div className="text-[11px] text-slate-600">
                คิดเป็น <b>{expenseAnalysis.expenseToSalesPct}%</b> ของยอดขาย ({baht(expenseAnalysis.salesNett)})
              </div>
            )}
            <div className="text-[11px] text-slate-500">
              ยอดขาย − รายจ่าย ≈ <b className={expenseAnalysis.netProxy >= 0 ? "text-emerald-700" : "text-rose-600"}>{baht(expenseAnalysis.netProxy)}</b>
              <span className="text-slate-400"> (คร่าวๆ ยังไม่รวมภาษี/รายการอื่น)</span>
            </div>
            {expenseAnalysis.categories.length > 0 && (
              <div className="pt-1.5 border-t border-slate-200 space-y-1">
                <div className="text-[11px] font-semibold text-slate-600">หมวดที่จ่ายมากสุด</div>
                {expenseAnalysis.categories.map((c) => (
                  <div key={c.name} className="flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="text-slate-600 truncate">{c.name || "ไม่ระบุหมวด"}</span>
                    <span className="text-slate-700 tabular-nums whitespace-nowrap">
                      {baht(c.spent)}{c.pctOfSales != null ? ` · ${c.pctOfSales}%` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Monthly summary send button (owner F) — enabled ONLY when every day of
            the month is fully imported (all 3 file types), so a partial month
            can't be sent (owner 2026-09-21: ส่งได้เฉพาะเมื่อนำเข้าไฟล์ครบทั้งเดือน).
            Counts only ELAPSED days: a past month needs the whole month; the
            current month needs every day up to today — so future days aren't
            counted as "missing" and the button un-locks once you're caught up. */}
        {days.length > 0 && (() => {
          const dim = new Date(year, month, 0).getDate();  // days in the viewed month
          const [ty, tm, td] = todayBkk().split("-").map(Number);
          const elapsed = (year > ty || (year === ty && month > tm)) ? 0        // future month: nothing due yet
            : (year === ty && month === tm) ? td                                 // current month: through today
            : dim;                                                               // past month: the whole month
          const missing = Math.max(0, elapsed - days.length) + days.filter((d) => !(d.hasSales && d.hasMenu && d.hasReceipt)).length;
          const monthComplete = elapsed > 0 && missing === 0;
          return (
            <div className="flex items-center justify-end gap-2 flex-wrap">
              {monthSentAt && <span className="text-xs text-emerald-600">✓ ส่งสรุปเดือนแล้ว</span>}
              {!monthComplete && <span className="text-xs text-amber-600">นำเข้าไฟล์ให้ครบทั้งเดือนก่อนส่ง (ขาด {missing} วัน)</span>}
              <button onClick={() => sendMonthly(year, month)} disabled={!hasLineGroup || !monthComplete}
                title={!monthComplete ? "นำเข้าไฟล์ให้ครบทั้งเดือนก่อน" : undefined}
                className="btn-success text-sm px-4 py-2 disabled:opacity-50 w-full sm:w-auto">
                {monthSentAt ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
              </button>
            </div>
          );
        })()}

        {days.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลในเดือนนี้ — นำเข้าไฟล์ด้านบน</p>
        ) : (
          <>
            {/* Missing-file summary for the month (owner 2026-09-18) — always shown. */}
            {(() => {
              const inc = days.filter((d) => !(d.hasSales && d.hasMenu && d.hasReceipt));
              if (!inc.length) return <div className="text-xs text-emerald-600">✓ ทุกวันในเดือนนี้ลงไฟล์ครบทั้ง 3 ชนิดแล้ว</div>;
              const miss = (pred: (d: MonthDay) => boolean) => days.filter(pred).length;
              return (
                <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  มี <b>{inc.length}</b> วันที่ลงไฟล์ไม่ครบ —
                  {miss((d) => !d.hasSales) > 0 && <> ขาดยอดขาย {miss((d) => !d.hasSales)} วัน</>}
                  {miss((d) => !d.hasMenu) > 0 && <> · ขาดเมนู {miss((d) => !d.hasMenu)} วัน</>}
                  {miss((d) => !d.hasReceipt) > 0 && <> · ขาดใบเสร็จ {miss((d) => !d.hasReceipt)} วัน</>}
                </div>
              );
            })()}
            {/* Per-day list collapsed by default (owner 2026-09-19). */}
            <button type="button" onClick={() => setShowAllDays((v) => !v)}
              className="w-full flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
              <span>รายวันทั้งเดือน ({days.length} วัน)</span>
              <span className="text-slate-400">{showAllDays ? "ซ่อน ▲" : "ดูรายวัน ▼"}</span>
            </button>
            {showAllDays && (
              <div className="divide-y divide-slate-100">
                {days.map((d) => (
                  <div key={d.date} className={`flex items-center justify-between gap-2 py-2 cursor-pointer ${selDate === d.date ? "bg-emerald-50 -mx-2 px-2 rounded" : ""}`} onClick={() => loadDay(d.date)}>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800">{thaiDate(d.date)}</div>
                      <div className="text-xs text-slate-500">
                        {d.hasSales ? `${intTh(d.billCount)} บิล · ${intTh(d.pax)} คน` : "ยังไม่มียอดขาย"}
                        {d.dailySentAt ? " · ✓ ส่งแล้ว" : ""}
                      </div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        <FileChip label="ยอดขาย" present={d.hasSales} />
                        <FileChip label="เมนู" present={d.hasMenu} />
                        <FileChip label="ใบเสร็จ" present={d.hasReceipt} />
                      </div>
                    </div>
                    <div className="text-right whitespace-nowrap">
                      <div className="text-sm font-bold text-slate-900">{d.hasSales ? baht(d.nett) : "—"}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Day analysis — moved to the top (owner 2026-09-19: บทวิเคราะห์ขึ้นบน) */}
      {selDate && daily && (
        <div className="card space-y-4">
          <div className="flex items-center justify-center sm:justify-between gap-3 flex-wrap">
            <NavStepper eyebrow="สรุปยอดขายรายวัน" label={daily.dateLabel}
              onPrev={() => gotoDay(-1)} onNext={() => gotoDay(1)}
              prevDisabled={dayIdx <= 0} nextDisabled={dayIdx < 0 || dayIdx >= days.length - 1}
              prevTitle="วันก่อนหน้า" nextTitle="วันถัดไป" />
            <div className="flex items-center gap-2">
              {daily.row.has_sales === 1 && (
                <button onClick={() => sendDaily(daily.date)} disabled={!hasLineGroup}
                  className="inline-flex items-center gap-1.5 btn-success text-sm px-4 py-2 disabled:opacity-50">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>
                  {daily.row.daily_sent_at ? "ส่งอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
                </button>
              )}
              <button onClick={() => del(daily.date)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600 transition"
                title="ลบข้อมูลของวันนี้" aria-label="ลบ">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m1 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /></svg>
              </button>
            </div>
          </div>

          {daily.advice.length > 0 && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
              <div className="text-xs font-bold mb-1" style={{ color: cardColor }}>สรุป &amp; คำแนะนำ</div>
              <ul className="space-y-1">
                {daily.advice.map((line, i) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-700">
                    <span style={{ color: cardColor }}>•</span><span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {daily.row.has_sales === 1 ? (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {daily.metrics.map((m) => (
                  <Kpi key={m.key}
                    label={m.label}
                    value={m.kind === "baht" ? baht(m.value) : m.key === "bills" ? `${intTh(m.value)} บิล` : m.key === "pax" ? `${intTh(m.value)} คน` : intTh(m.value)}
                    accent={m.key === "nett"}
                    wowPct={m.wowPct} momPct={m.momPct} wowLabel={daily.wowLabel} momLabel={daily.momLabel} />
                ))}
                <Kpi label="ส่วนลด" value={`${baht(Math.abs(daily.row.discount))}${daily.discountPct != null ? ` (${daily.discountPct.toFixed(1)}%)` : ""}`} />
                <Kpi label="ยกเลิกบิล (Void)" value={`${baht(daily.row.void_amount)} · ${intTh(daily.row.void_bill_count)}`} />
                <Kpi label="VAT / Service" value={`${baht(daily.row.vat)} / ${baht(daily.row.service_charge)}`} />
              </div>

              {(daily.row.payments.length > 0 || daily.row.types.length > 0) && (
                <div className="grid sm:grid-cols-2 gap-4">
                  {daily.row.payments.length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-slate-600 mb-1">ช่องทางชำระเงิน</div>
                      {daily.row.payments.map((p) => (
                        <div key={p.name} className="flex justify-between text-sm"><span className="text-slate-600">{p.name} · {intTh(p.qty)}</span><span className="font-medium">{baht(p.total)}</span></div>
                      ))}
                    </div>
                  )}
                  {daily.row.types.filter((t) => t.qty > 0 || t.sales > 0).length > 0 && (
                    <div>
                      <div className="text-xs font-bold text-slate-600 mb-1">ประเภทออเดอร์</div>
                      {daily.row.types.filter((t) => t.qty > 0 || t.sales > 0).map((t) => (
                        <div key={t.name} className="flex justify-between text-sm"><span className="text-slate-600">{t.name} · {intTh(t.qty)}</span><span className="font-medium">{baht(t.sales)}</span></div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-amber-700">วันนี้ยังไม่ได้นำเข้าไฟล์ยอดขาย (Close up)</p>
          )}

          {(daily.topItems.length > 0 || daily.topCategories.length > 0) ? (
            <div className="grid sm:grid-cols-2 gap-4 pt-1">
              <MenuList title="เมนูทำรายได้สูงสุด" list={daily.topItems} />
              <MenuList title="หมวดทำรายได้สูงสุด" list={daily.topCategories} />
              <MenuList title="เมนูทำรายได้น้อยสุด (ในรายการที่มี)" list={daily.bottomItems} muted />
            </div>
          ) : (
            <p className="text-sm text-slate-400">ยังไม่มีไฟล์เมนู (Overview) ของวันนี้ — นำเข้าเพื่อดูเมนูทำรายได้สูงสุด/น้อยสุด</p>
          )}
        </div>
      )}

      {/* Weekly */}
      <div className="card space-y-3">
        <div className="flex items-center justify-center sm:justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800">สรุปรายสัปดาห์ (จันทร์–อาทิตย์)</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <NavStepper eyebrow="สัปดาห์" label={weekly?.label ?? "—"}
              onPrev={() => setWeekStart(addDays(weekStart, -7))} onNext={() => setWeekStart(addDays(weekStart, 7))}
              prevTitle="สัปดาห์ก่อนหน้า" nextTitle="สัปดาห์ถัดไป" />
            <button type="button" onClick={() => setWeekStart(mondayOf(todayBkk()))}
              className="text-xs font-semibold text-slate-500 hover:text-slate-800 rounded-full border border-slate-200 px-3 py-2 hover:bg-slate-50 transition">
              สัปดาห์นี้
            </button>
            {/* Send-to-execs stays on the top line next to the week stepper (owner 2026-09-21). */}
            {weekly && (
              <button onClick={() => sendWeekly(weekly.weekStart)} disabled={!hasLineGroup || weekly.dayCount === 0} className="btn-success text-sm px-4 py-2 disabled:opacity-50">
                {weeklySentAt ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
              </button>
            )}
          </div>
        </div>
        {weekly && (
          <>
            <div className="text-sm text-slate-600">{weekly.label} · รวม {weekly.dayCount} วัน {weeklySentAt ? "· ✓ ส่งแล้ว" : ""}</div>
            {weekly.dayCount === 0 ? (
              <p className="text-sm text-slate-400">ยังไม่มีข้อมูลยอดขายในสัปดาห์นี้</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <Kpi label="ยอดขายรวมสัปดาห์" value={baht(weekly.totalNett)} accent />
                  <Kpi label="จำนวนบิลรวม" value={`${intTh(weekly.totalBills)} บิล`} />
                  <Kpi label="ลูกค้ารวม" value={`${intTh(weekly.totalPax)} คน`} />
                  <Kpi label="เฉลี่ยต่อวัน" value={weekly.avgPerDay != null ? baht(weekly.avgPerDay) : "—"} />
                </div>
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 flex flex-wrap gap-x-6 gap-y-1">
                  <span className="font-semibold text-slate-700">เทียบสัปดาห์ก่อน:</span>
                  {weekly.wowNettPct == null ? (
                    <span className="text-slate-400">ยังไม่มีข้อมูลสัปดาห์ก่อน</span>
                  ) : (
                    <>
                      <span>ยอดขาย <PctChip pct={weekly.wowNettPct} /> {weekly.prevWeekNett != null && <span className="text-slate-400">({baht(weekly.prevWeekNett)})</span>}</span>
                      <span>บิล <PctChip pct={weekly.wowBillsPct} /></span>
                      <span>ลูกค้า <PctChip pct={weekly.wowPaxPct} /></span>
                    </>
                  )}
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-bold text-slate-600 mb-1">ยอดขายรายวัน</div>
                    {weekly.days.map((d) => (
                      <div key={d.date} className={`flex justify-between text-sm ${d.date === weekly.bestDate ? "font-bold text-emerald-700" : ""}`}>
                        <span className="text-slate-600">{d.dateLabel}{d.date === weekly.bestDate ? "" : ""}</span><span>{baht(d.nett)}</span>
                      </div>
                    ))}
                  </div>
                  <MenuList title="เมนูทำรายได้สูงสุดประจำสัปดาห์" list={weekly.topItems} />
                </div>
                {(weekly.menuRisers.length > 0 || weekly.menuFallers.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <MomentumList title="เมนูมาแรง (เทียบสัปดาห์ก่อน)" list={weekly.menuRisers} up />
                    <MomentumList title="เมนูร่วง (เทียบสัปดาห์ก่อน)" list={weekly.menuFallers} />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Analytics period toggle (owner 2026-09-18): view the insight panels for
          this month or the current ISO week. */}
      {days.length > 0 && (
        <div className="flex items-end justify-center sm:justify-between gap-2 flex-wrap pt-1">
          <div>
            <h2 className="font-bold text-slate-800">การวิเคราะห์ภาพรวม (เชิงลึก)</h2>
            {insightRange && <p className="text-xs text-slate-500 mt-0.5">ช่วง{nowLabel}: {insightRange.rangeLabel}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={reanalyze} disabled={analyzing}
              className="btn-secondary text-sm px-3 py-1.5 disabled:opacity-50" title="ดึงข้อมูลล่าสุดมาวิเคราะห์ใหม่">
              {analyzing ? "กำลังวิเคราะห์…" : "↻ วิเคราะห์อีกครั้ง"}
            </button>
            <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
              {(["month", "week"] as const).map((p) => (
                <button key={p} type="button" onClick={() => setPanelPeriod(p)}
                  className={`px-3 py-1 rounded-md transition ${panelPeriod === p ? "bg-white shadow-sm font-semibold text-slate-800" : "text-slate-500 hover:text-slate-700"}`}>
                  {p === "month" ? "เดือนนี้" : "สัปดาห์นี้"}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Menu-name merging (owner 2026-09-20): when the POS shows a dish under a
          new spelling, offer to fold it into the original so sales aren't split
          and double-counted. Non-blocking — the owner confirms each pair. */}
      {(mergeSuggestions.length > 0 || mergeGroups.length > 0) && (
        <div className="card space-y-3">
          <button type="button" onClick={() => setMergeOpen((o) => !o)} className="w-full flex items-center justify-between gap-2 text-left">
            <div>
              <h2 className="font-bold text-slate-800">ชื่อเมนูที่อาจเป็นตัวเดียวกัน{mergeSuggestions.length > 0 ? ` (${mergeSuggestions.length})` : ""}</h2>
              <p className="text-xs text-slate-500 mt-0.5">ถ้ามีการตั้งชื่อใหม่ ระบบจะถามเพื่อรวมยอดให้เป็นเมนูเดียว จะได้ไม่ถูกนับแยกกัน</p>
            </div>
            <span className="text-slate-400 text-sm shrink-0">{mergeOpen ? "▲ ซ่อน" : "▼ ดู"}</span>
          </button>

          {mergeOpen && mergeGroups.length > 0 && (
            <div className="flex justify-end">
              <button type="button" onClick={() => setShowMerged((s) => !s)} className="text-sm text-brand hover:underline shrink-0">
                {showMerged ? "ซ่อนที่รวมแล้ว" : `รวมแล้ว ${mergeGroups.length} รายการ`}
              </button>
            </div>
          )}

          {mergeOpen && (mergeSuggestions.length === 0 ? (
            <p className="text-sm text-slate-400">ตอนนี้ไม่พบชื่อเมนูที่อาจซ้ำกัน</p>
          ) : (
            <ul className="space-y-2">
              {mergeSuggestions.map((s) => (
                <li key={`${s.a}|${s.b}`} className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div className="text-sm text-slate-700 min-w-0">
                      <div className="font-semibold text-slate-800 break-words">{s.a} <span className="font-normal text-slate-400">↔</span> {s.b}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5 break-words">
                        {s.a}: {baht(s.aStats.nett)} · {intTh(s.aStats.units)} ครั้ง — {s.b}: {baht(s.bStats.nett)} · {intTh(s.bStats.units)} ครั้ง
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" disabled={mergeBusy} onClick={() => decideMerge({ action: "merge", names: [s.a, s.b] })}
                        className="btn-primary text-xs px-3 py-1.5 disabled:opacity-50">รวมเป็นเมนูเดียว</button>
                      <button type="button" disabled={mergeBusy} onClick={() => decideMerge({ action: "ignore", a: s.a, b: s.b })}
                        className="btn-secondary text-xs px-3 py-1.5 disabled:opacity-50">คนละเมนู</button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ))}

          {mergeOpen && showMerged && mergeGroups.length > 0 && (
            <div className="pt-2 border-t border-slate-100 space-y-2">
              <div className="text-xs font-semibold text-slate-500">เมนูที่รวมแล้ว</div>
              {mergeGroups.map((g) => (
                <div key={g.root} className="flex items-center justify-between gap-2">
                  <div className="text-sm text-slate-700 break-words min-w-0">{g.label}</div>
                  <button type="button" disabled={mergeBusy} onClick={() => decideMerge({ action: "unmerge", root: g.root })}
                    className="text-xs text-slate-500 hover:text-rose-600 shrink-0">ยกเลิกรวม</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Festival / important-day analysis (owner 2026-09-20): which วันสำคัญ lift
          each branch's sales, for planning next year's festivals. Lazy-loaded,
          cross-branch (super_admin) or active branch. Independent of the month
          view — it's a whole-year, cross-branch panel — so not gated on `days`. */}
      {(
        <div className="card">
          <button type="button" onClick={toggleFestivals} className="w-full flex items-center justify-between gap-2 text-left">
            <div>
              <h2 className="font-bold text-slate-800">วันสำคัญ / เทศกาล — เทียบยอดขายแต่ละสาขา</h2>
              <p className="text-xs text-slate-500 mt-0.5">ดูว่าวันสำคัญไหนดันยอดขายของแต่ละสาขา เพื่อวางแผนรับมือเทศกาลในปีถัดไป</p>
            </div>
            <span className="text-slate-400 text-sm shrink-0">{festOpen ? "▲ ซ่อน" : "▼ ดู"}</span>
          </button>
          {festOpen && (
            <div className="mt-3 space-y-3">
              <NavStepper eyebrow="ปี" label={`${festYear + 543}`}
                onPrev={() => stepFestYear(-1)} onNext={() => stepFestYear(1)} nextDisabled={festYear >= Number(todayBkk().slice(0, 4))} />
              {festBusy ? (
                <p className="text-sm text-slate-400 text-center py-4">กำลังโหลด…</p>
              ) : !festData || festData.rows.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลยอดขายในวันสำคัญของปีนี้</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="text-xs text-slate-500 border-b border-slate-200">
                        <th className="text-left py-2 pr-3">วันสำคัญ</th>
                        {festData.branches.map((b) => <th key={b.id} className="text-right py-2 px-2 whitespace-nowrap">{b.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {festData.rows.map((row) => (
                        <tr key={row.date} className="border-b border-slate-100 align-top">
                          <td className="py-2 pr-3">
                            <div className="font-medium text-slate-800">{row.nameTh}</div>
                            <div className="text-[11px] text-slate-400">{row.dateLabel}</div>
                          </td>
                          {row.branches.map((c) => (
                            <td key={c.branchId} className="py-2 px-2 text-right">
                              {c.sales == null ? <span className="text-slate-300">—</span> : (
                                <>
                                  <div className="font-semibold text-slate-700 tabular-nums">{baht(c.sales)}</div>
                                  {c.upliftPct != null && (
                                    <div className={`text-[11px] font-medium ${c.upliftPct > 0 ? "text-emerald-600" : c.upliftPct < 0 ? "text-rose-500" : "text-slate-400"}`}>
                                      {c.upliftPct > 0 ? `▲ +${c.upliftPct}` : c.upliftPct < 0 ? `▼ ${c.upliftPct}` : `± 0`}%
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[11px] text-slate-400 mt-2">▲/▼ = ยอดวันนั้นเทียบกับยอดขายเฉลี่ยต่อวันของสาขาในเดือนเดียวกัน · แสดงเฉพาะวันสำคัญที่มีข้อมูลแล้ว</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Full-year growth bars (owner 2026-09-21): each branch's monthly nett
          across the year (ม.ค.→ธ.ค.), so the growth trend is visible once a full
          year is imported. Lazy-loaded, cross-branch or active branch. */}
      {(
        <div className="card">
          <button type="button" onClick={toggleYearBars} className="w-full flex items-center justify-between gap-2 text-left">
            <div>
              <h2 className="font-bold text-slate-800">เทรนด์การเติบโตทั้งปี — รายเดือนแต่ละสาขา</h2>
              <p className="text-xs text-slate-500 mt-0.5">กราฟแท่งยอดขายสุทธิรายเดือนของแต่ละสาขา ดูการเติบโตตลอดทั้งปี</p>
            </div>
            <span className="text-slate-400 text-sm shrink-0">{ybOpen ? "▲ ซ่อน" : "▼ ดู"}</span>
          </button>
          {ybOpen && (
            <div className="mt-3 space-y-4">
              <NavStepper eyebrow="ปี" label={`${ybYear + 543}`}
                onPrev={() => stepYbYear(-1)} onNext={() => stepYbYear(1)} nextDisabled={ybYear >= Number(todayBkk().slice(0, 4))} />
              {ybBusy ? (
                <p className="text-sm text-slate-400 text-center py-4">กำลังโหลด…</p>
              ) : !ybData || ybData.branches.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลยอดขายในปีนี้</p>
              ) : (
                <div className="space-y-5">
                  {ybData.branches.map((b) => {
                    const peak = Math.max(1, ...b.months.map((v) => v ?? 0));
                    return (
                      <div key={b.branchId}>
                        <div className="flex items-baseline justify-between gap-2 mb-1">
                          <span className="text-sm font-semibold text-slate-800">{b.branchName}</span>
                          <span className="text-xs text-slate-500">
                            รวม {baht(b.total)}
                            {b.growthPct != null && (
                              <span className={`ml-2 font-medium ${b.growthPct > 0 ? "text-emerald-600" : b.growthPct < 0 ? "text-rose-500" : "text-slate-400"}`}>
                                {b.growthPct > 0 ? `▲ +${b.growthPct}%` : b.growthPct < 0 ? `▼ ${b.growthPct}%` : "± 0%"}
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="flex items-end gap-1 h-24">
                          {b.months.map((v, i) => (
                            <div key={i} className="flex-1 flex flex-col items-center justify-end h-full"
                              title={`${TH_MONTHS[i + 1]}: ${v == null ? "ไม่มีข้อมูล" : baht(v)}`}>
                              <div className={`w-full rounded-t ${b.peakMonth === i + 1 ? "bg-emerald-500" : "bg-emerald-300"}`}
                                style={{ height: v == null ? "0%" : `${Math.max(2, (v / peak) * 100)}%` }} />
                            </div>
                          ))}
                        </div>
                        <div className="flex gap-1 mt-1">
                          {b.months.map((_, i) => (
                            <div key={i} className="flex-1 text-center text-[9px] text-slate-400">{i + 1}</div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[11px] text-slate-400">แท่ง = ยอดขายสุทธิรายเดือน (เลข 1–12 = เดือน) · เขียวเข้ม = เดือนที่ยอดสูงสุด · % = เทียบเดือนแรก↔เดือนล่าสุดที่มีข้อมูล</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Full-year DAILY bars (owner 2026-09-21): one bar per calendar day
          (~365) per branch, for a fine-grained view of the whole year. Lazy. */}
      {(
        <div className="card">
          <button type="button" onClick={toggleDailyBars} className="w-full flex items-center justify-between gap-2 text-left">
            <div>
              <h2 className="font-bold text-slate-800">ยอดขายรายวัน — ทั้งปี</h2>
              <p className="text-xs text-slate-500 mt-0.5">กราฟแท่งยอดขายสุทธิรายวันของแต่ละสาขา หนึ่งแท่งต่อหนึ่งวัน (ทั้งปี ~365 แท่ง)</p>
            </div>
            <span className="text-slate-400 text-sm shrink-0">{dbOpen ? "▲ ซ่อน" : "▼ ดู"}</span>
          </button>
          {dbOpen && (
            <div className="mt-3 space-y-4">
              <NavStepper eyebrow="ปี" label={`${dbYear + 543}`}
                onPrev={() => stepDbYear(-1)} onNext={() => stepDbYear(1)} nextDisabled={dbYear >= Number(todayBkk().slice(0, 4))} />
              {dbBusy ? (
                <p className="text-sm text-slate-400 text-center py-4">กำลังโหลด…</p>
              ) : !dbData || dbData.branches.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลยอดขายในปีนี้</p>
              ) : (() => {
                // Thai label for a day index (0 = Jan 1 of the chart's year).
                // Precompute each day's Thai label ONCE (not per bar per render) —
                // the droplet is small and this panel draws ~365 bars per branch.
                const dayLabels: string[] = [];
                for (let i = 0; i < dbData.dayCount; i++) {
                  const d = new Date(Date.UTC(dbData.year, 0, 1) + i * 86_400_000);
                  dayLabels.push(`${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth() + 1]}`);
                }
                // Month label segments, each flex-weighted by its day count so the
                // labels line up under the equal-width daily bars.
                const monthSegs: Array<{ m: number; days: number }> = [];
                let remaining = dbData.dayCount;
                for (let m = 1; m <= 12 && remaining > 0; m++) {
                  const dim = new Date(Date.UTC(dbData.year, m, 0)).getUTCDate();
                  const days = Math.min(dim, remaining);
                  monthSegs.push({ m, days });
                  remaining -= days;
                }
                // Don't squeeze a year into the screen (owner 2026-09-21): give
                // each day a fixed width and let the chart scroll left↔right. The
                // content is centered (mx-auto) when it's narrower than the card.
                const DAY_PX = 7;          // width of one day column (bar + gap)
                const chartW = dbData.dayCount * DAY_PX;
                return (
                  <div className="space-y-6">
                    {dbData.branches.map((b) => {
                      const hi = b.peakIdx != null ? (b.values[b.peakIdx] as number) : null;
                      const lo = b.lowIdx != null ? (b.values[b.lowIdx] as number) : null;
                      const peak = hi ?? 1;
                      // Only show a distinct "lowest" when it isn't the same single day as the peak.
                      const showLow = lo != null && b.lowIdx !== b.peakIdx;
                      return (
                        <div key={b.branchId}>
                          <div className="mb-1.5">
                            <div className="text-sm font-semibold text-slate-800">{b.branchName}</div>
                            <div className="text-xs text-slate-500 flex flex-wrap gap-x-2 gap-y-0.5">
                              <span>รวม <span className="font-medium text-slate-700">{baht(b.total)}</span></span>
                              {b.avgPerDay != null && <span>· เฉลี่ย/วันขาย {baht(b.avgPerDay)}</span>}
                              {hi != null && <span className="text-emerald-600 font-medium">· สูงสุด {dayLabels[b.peakIdx as number]} ({baht(hi)})</span>}
                              {showLow && <span className="text-rose-500 font-medium">· ต่ำสุด {dayLabels[b.lowIdx as number]} ({baht(lo as number)})</span>}
                            </div>
                          </div>
                          <div className="overflow-x-auto pb-1">
                            <div className="mx-auto" style={{ width: chartW }}>
                              <div className="flex items-end h-32 bg-slate-50/70 rounded">
                                {b.values.map((v, i) => (
                                  <div key={i} className="h-full flex items-end shrink-0 px-[0.5px]" style={{ width: DAY_PX }}
                                    title={`${dayLabels[i]}: ${v == null ? "ไม่มีข้อมูล" : baht(v)}`}>
                                    <div className={`w-full rounded-t-sm ${b.peakIdx === i ? "bg-emerald-600" : b.lowIdx === i ? "bg-rose-400" : "bg-emerald-400"}`}
                                      style={{ height: v == null ? "0%" : `${Math.max(1, (v / peak) * 100)}%` }} />
                                  </div>
                                ))}
                              </div>
                              <div className="flex mt-1">
                                {monthSegs.map((s) => (
                                  <div key={s.m} style={{ width: s.days * DAY_PX }}
                                    className="shrink-0 text-center text-[10px] text-slate-400 border-l border-slate-200 first:border-l-0">{s.m}</div>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-slate-400">แท่ง = ยอดขายสุทธิรายวัน (1 แท่ง = 1 วัน · เลข 1–12 = เดือน) · <span className="text-emerald-600">เขียวเข้ม = วันสูงสุด</span> · <span className="text-rose-500">แดง = วันต่ำสุด</span> · เลื่อนซ้าย–ขวาเพื่อดูทั้งปี · ชี้ที่แท่งเพื่อดูยอดรายวัน</p>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* MTD same-period trend vs last month (owner 2026-09-20): compare day
          1..N of this month against the identical window last month across every
          headline metric, so a partial month reads apples-to-apples. */}
      {monthCompare && monthCompare.throughDay > 0 && (monthCompare.trend?.length ?? 0) > 0 && (
        <div className="card space-y-3">
          <div>
            <h2 className="font-bold text-slate-800">เทรนด์เทียบเดือนก่อน (ช่วงเดียวกัน วันที่ 1–{monthCompare.throughDay})</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {TH_MONTHS[month]} เทียบ {TH_MONTHS[month === 1 ? 12 : month - 1]} · เทียบวันที่ 1–{monthCompare.throughDay} เท่ากันทั้งสองเดือน เพื่อดูเทรนด์แบบตรง ๆ
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {monthCompare.trend!.map((m) => (
              <div key={m.key} className={`rounded-xl p-3 ${m.key === "nett" ? "bg-emerald-50" : "bg-slate-50"}`}>
                <div className="text-[11px] text-slate-500">{m.label}</div>
                <div className={`text-base font-bold ${m.key === "nett" ? "text-emerald-700" : "text-slate-800"}`}>
                  {m.kind === "baht" ? baht(m.value) : intTh(m.value)}
                </div>
                <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">
                  เดือนก่อน {m.prev != null ? (m.kind === "baht" ? baht(m.prev) : intTh(m.prev)) : "—"} · <PctChip pct={m.pct} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Staffing planner (owner 2026-09-20): translate sales into an affordable
          headcount (labor% ÷ cost/head), then per-weekday people from the 8-week
          weekday averages, plus the peak hour to concentrate staff. Client-only —
          derived from the month projection + weekday stats already loaded. */}
      {monthCompare && monthCompare.throughDay > 0 && (() => {
        const dim = new Date(year, month, 0).getDate();
        const mtdAvg = monthCompare.mtdNett / monthCompare.throughDay;
        const projected = mtdAvg * dim;
        const laborFrac = laborPct / 100;
        const budgetMonth = laborFrac * projected;
        const roster = perHeadCost > 0 ? budgetMonth / perHeadCost : 0;
        const WORKING_DAYS = 26;
        const perHeadDaily = perHeadCost > 0 ? perHeadCost / WORKING_DAYS : 0;
        const headsForSales = (sales: number) => perHeadDaily > 0 ? (laborFrac * sales) / perHeadDaily : 0;
        const wk = weekdays.filter((w) => w.days > 0);
        const maxHead = Math.max(1, ...wk.map((w) => headsForSales(w.avgNett)));
        const peak = insights?.receipt?.peakHour ?? null;
        return (
          <div className="card space-y-3">
            <div className="flex items-start gap-3">
              <OwlMascot size={40} mood="thinking" className="shrink-0" ariaLabel="น้องฮูก" />
              <div>
                <h2 className="font-bold text-slate-800">อัตรากำลังที่เหมาะสม · ประเมินจากยอดขาย</h2>
                <p className="text-xs text-slate-500 mt-0.5">อิงต้นทุนแรงงานเป็น % ของยอดขาย และค่าตอบแทนต่อคน/เดือน · คิดวันทำงาน {WORKING_DAYS} วัน/เดือน</p>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="block text-[11px] text-slate-500 mb-0.5">ต้นทุนแรงงาน (% ของยอดขาย)</span>
                <input type="number" min={1} max={100} value={laborPct}
                  onChange={(e) => setLaborPct(Math.min(100, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
                  className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              </label>
              <label className="text-sm">
                <span className="block text-[11px] text-slate-500 mb-0.5">ค่าตอบแทน/คน/เดือน (บาท)</span>
                <input type="text" inputMode="numeric" value={perHeadCost ? perHeadCost.toLocaleString("th-TH") : ""}
                  onChange={(e) => setPerHeadCost(Math.floor(Number(e.target.value.replace(/\D/g, "")) || 0))}
                  className="w-32 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
              </label>
            </div>

            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-900">
              คาดการณ์ยอดสิ้นเดือน <b>{baht(projected)}</b> · งบแรงงาน {laborPct}% = <b>{baht(budgetMonth)}</b>
              <div className="mt-1">รับพนักงานได้ประมาณ <b className="text-emerald-700 text-lg">{roster.toFixed(1)} คน</b> <span className="text-emerald-700/70">(ค่าตอบแทน {intTh(perHeadCost)}/คน)</span></div>
              <div className="text-[11px] text-emerald-700/70 mt-0.5">เฉลี่ยต่อวันเดือนนี้ {baht(mtdAvg)} → ~{headsForSales(mtdAvg).toFixed(1)} คน/วัน (ค่ากลาง)</div>
            </div>

            {wk.length > 0 && (
              <div>
                <div className="text-xs font-bold text-slate-600 mb-1">แนะนำจำนวนคนต่อวัน (ตามยอดเฉลี่ยแต่ละวัน 8 สัปดาห์)</div>
                <div className="space-y-1">
                  {wk.map((w) => {
                    const h = headsForSales(w.avgNett);
                    return (
                      <div key={w.dow} className="flex items-center gap-2 text-sm">
                        <span className="w-14 text-slate-500 shrink-0">{w.label}</span>
                        <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
                          <div className="h-full bg-emerald-400" style={{ width: `${Math.max(4, Math.min(100, (h / maxHead) * 100))}%` }} />
                        </div>
                        <span className="w-28 text-right text-slate-700 shrink-0"><b>{Math.max(1, Math.round(h))} คน</b> · {baht(w.avgNett)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {peak != null && (
              <div className="text-xs text-slate-500 rounded-lg bg-slate-50 p-2.5">
                ช่วงพีค <b className="text-emerald-600">{String(peak).padStart(2, "0")}:00</b> — จัดคนให้เยอะช่วงนี้ (ดูกราฟยอดขาย/บิลตามชั่วโมงด้านล่าง)
              </div>
            )}

            <p className="text-[10px] text-slate-400">* เป็นประมาณการช่วยตัดสินใจ ใช้คู่กับหน้างานจริง — ปรับ % และค่าตอบแทนให้ตรงกับร้านได้</p>
          </div>
        );
      })()}

      {/* Insights: weekday pattern (A, rolling 8w) + channel mix (E) + discount ROI (D) */}
      {days.length > 0 && (
        <div className="grid lg:grid-cols-2 gap-4">
          {weekdays.some((w) => w.days > 0) && (
            <div className="card space-y-2">
              <h2 className="font-bold text-slate-800">ยอดขายเฉลี่ยตามวัน (8 สัปดาห์ล่าสุด)</h2>
              <WeekdayBars stats={weekdays} />
            </div>
          )}
          {channels && (channels.types.length > 0 || channels.payments.length > 0) && (
            <div className="card space-y-3">
              <h2 className="font-bold text-slate-800">ช่องทางการขาย{nowLabel}</h2>
              {channels.types.length > 0 && <ChannelBlock title="ประเภทออเดอร์" slices={channels.types} />}
              {channels.payments.length > 0 && <ChannelBlock title="ช่องทางชำระเงิน" slices={channels.payments} />}
              {channels.sources.length > 1 && <ChannelBlock title="แหล่งที่มา" slices={channels.sources} />}
            </div>
          )}
          {discount && discount.days > 0 && (
            <div className="card space-y-2 lg:col-span-2">
              <h2 className="font-bold text-slate-800">ประสิทธิภาพส่วนลด{nowLabel}</h2>
              <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <div><span className="text-slate-500">ส่วนลดรวม</span> <b className="text-rose-600">{baht(discount.totalDiscount)}</b></div>
                <div><span className="text-slate-500">เฉลี่ย</span> <b>{discount.avgDiscountPct?.toFixed(1)}%</b> ของยอดก่อนลด</div>
              </div>
              {discount.highDiscAvgNett != null && discount.lowDiscAvgNett != null && (
                <div className="text-sm rounded-lg bg-slate-50 p-3">
                  วันที่ <b>ลดเยอะ</b> ยอดเฉลี่ย <b className="text-slate-800">{baht(discount.highDiscAvgNett)}</b> · วันที่ <b>ลดน้อย</b> ยอดเฉลี่ย <b className="text-slate-800">{baht(discount.lowDiscAvgNett)}</b>
                  <div className="text-xs text-slate-500 mt-1">
                    {discount.highDiscAvgNett > discount.lowDiscAvgNett
                      ? "→ วันที่ลดเยอะยอดสูงกว่า ส่วนลดช่วยกระตุ้นยอดได้"
                      : "→ วันที่ลดเยอะยอดไม่ได้สูงกว่า ลองปรับความลึกของโปรให้คุ้มขึ้น"}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Deeper marketing insights (owner 2026-09-18) */}
      {insights && days.length > 0 && (
        <div className="space-y-4">
          {/* #1 Menu engineering */}
          <div className="card space-y-3">
            <div>
              <h2 className="font-bold text-slate-800">วิเคราะห์เมนู (Menu Engineering)</h2>
              <p className="text-xs text-slate-500 mt-0.5">แบ่งเมนูตามรายได้ (สูง/ต่ำ) × แนวโน้ม{prevLabel} (โต/ร่วง) เพื่อวางแผน ดัน/ปรับ/ตัด</p>
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <QuadCard title="ดาวเด่น — ขายดี + กำลังโต" hint="ดันต่อ: โฆษณา / เมนูแนะนำ" list={insights.menuEngineering.stars} tone="emerald" />
              <QuadCard title="ม้างาน — ขายดีแต่นิ่ง/ร่วง" hint="รักษาไว้: ปรับราคา / ถ่ายรูปใหม่ / รีแบรนด์" list={insights.menuEngineering.plowhorses} tone="sky" />
              <QuadCard title="ปริศนา — ขายน้อยแต่กำลังโต" hint="ลองดัน: โปรกระตุ้น / วางตำแหน่งให้เด่น" list={insights.menuEngineering.puzzles} tone="amber" />
              <QuadCard title="ตัวถ่วง — ขายน้อย + ร่วง" hint="พิจารณา: ตัดออก / ปรับสูตร" list={insights.menuEngineering.dogs} tone="rose" />
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* #2 Beverage attach */}
            {insights.beverage.total > 0 && (
              <div className="card space-y-2">
                <h2 className="font-bold text-slate-800">สัดส่วนเครื่องดื่ม / ของหวาน</h2>
                <div className="space-y-1">
                  <ChannelBlock title="" slices={[
                    { name: "อาหาร", sales: insights.beverage.foodNett, qty: 0, pct: insights.beverage.foodPct, avgTicket: null },
                    { name: "เครื่องดื่ม", sales: insights.beverage.beverageNett, qty: 0, pct: insights.beverage.beveragePct, avgTicket: null },
                    { name: "ของหวาน", sales: insights.beverage.dessertNett, qty: 0, pct: insights.beverage.dessertPct, avgTicket: null }
                  ]} />
                </div>
                <div className="text-sm rounded-lg bg-slate-50 p-2.5">
                  เครื่องดื่มคิดเป็น <b>{insights.beverage.bevToFoodPct?.toFixed(0) ?? "—"}%</b> ของยอดอาหาร
                  <div className="text-xs text-slate-500 mt-0.5">
                    {(insights.beverage.bevToFoodPct ?? 0) < 20
                      ? "→ ค่อนข้างต่ำ — โอกาสอัปเซล จัดเซ็ตจานหลัก+เครื่องดื่ม / ไวน์แพร์ริ่ง (มาร์จิ้นสูง)"
                      : "→ อยู่ในเกณฑ์ดี — รักษาการอัปเซลเครื่องดื่มต่อไป"}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1">* แยกหมวดอัตโนมัติจากชื่อเมนู</div>
                </div>
              </div>
            )}

            {/* #7 Concentration */}
            {insights.concentration.top5Pct != null && (
              <div className="card space-y-2">
                <h2 className="font-bold text-slate-800">ความกระจุกตัวของรายได้ (80/20)</h2>
                <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                  <div><span className="text-slate-500">Top 5 เมนู</span> <b>{insights.concentration.top5Pct.toFixed(0)}%</b> ของยอดเมนู</div>
                  <div><span className="text-slate-500">เมนูที่ทำ 80% ของยอด</span> <b>{insights.concentration.countFor80}</b> จาก {insights.concentration.itemCount} เมนู</div>
                </div>
                <div className="text-xs text-slate-500 rounded-lg bg-slate-50 p-2.5">
                  {insights.concentration.top5Pct >= 50
                    ? "→ รายได้กระจุกในไม่กี่เมนู เสี่ยงถ้าของหมด/ลูกค้าเบื่อ — ครอสเซลกระจายไปเมนูอื่น + ป้องกันสต็อกตัวหลัก"
                    : "→ รายได้กระจายดี ความเสี่ยงต่ำ"}
                </div>
              </div>
            )}

            {/* #3 Guest metrics */}
            {(insights.guests.avgPartySize != null || insights.guests.avgSpendPerHead != null) && (
              <div className="card space-y-2">
                <h2 className="font-bold text-slate-800">พฤติกรรมลูกค้า</h2>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <div className="text-[11px] text-slate-500">ลูกค้าเฉลี่ยต่อบิล (ขนาดกลุ่ม)</div>
                    <div className="text-base font-bold text-slate-800">{insights.guests.avgPartySize?.toFixed(2) ?? "—"} คน</div>
                    <div className="text-[10px] text-slate-400">{prevLabel} <PctChip pct={insights.guests.partyMomPct} /></div>
                  </div>
                  <div className="rounded-xl bg-emerald-50 p-3">
                    <div className="text-[11px] text-slate-500">ยอดใช้จ่ายต่อหัว</div>
                    <div className="text-base font-bold text-emerald-700">{insights.guests.avgSpendPerHead != null ? baht(insights.guests.avgSpendPerHead) : "—"}</div>
                    <div className="text-[10px] text-slate-400">{prevLabel} <PctChip pct={insights.guests.spendMomPct} /></div>
                  </div>
                </div>
                <div className="text-xs text-slate-500">
                  {(insights.guests.spendMomPct ?? 0) < 0 ? "→ ยอดต่อหัวลด — เร่งอัปเซล/เซ็ตเมนู" : "→ ยอดต่อหัวเพิ่ม — การอัปเซลได้ผล"}
                  {(insights.guests.avgPartySize ?? 0) >= 2.5 ? " · ลูกค้ามาเป็นกลุ่ม → จัดเซ็ตแบ่งกันกิน/โปรโต๊ะใหญ่" : ""}
                </div>
              </div>
            )}

            {/* #5 Rhythm: payday + weekend */}
            {(insights.rhythm.paydayLiftPct != null || insights.rhythm.weekendLiftPct != null) && (
              <div className="card space-y-2">
                <h2 className="font-bold text-slate-800">จังหวะยอดขาย (เงินเดือน / สุดสัปดาห์)</h2>
                <div className="space-y-1 text-sm">
                  {insights.rhythm.paydayLiftPct != null && (
                    <div>ช่วงเงินเดือนออก (กลาง/สิ้นเดือน) ยอดเฉลี่ย/วัน <b>{baht(insights.rhythm.paydayAvgNett ?? 0)}</b> · เทียบวันอื่น <PctChip pct={insights.rhythm.paydayLiftPct} /></div>
                  )}
                  {insights.rhythm.weekendLiftPct != null && (
                    <div>เสาร์–อาทิตย์ ยอดเฉลี่ย/วัน <b>{baht(insights.rhythm.weekendAvgNett ?? 0)}</b> · เทียบวันธรรมดา <PctChip pct={insights.rhythm.weekendLiftPct} /></div>
                  )}
                </div>
                <div className="text-xs text-slate-500 rounded-lg bg-slate-50 p-2.5">→ ตั้งเวลาโปร/แคมเปญให้ตรงจังหวะเงินสะพัด · วันธรรมดาที่ยอดต่ำจัดโปรกระตุ้น</div>
              </div>
            )}

            {/* #6 Quality */}
            {insights.quality.voidRatePct != null && (
              <div className={`card space-y-2 ${insights.quality.flag ? "border-amber-300 bg-amber-50" : ""}`}>
                <h2 className="font-bold text-slate-800">สัญญาณคุณภาพ (Void / Refund)</h2>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                  <div><span className="text-slate-500">อัตรา Void</span> <b className={insights.quality.flag ? "text-amber-700" : "text-slate-800"}>{insights.quality.voidRatePct.toFixed(2)}%</b> ของยอดก่อนลด {insights.quality.prevVoidRatePct != null && <span className="text-slate-400">({prevWord} {insights.quality.prevVoidRatePct.toFixed(2)}%)</span>}</div>
                  <div><span className="text-slate-500">บิลยกเลิก</span> <b>{intTh(insights.quality.voidBillCount)}</b> บิล</div>
                  {insights.quality.refund > 0 && <div><span className="text-slate-500">คืนเงิน</span> <b className="text-rose-600">{baht(insights.quality.refund)}</b></div>}
                </div>
                {insights.quality.flag && <div className="text-xs text-amber-700">→ อัตรา Void สูงกว่าปกติ — ตรวจสอบครัว/เมนูที่สับสน ก่อนกระทบลูกค้ากลับมาซ้ำ</div>}
              </div>
            )}
          </div>

          {/* Receipt insights: peak hour + units + basket (owner 2026-09-18) */}
          {insights.receipt.hasData && (
            <>
              <div className="card space-y-2">
                <div>
                  <h2 className="font-bold text-slate-800">ช่วงเวลาขายดี (พีคไทม์)</h2>
                  <p className="text-xs text-slate-500 mt-0.5">ยอดขาย/จำนวนบิลตามชั่วโมง จากไฟล์ใบเสร็จ (ไม่รวมบิลพนักงาน)</p>
                </div>
                <HourBars hours={insights.receipt.hourly} peak={insights.receipt.peakHour} />
              </div>

              <div className="grid lg:grid-cols-2 gap-4">
                <div className="card space-y-2">
                  <h2 className="font-bold text-slate-800">เมนูขายดีเชิงจำนวน (จำนวนที่ขายได้)</h2>
                  <p className="text-xs text-slate-500">คนละมุมกับ "เชิงเงิน" — ของถูกที่ขายเยอะช่วยสร้างทราฟฟิก</p>
                  <ol className="space-y-1">
                    {insights.receipt.topUnits.map((u, i) => (
                      <li key={u.name} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-slate-700 truncate">{i + 1}. {u.name}</span>
                        <span className="whitespace-nowrap text-slate-600"><b>{intTh(u.units)}</b> ครั้ง · {intTh(u.bills)} บิล</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="card space-y-2">
                  <h2 className="font-bold text-slate-800">เมนูที่มักสั่งคู่กัน (Basket)</h2>
                  <p className="text-xs text-slate-500">ใช้ออกแบบ "เซ็ตคู่หู" / ครอสเซล / จัดวางเมนู</p>
                  {insights.receipt.basket.length === 0 ? (
                    <div className="text-sm text-slate-400">ข้อมูลยังน้อย — นำเข้าใบเสร็จหลายวันเพื่อดูคู่ที่ชัดขึ้น</div>
                  ) : (
                    <ol className="space-y-1">
                      {insights.receipt.basket.map((p) => (
                        <li key={`${p.a}|${p.b}`} className="flex items-center justify-between gap-2 text-sm">
                          <span className="text-slate-700 truncate">{p.a} <span className="text-slate-400">+</span> {p.b}</span>
                          <span className="whitespace-nowrap text-emerald-600 font-semibold">{intTh(p.count)} บิล</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* แผนดันยอด — น้องฮูกแนะนำ (owner 2026-09-18) */}
      <div className="card space-y-3">
        <div className="flex items-start gap-3">
          <OwlMascot size={44} mood="thinking" className="shrink-0" ariaLabel="น้องฮูก" />
          <div>
            <h2 className="font-bold text-slate-800">แผนผลักดันยอดขาย · คำแนะนำจากน้องฮูก</h2>
            <p className="text-xs text-slate-500 mt-0.5">ระบุยอดเป้าหมายและจำนวนวัน น้องฮูกจะวิเคราะห์ข้อมูลย้อนหลังและสรุปแนวทางผลักดันยอดขายให้ สำหรับ HOD นำไปบรีฟทีม</p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-[11px] text-slate-500 mb-0.5">ภายในกี่วัน</span>
            <input type="number" min={1} max={31} value={pushDays}
              onChange={(e) => setPushDays(Math.min(31, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-[11px] text-slate-500 mb-0.5">ยอดเป้าหมาย (บาท)</span>
            <input type="text" inputMode="numeric" placeholder="เช่น 100,000"
              value={pushTarget ? Number(pushTarget).toLocaleString("th-TH") : ""}
              onChange={(e) => setPushTarget(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") runPush(); }}
              className="w-40 rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
          </label>
          <button onClick={runPush} disabled={planBusy} className="btn-primary text-sm disabled:opacity-50">
            {planBusy ? "กำลังวิเคราะห์…" : "ขอคำแนะนำจากน้องฮูก"}
          </button>
        </div>

        {plan && (
          <div className="space-y-3 pt-1">
            {(() => {
              const tone = plan.verdict === "easy" || plan.verdict === "ontrack" ? "emerald"
                : plan.verdict === "stretch" ? "amber"
                : plan.verdict === "no_data" ? "slate" : "rose";
              const cls: Record<string, string> = {
                emerald: "bg-emerald-50 border-emerald-200 text-emerald-800",
                amber: "bg-amber-50 border-amber-200 text-amber-800",
                rose: "bg-rose-50 border-rose-200 text-rose-800",
                slate: "bg-slate-50 border-slate-200 text-slate-700",
              };
              return <div className={`rounded-lg border p-3 text-sm ${cls[tone]}`}>{plan.verdictText}</div>;
            })()}

            {plan.hasBaseline && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Kpi label="ต้องได้เฉลี่ย/วัน" value={baht(plan.requiredPerDay)} accent />
                <Kpi label="คาดการณ์ตามปกติ/วัน" value={baht(plan.baselinePerDay)} />
                <Kpi label="ส่วนต่างที่ต้องเพิ่ม" value={plan.gap > 0 ? `+${baht(plan.gap)}` : "บรรลุแล้ว"} />
                <Kpi label="เทียบยอดปกติ" value={plan.liftPct != null ? `${plan.liftPct > 0 ? "+" : ""}${plan.liftPct.toFixed(0)}%` : "—"} />
              </div>
            )}

            {plan.advice.length > 0 && (
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                <div className="text-xs font-bold mb-1" style={{ color: cardColor }}>สรุปประเด็นสำหรับบรีฟทีม</div>
                <ul className="space-y-1">
                  {plan.advice.map((line, i) => (
                    <li key={i} className="flex gap-2 text-sm text-slate-700">
                      <span style={{ color: cardColor }}>•</span><span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={sendPush} disabled={!hasLineGroup || !plan.hasBaseline}
                className="btn-success text-sm px-4 py-2 disabled:opacity-50">ส่งรายงานผู้บริหาร</button>
              {!hasLineGroup && <span className="text-[11px] text-slate-400">ตั้งกลุ่ม LINE ก่อนถึงจะส่งได้</span>}
            </div>
          </div>
        )}
      </div>

      {pin && <PinModal title={pin.title} preview={pin.preview} onConfirm={pin.run} onClose={() => setPin(null)} />}
    </div>
  );
}

function MomentumList({ title, list, up }: { title: string; list: MenuMomentum[]; up?: boolean }) {
  if (!list.length) return null;
  return (
    <div>
      <div className={`text-xs font-bold mb-1 ${up ? "text-emerald-700" : "text-rose-700"}`}>{title}</div>
      <ol className="space-y-1">
        {list.map((m) => (
          <li key={m.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-700 truncate">{m.name}</span>
            <span className={`whitespace-nowrap font-semibold ${up ? "text-emerald-600" : "text-rose-600"}`}>
              {m.deltaPct == null ? "ใหม่" : `${m.deltaPct >= 0 ? "▲" : "▼"} ${Math.abs(m.deltaPct).toFixed(0)}%`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FileChip({ label, present }: { label: string; present?: boolean }) {
  return present
    ? <span className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 text-[10px] font-medium">✓ {label}</span>
    : <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-700 border border-amber-300 px-2 py-0.5 text-[10px] font-medium">ขาด{label}</span>;
}

function HourBars({ hours, peak }: { hours: Array<{ hour: number; bills: number; nett: number }>; peak: number | null }) {
  if (!hours.length) return <div className="text-xs text-slate-400">ยังไม่มีข้อมูลใบเสร็จ</div>;
  const max = Math.max(1, ...hours.map((h) => h.nett));
  return (
    <div className="space-y-1">
      {hours.map((h) => (
        <div key={h.hour} className="flex items-center gap-2">
          <span className="w-12 text-xs text-slate-500 shrink-0 tabular-nums">{String(h.hour).padStart(2, "0")}:00</span>
          <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
            <div className={`h-full ${h.hour === peak ? "bg-emerald-500" : "bg-emerald-300"}`} style={{ width: `${Math.max(3, (h.nett / max) * 100)}%` }} />
          </div>
          <span className="w-36 text-right text-xs text-slate-700 shrink-0">{baht(h.nett)} · {intTh(h.bills)} บิล</span>
        </div>
      ))}
      {peak != null && <div className="text-xs text-slate-500 pt-1">ช่วงพีค <b className="text-emerald-600">{String(peak).padStart(2, "0")}:00</b> — จัดกำลังคน/เตรียมของให้พร้อม · ช่วงร้างจัด Happy Hour กระตุ้น</div>}
    </div>
  );
}

function QuadCard({ title, hint, list, tone }: { title: string; hint: string; list: MenuClass[]; tone: "emerald" | "sky" | "amber" | "rose" }) {
  const bar = { emerald: "border-emerald-400 bg-emerald-50", sky: "border-sky-400 bg-sky-50", amber: "border-amber-400 bg-amber-50", rose: "border-rose-400 bg-rose-50" }[tone];
  const head = { emerald: "text-emerald-700", sky: "text-sky-700", amber: "text-amber-700", rose: "text-rose-700" }[tone];
  return (
    <div className={`rounded-xl border-l-4 ${bar} p-3`}>
      <div className={`text-sm font-bold ${head}`}>{title}</div>
      <div className="text-[11px] text-slate-500 mb-1.5">{hint}</div>
      {list.length === 0 ? (
        <div className="text-xs text-slate-400">—</div>
      ) : (
        <ol className="space-y-0.5">
          {list.map((m) => (
            <li key={m.name} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-slate-700 truncate">{m.name}</span>
              <span className="whitespace-nowrap text-slate-500">
                {m.units != null ? <span className="text-slate-400">{intTh(m.units)} ครั้ง · </span> : null}{baht(m.nett)}{m.isNew ? " · ใหม่" : m.deltaPct != null ? <> · <PctChip pct={m.deltaPct} /></> : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function WeekdayBars({ stats }: { stats: WeekdayStat[] }) {
  const active = stats.filter((s) => s.days > 0);
  const max = Math.max(1, ...active.map((s) => s.avgNett));
  const best = active.reduce<WeekdayStat | null>((b, s) => (b == null || s.avgNett > b.avgNett ? s : b), null);
  const worst = active.reduce<WeekdayStat | null>((b, s) => (b == null || s.avgNett < b.avgNett ? s : b), null);
  return (
    <div className="space-y-1.5">
      {stats.map((s) => {
        const tone = s.days === 0 ? "bg-slate-200" : s.dow === best?.dow ? "bg-emerald-500" : s.dow === worst?.dow ? "bg-amber-400" : "bg-emerald-300";
        return (
          <div key={s.dow} className="flex items-center gap-2">
            <span className="w-14 text-xs text-slate-500 shrink-0">{s.label}</span>
            <div className="flex-1 h-4 rounded bg-slate-100 overflow-hidden">
              <div className={`h-full ${tone}`} style={{ width: `${s.days === 0 ? 0 : Math.max(4, (s.avgNett / max) * 100)}%` }} />
            </div>
            <span className="w-24 text-right text-xs font-medium text-slate-700 shrink-0">{s.days === 0 ? "—" : baht(s.avgNett)}</span>
          </div>
        );
      })}
      {best && worst && best.dow !== worst.dow && (
        <div className="text-xs text-slate-500 pt-1">ขายดีสุด <b className="text-emerald-600">{best.label}</b> · ร้างสุด <b className="text-amber-600">{worst.label}</b></div>
      )}
    </div>
  );
}

function ChannelBlock({ title, slices }: { title: string; slices: ChannelSlice[] }) {
  return (
    <div>
      <div className="text-xs font-bold text-slate-600 mb-1">{title}</div>
      <div className="space-y-1">
        {slices.map((s) => (
          <div key={s.name} className="flex items-center gap-2">
            <span className="w-28 text-xs text-slate-600 truncate shrink-0">{s.name}</span>
            <div className="flex-1 h-3 rounded bg-slate-100 overflow-hidden">
              <div className="h-full bg-sky-400" style={{ width: `${Math.max(2, s.pct)}%` }} />
            </div>
            <span className="w-40 text-right text-xs text-slate-700 shrink-0">{baht(s.sales)} · {s.pct.toFixed(0)}%{s.avgTicket != null ? ` · เฉลี่ย/บิล ${baht(s.avgTicket)}` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PctChip({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const up = pct >= 0;
  return <span className={up ? "text-emerald-600" : "text-rose-600"}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span>;
}

// ── LINE card previews (owner 2026-09-18: ดูก่อนส่งทุกการ์ด) ──────────────────
function CardShell({ color, title, subtitle, children }: { color: string; title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="bg-white text-[13px]">
      <div style={{ backgroundColor: color }} className="px-4 py-3">
        <div className="text-[10px]" style={{ color: "#ffffff99" }}>IKIGAI OS · ยอดขายรายวัน</div>
        <div className="text-white font-bold text-base leading-tight">{title}</div>
        <div className="text-xs" style={{ color: "#ffffffcc" }}>{subtitle}</div>
      </div>
      <div className="px-4 py-3 space-y-1">{children}</div>
    </div>
  );
}
function PRow({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: "green" | "red" }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right ${bold ? "font-bold" : ""} ${tone === "green" ? "text-emerald-700" : tone === "red" ? "text-rose-600" : "text-slate-800"}`}>{value}</span>
    </div>
  );
}
function Cmp({ parts }: { parts: Array<{ label: string; pct: number | null }> }) {
  if (parts.every((p) => p.pct == null)) return <div className="text-[11px] text-slate-400">ยังไม่มีข้อมูลเทียบ</div>;
  return (
    <div className="text-[11px] text-slate-400 flex flex-wrap gap-x-4">
      {parts.map((p, i) => <span key={i}>{p.label} <PctChip pct={p.pct} /></span>)}
    </div>
  );
}
function PMenu({ title, list }: { title: string; list: MenuRank[] }) {
  if (!list.length) return null;
  return (
    <div className="pt-1">
      <div className="text-xs font-bold text-slate-700 mb-0.5">{title}</div>
      {list.map((m, i) => (
        <div key={m.name} className="flex justify-between gap-2 text-[12px]"><span className="text-slate-600 truncate">{i + 1}. {m.name}</span><span className="whitespace-nowrap">{baht(m.nett)}</span></div>
      ))}
    </div>
  );
}
const sepline = <div className="border-t border-slate-100 my-1.5" />;

function DailyPreview({ a, branchName, operator, color }: { a: DailyAnalytics; branchName: string; operator: string; color: string }) {
  const r = a.row;
  const fmt = (m: MetricCompare) => m.kind === "baht" ? `${baht(m.value)} บาท` : m.key === "bills" ? `${intTh(m.value)} บิล` : m.key === "pax" ? `${intTh(m.value)} คน` : intTh(m.value);
  return (
    <CardShell color={color} title="สรุปยอดขายประจำวัน" subtitle={`${a.dateLabel} · ${branchName}`}>
      <div className="font-bold text-slate-800">{branchName}</div>
      <div className="text-[11px] text-slate-400">บันทึกโดย: {operator}</div>
      {a.advice.length > 0 && (
        <div className="rounded-md bg-slate-50 p-2 my-1">
          <div className="text-[11px] font-bold" style={{ color }}>สรุป &amp; คำแนะนำ</div>
          {a.advice.map((line, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] text-slate-600 leading-snug">
              <span style={{ color }}>•</span><span>{line}</span>
            </div>
          ))}
        </div>
      )}
      {sepline}
      {a.metrics.map((m) => (
        <div key={m.key}>
          <PRow label={m.label} value={fmt(m)} bold={m.key === "nett"} tone={m.key === "nett" ? "green" : undefined} />
          <Cmp parts={[{ label: a.wowLabel, pct: m.wowPct }, { label: a.momLabel, pct: m.momPct }]} />
        </div>
      ))}
      <PRow label="ส่วนลด" value={`${baht(Math.abs(r.discount))}${a.discountPct != null ? ` (${a.discountPct.toFixed(1)}%)` : ""}`} tone="red" />
      {r.void_amount > 0 && <PRow label="ยกเลิกบิล (Void)" value={`${baht(r.void_amount)} · ${intTh(r.void_bill_count)} บิล`} tone="red" />}
      <PMenu title="เมนูทำรายได้สูงสุด" list={a.topItems} />
      <PMenu title="หมวดทำรายได้สูงสุด" list={a.topCategories} />
    </CardShell>
  );
}

function WeeklyPreview({ w, branchName, operator, color }: { w: WeeklyAnalytics; branchName: string; operator: string; color: string }) {
  return (
    <CardShell color={color} title="สรุปยอดขายประจำสัปดาห์" subtitle={`${w.label} · ${branchName}`}>
      <div className="font-bold text-slate-800">{branchName}</div>
      <div className="text-[11px] text-slate-400">สรุปโดย: {operator} · รวม {w.dayCount} วัน</div>
      {sepline}
      <PRow label="ยอดขายรวมสัปดาห์" value={`${baht(w.totalNett)} บาท`} bold tone="green" />
      <Cmp parts={[{ label: "เทียบสัปดาห์ก่อน", pct: w.wowNettPct }]} />
      <PRow label="จำนวนบิลรวม" value={`${intTh(w.totalBills)} บิล`} />
      <PRow label="ลูกค้ารวม" value={`${intTh(w.totalPax)} คน`} />
      {w.avgPerDay != null && <PRow label="เฉลี่ยต่อวัน" value={`${baht(w.avgPerDay)} บาท`} />}
      {w.bestDate && <PRow label="วันขายดีสุด" value={`${w.days.find((d) => d.date === w.bestDate)?.dateLabel ?? w.bestDate} · ${baht(w.bestNett ?? 0)}`} />}
      <PMenu title="เมนูทำรายได้สูงสุดประจำสัปดาห์" list={w.topItems} />
    </CardShell>
  );
}

function MonthlyPreview({ m, branchName, operator, color }: { m: MonthlyAnalytics; branchName: string; operator: string; color: string }) {
  return (
    <CardShell color={color} title="สรุปยอดขายประจำเดือน" subtitle={`${m.label} · ${branchName}`}>
      <div className="font-bold text-slate-800">{branchName}</div>
      <div className="text-[11px] text-slate-400">สรุปโดย: {operator} · รวม {m.dayCount} วัน</div>
      {sepline}
      <PRow label="ยอดขายรวมทั้งเดือน" value={`${baht(m.totalNett)} บาท`} bold tone="green" />
      {m.revshareIncome > 0 && <div className="text-[10px] text-violet-600">รวมส่วนแบ่งยอดขายรายเดือน {baht(m.revshareIncome)} บาท (นอก POS)</div>}
      <Cmp parts={[{ label: "เทียบเดือนก่อน (ช่วงเดียวกัน)", pct: m.prevMonthPct }, { label: "เทียบปีก่อน (ช่วงเดียวกัน)", pct: m.lastYearPct }]} />
      <PRow label="จำนวนบิลรวม" value={`${intTh(m.totalBills)} บิล`} />
      <PRow label="ลูกค้ารวม" value={`${intTh(m.totalPax)} คน`} />
      {m.avgPerDay != null && <PRow label="เฉลี่ยต่อวัน" value={`${baht(m.avgPerDay)} บาท`} />}
      <PMenu title="เมนูทำรายได้สูงสุดประจำเดือน" list={m.topItems} />
    </CardShell>
  );
}

function PushPreview({ plan, branchName, operator, color }: { plan: SalesPushPlan; branchName: string; operator: string; color: string }) {
  const toneCls = plan.verdict === "easy" || plan.verdict === "ontrack" ? "bg-emerald-50 text-emerald-800"
    : plan.verdict === "stretch" ? "bg-amber-50 text-amber-800"
    : plan.verdict === "no_data" ? "bg-slate-50 text-slate-700" : "bg-rose-50 text-rose-800";
  return (
    <CardShell color={color} title="แผนผลักดันยอดขาย · คำแนะนำจากน้องฮูก" subtitle={`${plan.days} วัน · ${branchName}`}>
      <div className="font-bold text-slate-800">{branchName}</div>
      <div className="text-[11px] text-slate-400">บรีฟโดย: {operator}</div>
      {sepline}
      <PRow label="เป้าหมาย" value={`${baht(plan.targetBaht)} บาท · ${plan.days} วัน`} bold tone="green" />
      <PRow label="ต้องได้เฉลี่ย/วัน" value={`${baht(plan.requiredPerDay)} บาท`} />
      {plan.hasBaseline && (
        <PRow label="คาดการณ์ตามปกติ"
          value={`${baht(plan.baselineProjected)} บาท${plan.liftPct != null ? ` (${plan.liftPct > 0 ? "+" : ""}${plan.liftPct.toFixed(0)}%)` : ""}`}
          tone={plan.gap > 0 ? "red" : "green"} />
      )}
      <div className={`rounded-md p-2 my-1 text-[11px] leading-snug ${toneCls}`}>{plan.verdictText}</div>
      {plan.advice.length > 0 && (
        <div className="rounded-md bg-slate-50 p-2 my-1">
          <div className="text-[11px] font-bold" style={{ color }}>สรุปประเด็นสำหรับบรีฟทีม</div>
          {plan.advice.map((line, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] text-slate-600 leading-snug"><span style={{ color }}>•</span><span>{line}</span></div>
          ))}
        </div>
      )}
      {plan.topEarners.length > 0 && (
        <div className="pt-1">
          <div className="text-xs font-bold text-slate-700 mb-0.5">เมนูที่ทำรายได้หลัก (ช่วง 4 สัปดาห์)</div>
          {plan.topEarners.map((mm, i) => (
            <div key={mm.name} className="flex justify-between gap-2 text-[12px]"><span className="text-slate-600 truncate">{i + 1}. {mm.name}</span><span className="whitespace-nowrap">{baht(mm.nett)}</span></div>
          ))}
        </div>
      )}
    </CardShell>
  );
}

function Kpi({ label, value, accent, wowPct, momPct, wowLabel, momLabel }: {
  label: string; value: string; accent?: boolean;
  wowPct?: number | null; momPct?: number | null; wowLabel?: string; momLabel?: string;
}) {
  const hasCompare = wowPct !== undefined || momPct !== undefined;
  return (
    <div className={`rounded-xl p-3 ${accent ? "bg-emerald-50" : "bg-slate-50"}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-base font-bold ${accent ? "text-emerald-700" : "text-slate-800"}`}>{value}</div>
      {hasCompare && (
        <div className="text-[10px] text-slate-400 mt-0.5 leading-tight">
          {(wowPct == null && momPct == null) ? (
            "ยังไม่มีข้อมูลเทียบ"
          ) : (
            <>{wowLabel} <PctChip pct={wowPct ?? null} /> · {momLabel} <PctChip pct={momPct ?? null} /></>
          )}
        </div>
      )}
    </div>
  );
}
