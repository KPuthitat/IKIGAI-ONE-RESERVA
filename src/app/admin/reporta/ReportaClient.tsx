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
  prevDate: string | null; nettVsPrevPct: number | null;
  avg7Nett: number | null; avg7Days: number; nettVs7Pct: number | null;
  topItems: MenuRank[]; bottomItems: MenuRank[]; topCategories: MenuRank[];
};
type WeeklyAnalytics = {
  weekStart: string; weekEnd: string; label: string;
  days: Array<{ date: string; dateLabel: string; nett: number; billCount: number; pax: number }>;
  dayCount: number; totalNett: number; totalBills: number; totalPax: number; totalDiscount: number;
  avgPerDay: number | null; avgPerBill: number | null; bestDate: string | null; bestNett: number | null;
  topItems: MenuRank[]; topCategories: MenuRank[];
};

function Trend({ label, pct }: { label: string; pct: number | null }) {
  if (pct == null) return <span className="text-xs text-slate-400">{label}: ไม่มีข้อมูลเทียบ</span>;
  const up = pct >= 0;
  return <span className={`text-xs font-semibold ${up ? "text-emerald-600" : "text-rose-600"}`}>{label}: {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%</span>;
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

  const loadMonth = useCallback(async () => {
    const r = await fetch(`/api/admin/reporta/view?year=${year}&month=${month}`).then((x) => x.json());
    if (r.ok) { setDays(r.view.days); setHasLineGroup(r.hasLineGroup); }
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
    const files = fileRef.current?.files;
    if (!files || !files.length) { setMsg({ kind: "err", text: "เลือกไฟล์ก่อน" }); return; }
    setBusy(true); setMsg(null);
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("file", f));
    try {
      const r = await fetch("/api/admin/reporta/import", { method: "POST", body: fd }).then((x) => x.json());
      if (!r.ok) { setMsg({ kind: "err", text: r.message ?? r.error ?? "นำเข้าไม่สำเร็จ" }); }
      else {
        const lines = r.imported.map((i: { kind: string; date: string; note: string }) => `${i.kind === "close_up" ? "ยอดขาย" : "เมนู"} · ${thaiDate(i.date)} · ${i.note}`);
        setMsg({ kind: "ok", text: `นำเข้าสำเร็จ: ${lines.join(" / ")}` });
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

      {/* Import */}
      <div className="card space-y-3">
        <h2 className="font-bold text-slate-800">นำเข้าไฟล์จาก POS</h2>
        <p className="text-sm text-slate-500">เลือกได้ทั้งไฟล์ <b>Close up</b> (ยอดขาย) และ <b>Overview</b> (เมนู) พร้อมกัน — ระบบแยกประเภทและวันที่ให้เอง</p>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileRef} type="file" accept=".xlsx" multiple className="text-sm" />
          <button onClick={upload} disabled={busy} className="btn-primary text-sm disabled:opacity-50">{busy ? "กำลังนำเข้า…" : "นำเข้า"}</button>
        </div>
      </div>

      {/* Month list */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <button onClick={() => shiftMonth(-1)} className="btn-secondary text-sm px-3 py-1.5">←</button>
          <h2 className="font-bold text-slate-800">{TH_MONTHS[month]} {year + 543}</h2>
          <button onClick={() => shiftMonth(1)} className="btn-secondary text-sm px-3 py-1.5">→</button>
        </div>
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
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Kpi label="ยอดขายสุทธิ" value={baht(daily.row.nett)} accent />
                <Kpi label="จำนวนบิล" value={`${intTh(daily.row.bill_count)} บิล`} />
                <Kpi label="ลูกค้า" value={`${intTh(daily.row.pax)} คน`} />
                <Kpi label="เฉลี่ยต่อบิล" value={baht(daily.row.avg_sales)} />
                <Kpi label="เฉลี่ยต่อหัว" value={baht(daily.row.avg_sales_pax)} />
                <Kpi label="ส่วนลด" value={`${baht(Math.abs(daily.row.discount))}${daily.discountPct != null ? ` (${daily.discountPct.toFixed(1)}%)` : ""}`} />
                <Kpi label="ยกเลิกบิล (Void)" value={`${baht(daily.row.void_amount)} · ${intTh(daily.row.void_bill_count)}`} />
                <Kpi label="VAT / Service" value={`${baht(daily.row.vat)} / ${baht(daily.row.service_charge)}`} />
              </div>
              <div className="flex gap-4 flex-wrap">
                <Trend label="เทียบวันก่อน" pct={daily.nettVsPrevPct} />
                <Trend label={`เทียบเฉลี่ย ${daily.avg7Days} วัน`} pct={daily.nettVs7Pct} />
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
              </>
            )}
          </>
        )}
      </div>

      {pin && <PinModal title={pin.title} onConfirm={pin.run} onClose={() => setPin(null)} />}
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-3 ${accent ? "bg-emerald-50" : "bg-slate-50"}`}>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-base font-bold ${accent ? "text-emerald-700" : "text-slate-800"}`}>{value}</div>
    </div>
  );
}
