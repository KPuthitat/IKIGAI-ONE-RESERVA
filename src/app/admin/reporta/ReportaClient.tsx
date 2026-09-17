"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

type MonthDay = { date: string; nett: number; billCount: number; pax: number; hasSales: boolean; hasMenu: boolean; dailySentAt: string | null };
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
};
type MetricCompare = { key: string; label: string; value: number; kind: "baht" | "int"; wowPct: number | null; momPct: number | null };
type MonthCompare = { throughDay: number; mtdNett: number; prevMonthNett: number | null; prevMonthPct: number | null; lastYearNett: number | null; lastYearPct: number | null };
type MenuMomentum = { name: string; thisNett: number; prevNett: number; deltaPct: number | null; isNew: boolean };
type WeeklyAnalytics = {
  weekStart: string; weekEnd: string; label: string;
  days: Array<{ date: string; dateLabel: string; nett: number; billCount: number; pax: number }>;
  dayCount: number; totalNett: number; totalBills: number; totalPax: number; totalDiscount: number;
  avgPerDay: number | null; avgPerBill: number | null; bestDate: string | null; bestNett: number | null;
  topItems: MenuRank[]; topCategories: MenuRank[];
  menuRisers: MenuMomentum[]; menuFallers: MenuMomentum[];
};
type WeekdayStat = { dow: number; label: string; avgNett: number; days: number; avgBills: number };
type DiscountInsight = { avgDiscountPct: number | null; totalDiscount: number; highDiscAvgNett: number | null; lowDiscAvgNett: number | null; days: number };
type ChannelSlice = { name: string; sales: number; qty: number; pct: number };
type ChannelMix = { types: ChannelSlice[]; payments: ChannelSlice[]; sources: ChannelSlice[] };
type MonthTarget = { target: number; mtdNett: number; throughDay: number; daysInMonth: number; pctOfTarget: number; projectedNett: number; projectedPct: number; onTrack: boolean };

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
function PinModal({ title, onConfirm, onClose }: { title: string; onConfirm: (pin: string) => Promise<{ ok: boolean; message?: string }>; onClose: () => void }) {
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
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5 space-y-3">
        <h3 className="font-bold text-slate-800">{title}</h3>
        <p className="text-sm text-slate-500">การ์ดสรุปจะถูกส่งเข้ากลุ่ม LINE หัวหน้างาน (HOD) — ยืนยันด้วย PIN</p>
        <div>
          <label className="label">PIN (4 หลัก)</label>
          <input type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={4} value={pin}
            onChange={(e) => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setErr(null); }}
            className="input" />
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

