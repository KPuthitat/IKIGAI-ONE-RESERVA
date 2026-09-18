"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
type MenuRank = { name: string; nett: number; rank: number };
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
type MonthCompare = { throughDay: number; mtdNett: number; prevMonthNett: number | null; prevMonthPct: number | null; lastYearNett: number | null; lastYearPct: number | null };
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
type MenuClass = { name: string; nett: number; deltaPct: number | null; isNew: boolean };
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
type MonthTarget = { target: number; mtdNett: number; throughDay: number; daysInMonth: number; pctOfTarget: number; projectedNett: number; projectedPct: number; onTrack: boolean };
type MonthlyAnalytics = {
  year: number; month: number; ym: string; label: string; dayCount: number;
  totalNett: number; totalBills: number; totalPax: number; totalDiscount: number;
  avgPerDay: number | null; avgPerBill: number | null; bestDate: string | null; bestNett: number | null;
  prevMonthNett: number | null; prevMonthPct: number | null; lastYearNett: number | null; lastYearPct: number | null;
  topItems: MenuRank[]; topCategories: MenuRank[];
};

function MenuList({ title, list, muted }: { title: string; list: MenuRank[]; muted?: boolean }) {
  if (!list.length) return null;
  return (
    <div>
      <div className={`text-xs font-bold mb-1 ${muted ? "text-slate-500" : "text-emerald-800"}`}>{title}</div>
      <ol className="space-y-1">
        {list.map((m, i) => (
          <li key={m.name} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-slate-700 truncate">{i + 1}. {m.name}</span>
            <span className="text-slate-900 font-medium whitespace-nowrap">{baht(m.nett)}</span>
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
  const [monthTarget, setMonthTarget] = useState<MonthTarget | null>(null);
  const [monthSentAt, setMonthSentAt] = useState<string | null>(null);
  const [hasLineGroup, setHasLineGroup] = useState(true);
  const [selDate, setSelDate] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailyAnalytics | null>(null);
  const [weekStart, setWeekStart] = useState<string>(mondayOf(addDays(initial, -7)));
  const [weekly, setWeekly] = useState<WeeklyAnalytics | null>(null);
  const [weeklySentAt, setWeeklySentAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pin, setPin] = useState<null | { title: string; preview?: ReactNode; run: (pin: string) => Promise<{ ok: boolean; message?: string }> }>(null);
  const [cardColor, setCardColor] = useState(defaultColor);
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const xlsx = Array.from(list).filter((f) => /\.xlsx?$/i.test(f.name));
    if (xlsx.length) setPicked((prev) => [...prev, ...xlsx].filter((f, i, a) => a.findIndex((g) => g.name === f.name && g.size === f.size) === i));
  };

  const loadMonth = useCallback(async () => {
    const r = await fetch(`/api/admin/reporta/view?year=${year}&month=${month}`).then((x) => x.json());
    if (r.ok) {
      setDays(r.view.days); setHasLineGroup(r.hasLineGroup); setMonthCompare(r.monthCompare ?? null);
      setWeekdays(r.weekdays ?? []); setDiscount(r.discount ?? null); setChannels(r.channels ?? null);
      setMonthTarget(r.monthTarget ?? null); setMonthSentAt(r.monthSentAt ?? null); setInsights(r.insights ?? null);
      if (r.cardColor) setCardColor(r.cardColor);
    }
  }, [year, month]);

  const loadDay = useCallback(async (date: string) => {
    setSelDate(date); setDaily(null);
    const r = await fetch(`/api/admin/reporta/view?date=${date}`).then((x) => x.json());
    if (r.ok) { setDaily(r.daily); if (r.cardColor) setCardColor(r.cardColor); } else setMsg({ kind: "err", text: r.message ?? "โหลดข้อมูลวันไม่สำเร็จ" });
  }, []);

  const loadWeek = useCallback(async (ws: string) => {
    const r = await fetch(`/api/admin/reporta/view?week=${ws}`).then((x) => x.json());
    if (r.ok) { setWeekly(r.weekly); setWeeklySentAt(r.weeklySentAt); }
  }, []);

  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => { loadWeek(weekStart); }, [weekStart, loadWeek]);

  const sendImport = async (files: File[]) => {
    if (!files.length) { setMsg({ kind: "err", text: "เลือกไฟล์ก่อน" }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    files.forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/admin/reporta/import", { method: "POST", body: fd }).then((x) => x.json());
      if (!r.ok) { setMsg({ kind: "err", text: r.message ?? r.error ?? "นำเข้าไม่สำเร็จ" }); }
      else {
        const lines = r.imported.map((i: { kind: string; date: string; note: string }) => `${i.kind === "close_up" ? "ยอดขาย" : i.kind === "overview" ? "เมนู" : "ใบเสร็จ"} · ${thaiDate(i.date)} · ${i.note}`);
        setMsg({ kind: "ok", text: `นำเข้าสำเร็จ: ${lines.join(" / ")}` });
        setPicked([]);
        if (fileRef.current) fileRef.current.value = "";
        await loadMonth();
        await loadWeek(weekStart);
        const first = r.imported[0]?.date;
        if (first) await loadDay(first);
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
    const pv = await fetch(`/api/admin/reporta/view?monthly=${ym}`).then((x) => x.json()).catch(() => null);
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

  const shiftMonth = (delta: number) => {
    let y = year, m = month + delta;
    if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; }
    setYear(y); setMonth(m);
  };

  return (
    <div className="space-y-4">
      {!hasLineGroup && (
        <div className="card bg-amber-50 border-amber-200 text-sm text-amber-800">
          ⚠️ ยังไม่ได้ตั้งกลุ่ม LINE หัวหน้างาน — ปุ่มส่งสรุปจะยังใช้ไม่ได้ · <a href="/admin/reporta/settings" className="underline font-semibold">ไปตั้งค่า</a>
        </div>
      )}
      {msg && (
        <div className={`card text-sm ${msg.kind === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>{msg.text}</div>
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

      {/* Month list */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <button onClick={() => shiftMonth(-1)} className="btn-secondary text-sm px-3 py-1.5">←</button>
          <h2 className="font-bold text-slate-800">{TH_MONTHS[month]} {year + 543}</h2>
          <button onClick={() => shiftMonth(1)} className="btn-secondary text-sm px-3 py-1.5">→</button>
        </div>

        {/* Month-level cumulative comparisons (owner 2026-09-17). */}
        {monthCompare && monthCompare.throughDay > 0 && (
          <div className="rounded-xl bg-slate-50 p-3 space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-slate-500">ยอดสะสมต้นเดือน (ถึงวันที่ {monthCompare.throughDay})</span>
              <span className="text-lg font-bold text-emerald-700">{baht(monthCompare.mtdNett)}</span>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
              <span>เทียบเดือนก่อน (ช่วงเดียวกัน) <PctChip pct={monthCompare.prevMonthPct} /></span>
              <span>เทียบปีก่อน (เดือนเดียวกัน) <PctChip pct={monthCompare.lastYearPct} /></span>
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
          </div>
        )}

        {/* Monthly summary send button (owner F) */}
        {days.length > 0 && (
          <div className="flex items-center justify-end gap-2">
            {monthSentAt && <span className="text-xs text-emerald-600">✓ ส่งสรุปเดือนแล้ว</span>}
            <button onClick={() => sendMonthly(year, month)} disabled={!hasLineGroup}
              className="btn-success text-sm px-4 py-2 disabled:opacity-50">
              {monthSentAt ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
            </button>
          </div>
        )}

        {days.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลในเดือนนี้ — นำเข้าไฟล์ด้านบน</p>
        ) : (
          <>
            {/* Missing-file summary for the month (owner 2026-09-18). */}
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
          </>
        )}
      </div>

      {/* Insights: weekday pattern (A) + channel mix (E) + discount ROI (D) */}
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
              <h2 className="font-bold text-slate-800">ช่องทางการขายเดือนนี้</h2>
              {channels.types.length > 0 && <ChannelBlock title="ประเภทออเดอร์" slices={channels.types} />}
              {channels.payments.length > 0 && <ChannelBlock title="ช่องทางชำระเงิน" slices={channels.payments} />}
              {channels.sources.length > 1 && <ChannelBlock title="แหล่งที่มา" slices={channels.sources} />}
            </div>
          )}
          {discount && discount.days > 0 && (
            <div className="card space-y-2 lg:col-span-2">
              <h2 className="font-bold text-slate-800">ประสิทธิภาพส่วนลดเดือนนี้</h2>
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
              <p className="text-xs text-slate-500 mt-0.5">แบ่งเมนูตามรายได้ (สูง/ต่ำ) × แนวโน้มเทียบเดือนก่อน (โต/ร่วง) เพื่อวางแผน ดัน/ปรับ/ตัด</p>
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
                    <div className="text-[10px] text-slate-400">เทียบเดือนก่อน <PctChip pct={insights.guests.partyMomPct} /></div>
                  </div>
                  <div className="rounded-xl bg-emerald-50 p-3">
                    <div className="text-[11px] text-slate-500">ยอดใช้จ่ายต่อหัว</div>
                    <div className="text-base font-bold text-emerald-700">{insights.guests.avgSpendPerHead != null ? baht(insights.guests.avgSpendPerHead) : "—"}</div>
                    <div className="text-[10px] text-slate-400">เทียบเดือนก่อน <PctChip pct={insights.guests.spendMomPct} /></div>
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
                  <div><span className="text-slate-500">อัตรา Void</span> <b className={insights.quality.flag ? "text-amber-700" : "text-slate-800"}>{insights.quality.voidRatePct.toFixed(2)}%</b> ของยอดก่อนลด {insights.quality.prevVoidRatePct != null && <span className="text-slate-400">(เดือนก่อน {insights.quality.prevVoidRatePct.toFixed(2)}%)</span>}</div>
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
                  <h2 className="font-bold text-slate-800">เมนูขายดีเชิงจำนวน (จานที่ขายได้)</h2>
                  <p className="text-xs text-slate-500">คนละมุมกับ "เชิงเงิน" — ของถูกที่ขายเยอะช่วยสร้างทราฟฟิก</p>
                  <ol className="space-y-1">
                    {insights.receipt.topUnits.map((u, i) => (
                      <li key={u.name} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-slate-700 truncate">{i + 1}. {u.name}</span>
                        <span className="whitespace-nowrap text-slate-600"><b>{intTh(u.units)}</b> จาน · {intTh(u.bills)} บิล</span>
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

      {/* Day detail */}
      {selDate && daily && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-bold text-slate-800">สรุปยอดขาย · {daily.dateLabel}</h2>
            <div className="flex gap-2">
              {daily.row.has_sales === 1 && (
                <button onClick={() => sendDaily(daily.date)} disabled={!hasLineGroup} className="btn-success text-sm px-4 py-2 disabled:opacity-50">
                  {daily.row.daily_sent_at ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
                </button>
              )}
              <button onClick={() => del(daily.date)} className="btn-danger text-sm px-3 py-2">ลบ</button>
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
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="font-bold text-slate-800">สรุปรายสัปดาห์ (จันทร์–อาทิตย์)</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="btn-secondary text-sm px-3 py-1.5">← สัปดาห์ก่อนหน้า</button>
            <button onClick={() => setWeekStart(mondayOf(todayBkk()))} className="btn-secondary text-sm px-3 py-1.5">สัปดาห์นี้</button>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="btn-secondary text-sm px-3 py-1.5">สัปดาห์ถัดไป →</button>
          </div>
        </div>
        {weekly && (
          <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm text-slate-600">{weekly.label} · รวม {weekly.dayCount} วัน {weeklySentAt ? "· ✓ ส่งแล้ว" : ""}</div>
              <button onClick={() => sendWeekly(weekly.weekStart)} disabled={!hasLineGroup || weekly.dayCount === 0} className="btn-success text-sm px-4 py-2 disabled:opacity-50">
                {weeklySentAt ? "ส่งรายงานผู้บริหารอีกครั้ง" : "ส่งรายงานผู้บริหาร"}
              </button>
            </div>
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
                {baht(m.nett)}{m.isNew ? " · ใหม่" : m.deltaPct != null ? <> · <PctChip pct={m.deltaPct} /></> : ""}
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
      <Cmp parts={[{ label: "เทียบเดือนก่อน", pct: m.prevMonthPct }, { label: "เทียบปีก่อน", pct: m.lastYearPct }]} />
      <PRow label="จำนวนบิลรวม" value={`${intTh(m.totalBills)} บิล`} />
      <PRow label="ลูกค้ารวม" value={`${intTh(m.totalPax)} คน`} />
      {m.avgPerDay != null && <PRow label="เฉลี่ยต่อวัน" value={`${baht(m.avgPerDay)} บาท`} />}
      <PMenu title="เมนูทำรายได้สูงสุดประจำเดือน" list={m.topItems} />
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