export default function ReportaClient({ branchName }: { branchName: string }) {
  const initial = todayBkk();
  const [year, setYear] = useState(Number(initial.slice(0, 4)));
  const [month, setMonth] = useState(Number(initial.slice(5, 7)));
  const [days, setDays] = useState<MonthDay[]>([]);
  const [monthCompare, setMonthCompare] = useState<MonthCompare | null>(null);
  const [weekdays, setWeekdays] = useState<WeekdayStat[]>([]);
  const [discount, setDiscount] = useState<DiscountInsight | null>(null);
  const [channels, setChannels] = useState<ChannelMix | null>(null);
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
  const [pin, setPin] = useState<null | { title: string; run: (pin: string) => Promise<{ ok: boolean; message?: string }> }>(null);
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
      setMonthTarget(r.monthTarget ?? null); setMonthSentAt(r.monthSentAt ?? null);
    }
  }, [year, month]);

  const loadDay = useCallback(async (date: string) => {
    setSelDate(date); setDaily(null);
    const r = await fetch(`/api/admin/reporta/view?date=${date}`).then((x) => x.json());
    if (r.ok) setDaily(r.daily); else setMsg({ kind: "err", text: r.message ?? "โหลดข้อมูลวันไม่สำเร็จ" });
  }, []);

  const loadWeek = useCallback(async (ws: string) => {
    const r = await fetch(`/api/admin/reporta/view?week=${ws}`).then((x) => x.json());
    if (r.ok) { setWeekly(r.weekly); setWeeklySentAt(r.weeklySentAt); }
  }, []);

  useEffect(() => { loadMonth(); }, [loadMonth]);
  useEffect(() => { loadWeek(weekStart); }, [weekStart, loadWeek]);

  const upload = async () => {
    if (!picked.length) { setMsg({ kind: "err", text: "เลือกไฟล์ก่อน" }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    picked.forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/admin/reporta/import", { method: "POST", body: fd }).then((x) => x.json());
      if (!r.ok) { setMsg({ kind: "err", text: r.message ?? r.error ?? "นำเข้าไม่สำเร็จ" }); }
      else {
        const lines = r.imported.map((i: { kind: string; date: string; note: string }) => `${i.kind === "close_up" ? "ยอดขาย" : "เมนู"} · ${thaiDate(i.date)} · ${i.note}`);
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

  const del = async (date: string) => {
    if (!confirm(`ลบข้อมูลยอดขาย + เมนูของวันที่ ${thaiDate(date)} ?`)) return;
    setBusy(true);
    const r = await fetch("/api/admin/reporta/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date }) }).then((x) => x.json());
    setBusy(false);
    if (r.ok) { setMsg({ kind: "ok", text: `ลบข้อมูลวันที่ ${thaiDate(date)} แล้ว` }); if (selDate === date) { setSelDate(null); setDaily(null); } await loadMonth(); await loadWeek(weekStart); }
    else setMsg({ kind: "err", text: r.message ?? "ลบไม่สำเร็จ" });
  };

  const sendDaily = (date: string) => setPin({
    title: `ส่งสรุปยอดขายวันที่ ${thaiDate(date)}`,
    run: async (p) => {
      const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "daily", date, pin: p }) }).then((x) => x.json());
      if (r.ok) { setMsg({ kind: "ok", text: "ส่งสรุปรายวันเข้ากลุ่ม HOD แล้ว" }); await loadMonth(); if (selDate === date) await loadDay(date); }
      return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
    }
  });

  const sendWeekly = (ws: string) => setPin({
    title: `ส่งสรุปสัปดาห์ ${weekly?.label ?? ""}`,
    run: async (p) => {
      const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "weekly", week: ws, pin: p }) }).then((x) => x.json());
      if (r.ok) { setMsg({ kind: "ok", text: "ส่งสรุปรายสัปดาห์เข้ากลุ่ม HOD แล้ว" }); await loadWeek(ws); }
      return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
    }
  });

  const sendMonthly = (y: number, m: number) => setPin({
    title: `ส่งสรุปเดือน ${TH_MONTHS[m]} ${y + 543}`,
    run: async (p) => {
      const r = await fetch("/api/admin/reporta/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "monthly", year: y, month: m, pin: p }) }).then((x) => x.json());
      if (r.ok) { setMsg({ kind: "ok", text: "ส่งสรุปรายเดือนเข้ากลุ่ม HOD แล้ว" }); await loadMonth(); }
      return r.ok ? { ok: true } : { ok: false, message: r.message ?? r.error };
    }
  });

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
          <span className="text-[11px] text-slate-400">รองรับ .xlsx · เลือกหลายไฟล์ได้</span>
        </div>
        <input ref={fileRef} type="file" accept=".xlsx" multiple className="hidden"
          onChange={(e) => addFiles(e.target.files)} />
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
          <div className="mt-1 text-xs text-slate-400">ไฟล์ <b>Close up</b> (ยอดขาย) และ <b>Overview</b> (เมนู) พร้อมกันได้ — ระบบแยกประเภทและวันที่ให้เอง</div>
        </div>

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

        <div className="flex items-center gap-2">
          <button onClick={upload} disabled={busy || picked.length === 0}
            className="btn-primary text-sm disabled:opacity-50">{busy ? "กำลังนำเข้า…" : `นำเข้า${picked.length ? ` (${picked.length})` : ""}`}</button>
          {picked.length > 0 && !busy && (
            <button onClick={() => setPicked([])} className="text-xs text-slate-400 hover:text-slate-600">ล้างรายการ</button>
          )}
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
              {monthSentAt ? "ส่งซ้ำสรุปเดือนเข้ากลุ่ม HOD" : "ส่งสรุปเดือนเข้ากลุ่ม HOD"}
            </button>
          </div>
        )}

        {days.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-4">ยังไม่มีข้อมูลในเดือนนี้ — นำเข้าไฟล์ด้านบน</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {days.map((d) => (
              <div key={d.date} className={`flex items-center justify-between gap-2 py-2 cursor-pointer ${selDate === d.date ? "bg-emerald-50 -mx-2 px-2 rounded" : ""}`} onClick={() => loadDay(d.date)}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">{thaiDate(d.date)}</div>
                  <div className="text-xs text-slate-500">
                    {d.hasSales ? `${intTh(d.billCount)} บิล · ${intTh(d.pax)} คน` : "ยังไม่มียอดขาย"}
                    {d.hasMenu ? " · มีเมนู" : ""}
                    {d.dailySentAt ? " · ✓ ส่งแล้ว" : ""}
                  </div>
                </div>
                <div className="text-right whitespace-nowrap">
                  <div className="text-sm font-bold text-slate-900">{d.hasSales ? baht(d.nett) : "—"}</div>
                </div>
              </div>
            ))}
          </div>
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

      {/* Day detail */}
      {selDate && daily && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="font-bold text-slate-800">สรุปยอดขาย · {daily.dateLabel}</h2>
            <div className="flex gap-2">
              {daily.row.has_sales === 1 && (
                <button onClick={() => sendDaily(daily.date)} disabled={!hasLineGroup} className="btn-success text-sm px-4 py-2 disabled:opacity-50">
                  {daily.row.daily_sent_at ? "ส่งซ้ำเข้ากลุ่ม HOD" : "ส่งสรุปวันนี้เข้ากลุ่ม HOD"}
                </button>
              )}
              <button onClick={() => del(daily.date)} className="btn-danger text-sm px-3 py-2">ลบ</button>
            </div>
          </div>

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
              <MenuList title="🍽️ เมนูทำรายได้สูงสุด" list={daily.topItems} />
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
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} className="btn-secondary text-sm px-3 py-1.5">← สัปดาห์ก่อน</button>
            <button onClick={() => setWeekStart(mondayOf(addDays(todayBkk(), -7)))} className="btn-secondary text-sm px-3 py-1.5">สัปดาห์ที่แล้ว</button>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} className="btn-secondary text-sm px-3 py-1.5">สัปดาห์ถัดไป →</button>
          </div>
        </div>
        {weekly && (
          <>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-sm text-slate-600">{weekly.label} · รวม {weekly.dayCount} วัน {weeklySentAt ? "· ✓ ส่งแล้ว" : ""}</div>
              <button onClick={() => sendWeekly(weekly.weekStart)} disabled={!hasLineGroup || weekly.dayCount === 0} className="btn-success text-sm px-4 py-2 disabled:opacity-50">
                {weeklySentAt ? "ส่งซ้ำเข้ากลุ่ม HOD" : "ส่งสรุปสัปดาห์เข้ากลุ่ม HOD"}
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
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-bold text-slate-600 mb-1">ยอดขายรายวัน</div>
                    {weekly.days.map((d) => (
                      <div key={d.date} className={`flex justify-between text-sm ${d.date === weekly.bestDate ? "font-bold text-emerald-700" : ""}`}>
                        <span className="text-slate-600">{d.dateLabel}{d.date === weekly.bestDate ? " ⭐" : ""}</span><span>{baht(d.nett)}</span>
                      </div>
                    ))}
                  </div>
                  <MenuList title="🍽️ เมนูทำรายได้สูงสุดประจำสัปดาห์" list={weekly.topItems} />
                </div>
                {(weekly.menuRisers.length > 0 || weekly.menuFallers.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-4">
                    <MomentumList title="🔥 เมนูมาแรง (เทียบสัปดาห์ก่อน)" list={weekly.menuRisers} up />
                    <MomentumList title="📉 เมนูร่วง (เทียบสัปดาห์ก่อน)" list={weekly.menuFallers} />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {pin && <PinModal title={pin.title} onConfirm={pin.run} onClose={() => setPin(null)} />}
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
            <span className="w-28 text-right text-xs text-slate-700 shrink-0">{baht(s.sales)} · {s.pct.toFixed(0)}%</span>
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
