"use client";

import { useState, useRef, useEffect, Fragment } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { humanizeApiError } from "@/lib/error-messages";
import { fmtMoney } from "@/lib/format";
import { roundLabel, mondayOf, matchMissingCategories, TH_MONTHS_FULL, salesBaseIncludesVat, salesVat, partnerShopName, type Tier, type SalesBase } from "@/lib/revshare";
import PinPromptModal from "@/app/components/PinPromptModal";
import { useConfirm } from "@/app/components/useConfirm";
import type { MonthSalesForecast, ShopShare } from "@/lib/revshare-forecast";
import { DailyCardPreview, WeeklyCardPreview, DrinkWelfareCardPreview, SendPreviewModal } from "./CardPreviews";

// Calendar-day span (inclusive) between two ISO dates — mirrors the notify
// route's daySpan so the weekly preview's "รวม N วัน" matches the sent card.
const daySpan = (start: string, end: string) =>
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;

type DrinkSummary = { count: number; total: number; byTier: Array<{ amount: number; count: number; subtotal: number }>; cashCount: number; cashTotal: number };
type DrinkWelfareData = {
  weeks: Array<{ weekStart: string; start: string; end: string; label: string; summary: DrinkSummary }>;
  month: DrinkSummary;
};

type Partner = { id: number; name: string; sales_base: SalesBase; pos_categories: string[]; line_group_id: string | null; vat_enabled: boolean; vat_rate: number };
type Round = {
  id: number; period_start: string; period_end: string; label: string | null;
  sales_amount: number; source: "manual" | "pos_import"; source_filename: string | null;
  sent_at: string | null; bill_count: number | null;
};
type CatchupBreakdown = { dates: string[]; categories: Array<{ name: string; sales: number; share: number; allocated: number }>; analyticaMissing: boolean; exact?: Array<{ name: string; value: number }> | null };
type Catchup = {
  id: number; sales_from: string | null; sales_to: string | null; counted_date: string; sales_amount: number;
  source: "manual" | "pos_import"; source_filename: string | null; bill_count: number | null; note: string | null; sent_at: string | null; breakdown: CatchupBreakdown | null;
};
type PosCat = { category: string; qty: number; gross: number; afterDiscount: number; nett: number };
type PosPreview = { filename: string; periodStart: string | null; periodEnd: string | null; label: string | null; categories: PosCat[] };
const BASE_LABEL: Record<SalesBase, string> = { gross: "Gross (ก่อนส่วนลด)", after_discount: "หลังหักส่วนลด", nett: "Nett (รวม VAT)" };
const PIN_ERRORS = new Set(["wrong_pin", "pin_invalid", "no_pin", "user_not_found"]);

export default function RoundsClient({
  partner, rounds: initialRounds, catchups: initialCatchups, year, month, operatorName, sellerName, drinkWelfare, monthForecast, shopShare
}: { partner: Partner; tiers: Tier[]; rounds: Round[]; catchups: Catchup[]; year: number; month: number; operatorName: string; sellerName: string; drinkWelfare: DrinkWelfareData | null; monthForecast: MonthSalesForecast | null; shopShare: ShopShare }) {
  const { confirm, ConfirmDialog } = useConfirm();
  const router = useRouter();
  const [rounds, setRounds] = useState<Round[]>(initialRounds);
  const [catchups, setCatchups] = useState<Catchup[]>(initialCatchups);
  // 'catchup' = the file being previewed is ยอดตกสำรวจ (a missed day found later), not today's daily row.
  const [importKind, setImportKind] = useState<"daily" | "catchup">("daily");
  // What is already recorded inside the catch-up file's span (daily rows + earlier catch-ups) — the file's total minus this is what is missing.
  const [recon, setRecon] = useState<{ dailyTotal: number; dailyDays: number; catchupTotal: number; catchupCount: number; missingDates: string[]; categories: Array<{ name: string; sales: number }>; analyticaMissing: boolean } | null>(null);
  const [cuOpen, setCuOpen] = useState(false);
  const [cuFrom, setCuFrom] = useState(""); const [cuTo, setCuTo] = useState("");
  const [cuAmount, setCuAmount] = useState(""); const [cuNote, setCuNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // LINE notify (daily / weekly) — owner 2026-06-24: preview the card in a modal,
  // confirm with PIN, then send. `sentKey` flashes a ✓ on the row after success.
  const [sentKey, setSentKey] = useState<string | null>(null);
  const [sendModal, setSendModal] = useState<{ key: string; heading: string; preview: React.ReactNode; body: Record<string, unknown> } | null>(null);
  const shop = partnerShopName(partner);
  const vatRate = partner.vat_enabled ? partner.vat_rate : 0;

  // ── Flexible transfer round (owner 2026-08-01) ──────────────────────
  // Settle a custom [start, end] span (from the day after the last transfer up
  // to a chosen date, may cross a month) instead of the fixed Mon–Sun bucket.
  type XferPreview = {
    label: string; start: string; end: string; dayCount: number;
    rows: Array<{ date: string; sales: number; sent: boolean; billCount: number | null }>;
    totalSales: number; vatEnabled: boolean; vat: { base: number; vat: number; total: number };
    alreadySentCount: number; suggestedStart: string | null; suggestedEnd: string | null;
    catchups: Array<{ id: number; countedDate: string; salesFrom: string | null; salesTo: string | null; sales: number; sent: boolean; note: string | null }>;
    catchupTotal: number; catchupCategories: string;
  };
  const [xferOpen, setXferOpen] = useState(false);
  const [xferStart, setXferStart] = useState("");
  const [xferEnd, setXferEnd] = useState("");
  const [xferPreview, setXferPreview] = useState<XferPreview | null>(null);
  const [xferLoading, setXferLoading] = useState(false);
  const [xferMsg, setXferMsg] = useState<string | null>(null);
  const [xferPinOpen, setXferPinOpen] = useState(false);

  async function loadXfer(start?: string, end?: string) {
    setXferLoading(true); setXferMsg(null);
    try {
      const q = new URLSearchParams({ partner: String(partner.id) });
      if (start) q.set("start", start);
      if (end) q.set("end", end);
      const res = await fetch(apiUrl(`/api/accounta/revshare/transfer-round?${q.toString()}`));
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setXferPreview(j.preview as XferPreview);
        setXferStart(j.preview.start); setXferEnd(j.preview.end);
      } else {
        setXferPreview(null);
        setXferMsg(humanizeApiError(j, "โหลดสรุปไม่สำเร็จ"));
      }
    } finally { setXferLoading(false); }
  }
  function openXfer() { setXferOpen(true); setXferPreview(null); setXferMsg(null); void loadXfer(); }
  async function confirmXfer(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const res = await fetch(apiUrl("/api/accounta/revshare/transfer-round"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partner: partner.id, start: xferStart, end: xferEnd, pin })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) {
      if (PIN_ERRORS.has(j.error)) return { ok: false, message: "PIN ไม่ถูกต้อง" };
      return { ok: false, message: humanizeApiError(j, "บันทึกไม่สำเร็จ") };
    }
    setXferPinOpen(false); setXferOpen(false);
    router.refresh();
    return { ok: true };
  }

  // PIN gate — verify once, reuse for the session; re-prompt if the server
  // rejects it. Records the operator on every import/edit/delete.
  const pinRef = useRef<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [pinRun, setPinRun] = useState<{ run: (pin: string) => Promise<{ ok: boolean; pinError?: boolean }> } | null>(null);
  // A locked round's amount is read-only until "แก้ไข" unlocks its row (PIN).
  // Imported (pos_import) and sent rounds are locked; manual rows stay editable.
  const [editingId, setEditingId] = useState<number | null>(null);
  const isLocked = (r: Round) => r.source === "pos_import" || r.sent_at != null;

  // POS import
  const [preview, setPreview] = useState<PosPreview | null>(null);
  const [selCats, setSelCats] = useState<Set<string>>(new Set());
  const [base, setBase] = useState<SalesBase>(partner.sales_base);
  // Category selection is pre-filled from the partner's settings and LOCKED;
  // changing it requires a PIN (owner 2026-06-23).
  const [catsLocked, setCatsLocked] = useState(true);

  const totalSales = rounds.reduce((s, r) => s + r.sales_amount, 0);
  // Group daily entries into ISO weeks (the weekly TRANSFER amount).
  const weekMap = new Map<string, Round[]>();
  for (const r of [...rounds].sort((a, b) => a.period_start.localeCompare(b.period_start))) {
    const wk = mondayOf(r.period_start);
    (weekMap.get(wk) ?? weekMap.set(wk, []).get(wk)!).push(r);
  }
  // ยอดตกสำรวจ join the week they were recorded in, as a separate amount (never mixed into the daily rows).
  const catchupTotal = catchups.reduce((s, c) => s + c.sales_amount, 0);
  const cuByWeek = new Map<string, Catchup[]>();
  for (const c of catchups) { const wk = mondayOf(c.counted_date); (cuByWeek.get(wk) ?? cuByWeek.set(wk, []).get(wk)!).push(c); }
  const weekKeys = [...new Set([...weekMap.keys(), ...cuByWeek.keys()])].sort();
  const weeks = weekKeys.map((wk) => {
    const rs = weekMap.get(wk) ?? [];
    const cs = cuByWeek.get(wk) ?? [];
    const dates = [...rs.map((r) => r.period_start), ...(rs.length ? [] : cs.map((c) => c.counted_date))].sort();
    const first = dates[0], last = dates[dates.length - 1];
    const cu = cs.reduce((s, c) => s + c.sales_amount, 0);
    const cuNames: string[] = [];
    for (const c of cs) { const b = c.breakdown; if (!b) continue; const list = b.exact?.length ? b.exact.map((e) => e.name) : b.analyticaMissing ? [] : b.categories.slice(0, 4).map((x) => x.name); for (const n of list) if (!cuNames.includes(n)) cuNames.push(n); }
    return { wk, rounds: rs, catchup: cu, catchupCats: cuNames.join(", "), first, last, total: rs.reduce((s, r) => s + r.sales_amount, 0) + cu, label: roundLabel(first, last) };
  });

  function go(y: number, m: number) { router.push(`/admin/accounta/revshare/rounds?partner=${partner.id}&year=${y}&month=${m}`); }
  function shift(delta: number) { const d = new Date(Date.UTC(year, month - 1 + delta, 1)); go(d.getUTCFullYear(), d.getUTCMonth() + 1); }

  // Low-level mutate: returns {ok, pinError}. Non-PIN errors are surfaced on the
  // page; PIN errors bubble up so the modal can ask again.
  async function mutate(method: "POST" | "PATCH" | "DELETE", body?: unknown, qs?: string): Promise<{ ok: boolean; pinError?: boolean }> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/revshare/rounds${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { if (j.rounds) setRounds(j.rounds); router.refresh(); return { ok: true }; }
      const pinError = PIN_ERRORS.has(j.error);
      if (!pinError) setErr(humanizeApiError(j, "ทำรายการไม่สำเร็จ"));
      return { ok: false, pinError };
    } finally { setBusy(false); }
  }

  // Run a PIN-stamped action. Reuse the verified PIN silently; re-prompt only if
  // the server rejects it (or none is cached yet). forcePrompt always shows the
  // modal — used for import so every file is consciously confirmed (owner
  // 2026-06-23: "บางครั้งไม่ถาม PIN บันทึกให้เลย").
  async function guarded(run: (pin: string) => Promise<{ ok: boolean; pinError?: boolean }>, opts?: { forcePrompt?: boolean }) {
    if (pinRef.current && !opts?.forcePrompt) {
      const r = await run(pinRef.current);
      if (r.ok || !r.pinError) return;
      pinRef.current = null; setVerified(false);
    }
    setPinRun({ run });
  }
  async function onPinSubmit(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const r = await pinRun!.run(pin);
    if (r.ok) { pinRef.current = pin; setVerified(true); setPinRun(null); return { ok: true }; }
    if (r.pinError) return { ok: false, message: "pin_invalid" };
    setPinRun(null);                      // non-PIN error already shown on page
    return { ok: true };
  }

  // Verify the caller's own PIN without a DB write (used to unlock category edit).
  async function verifyPin(pin: string): Promise<{ ok: boolean; pinError?: boolean }> {
    const res = await fetch(apiUrl("/api/auth/verify-pin"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin })
    });
    return { ok: res.ok, pinError: !res.ok };
  }
  function unlockCats() {
    void guarded(async (pin) => { const r = await verifyPin(pin); if (r.ok) setCatsLocked(false); return r; });
  }

  // Unlock a locked row for editing — a fresh PIN is required, then its field
  // becomes editable (and re-locks on blur). owner 2026-07-25.
  function unlockEdit(r: Round) {
    void guarded(async (pin) => {
      const res = await verifyPin(pin);
      if (res.ok) setEditingId(r.id);
      return res;
    }, { forcePrompt: true });
  }
  async function saveSales(r: Round, value: string) {
    const v = Number(value);
    if (!Number.isFinite(v) || v === r.sales_amount) return;
    // PIN is already verified via unlockEdit for locked rows; manual rows prompt
    // through guarded here.
    await guarded((pin) => mutate("PATCH", { id: r.id, partner: partner.id, sales_amount: v, pin }));
  }
  async function del(r: Round) {
    const locked = isLocked(r);
    const ok = await confirm({
      title: locked ? "ยอดนี้ถูกล็อก" : "ยืนยันการลบ",
      body: locked
        ? `ลบยอดวันที่ ${roundLabel(r.period_start, r.period_start)} ที่ล็อกไว้? ต้องยืนยัน PIN`
        : `ลบยอดวันที่ ${roundLabel(r.period_start, r.period_start)} ?`,
      confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger"
    });
    if (ok === null) return;
    await guarded(async (pin) => {
      const res = await mutate("DELETE", undefined, `?id=${r.id}&partner=${partner.id}&pin=${encodeURIComponent(pin)}`);
      // DELETE doesn't echo the list back — drop the row locally so it disappears
      // immediately (no manual refresh, owner 2026-06-23).
      if (res.ok) setRounds((rs) => rs.filter((x) => x.id !== r.id));
      return res;
    }, { forcePrompt: locked });
  }

  // Confirm + send the card that's currently previewed in the send modal. The
  // notify route verifies the PIN for daily/weekly server-side.
  async function confirmSend(pin: string): Promise<{ ok: boolean; message?: string }> {
    if (!sendModal) return { ok: false };
    const res = await fetch(apiUrl("/api/accounta/revshare/notify"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partner: partner.id, year, month, ...sendModal.body, pin })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) {
      const key = sendModal.key;
      setSentKey(key); setTimeout(() => setSentKey((k) => (k === key ? null : k)), 2200);
      // Daily sends lock the round — reflect sent_at locally so the appears
      // without a refresh (owner 2026-07-25).
      const sentDate = sendModal.body.kind === "daily" ? (sendModal.body.date as string) : null;
      if (sentDate) setRounds((rs) => rs.map((x) => x.period_start === sentDate ? { ...x, sent_at: new Date().toISOString() } : x));
      setSendModal(null);
      return { ok: true };
    }
    if (PIN_ERRORS.has(j.error)) return { ok: false, message: "pin_invalid" };
    return { ok: false, message: humanizeApiError(j, "ส่ง LINE ไม่สำเร็จ") };
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>, kind: "daily" | "catchup" = "daily") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append("file", file);
      const res = await fetch(apiUrl("/api/accounta/revshare/pos-import"), { method: "POST", body: fd });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setErr(humanizeApiError(j, "อ่านไฟล์ POS ไม่สำเร็จ")); return; }
      setImportKind(kind);
      setRecon(null);
      setPreview({ filename: j.filename, periodStart: j.periodStart, periodEnd: j.periodEnd, label: j.label, categories: j.categories });
      const want = new Set(partner.pos_categories.map((s) => s.toLowerCase()));
      setSelCats(new Set(j.categories.filter((c: PosCat) => want.has(c.category.toLowerCase())).map((c: PosCat) => c.category)));
      setBase(partner.sales_base);
      setCatsLocked(true);   // re-lock for every new file
    } finally { setBusy(false); }
  }
  // Reconcile a catch-up file against what is already recorded; re-read when the category selection changes so the
  // "which categories" split follows the ticked categories (owner 2026-10-17).
  useEffect(() => {
    if (importKind !== "catchup" || !preview?.periodStart || !preview?.periodEnd) return;
    let alive = true;
    const q = new URLSearchParams({ partner: String(partner.id), from: preview.periodStart, to: preview.periodEnd });
    for (const c of selCats) q.append("cat", c);
    void fetch(apiUrl(`/api/accounta/revshare/catchups?${q.toString()}`)).then((r) => r.json()).then((rj) => {
      if (alive && rj.ok) setRecon({ dailyTotal: rj.dailyTotal, dailyDays: rj.dailyDays, catchupTotal: rj.catchupTotal, catchupCount: rj.catchupCount, missingDates: rj.missingDates ?? [], categories: rj.categories ?? [], analyticaMissing: !!rj.analyticaMissing });
    }).catch(() => { /* leave the previous figures */ });
    return () => { alive = false; };
  }, [importKind, preview, selCats, partner.id]);
  function baseVal(c: PosCat): number { return base === "gross" ? c.gross : base === "after_discount" ? c.afterDiscount : c.nett; }
  const posTotal = preview ? preview.categories.filter((c) => selCats.has(c.category)).reduce((s, c) => s + baseVal(c), 0) : 0;
  // "จำนวนบิล" = Qty summed over the selected categories (owner 2026-07-25).
  const posBills = preview ? preview.categories.filter((c) => selCats.has(c.category)).reduce((s, c) => s + c.qty, 0) : 0;
  const posMultiDay = !!preview && preview.periodStart !== preview.periodEnd;

  // ยอดตกสำรวจ API (own table). On success the list for the CURRENT view is re-read from the server.
  async function mutateCatchup(method: "POST" | "DELETE", body?: unknown, qs?: string): Promise<{ ok: boolean; pinError?: boolean }> {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/accounta/revshare/catchups${qs ?? ""}`), {
        method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        const list = await fetch(apiUrl(`/api/accounta/revshare/catchups?partner=${partner.id}&year=${year}&month=${month}`));
        const lj = await list.json().catch(() => ({}));
        if (list.ok && lj.catchups) setCatchups(lj.catchups);
        router.refresh();
        return { ok: true };
      }
      const pinError = PIN_ERRORS.has(j.error);
      if (!pinError) setErr(j.message ?? humanizeApiError(j, "ทำรายการไม่สำเร็จ"));
      return { ok: false, pinError };
    } finally { setBusy(false); }
  }
  async function addManualCatchup() {
    const amount = Number(cuAmount.replace(/,/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) { setErr("กรอกยอดตกสำรวจให้ถูกต้อง"); return; }
    if ((cuFrom && !cuTo) || (!cuFrom && cuTo)) { setErr("กรอกทั้งวันเริ่มและวันจบ หรือเว้นว่างทั้งคู่ถ้ายังไม่แน่ใจวันที่"); return; }
    await guarded(async (pin) => {
      const r = await mutateCatchup("POST", { partner: partner.id, sales_amount: amount, sales_from: cuFrom || null, sales_to: cuTo || null, note: cuNote || null, source: "manual", pin });
      if (r.ok) { setCuOpen(false); setCuFrom(""); setCuTo(""); setCuAmount(""); setCuNote(""); }
      return r;
    }, { forcePrompt: true });
  }
  async function delCatchup(c: Catchup) {
    const ok = await confirm({ title: "ลบยอดตกสำรวจ", body: `ลบยอดตกสำรวจ ฿${fmtMoney(c.sales_amount)} ที่บันทึกวันที่ ${roundLabel(c.counted_date, c.counted_date)} ?`, confirmLabel: "ลบ", cancelLabel: "ยกเลิก", variant: "danger" });
    if (ok === null) return;
    await guarded((pin) => mutateCatchup("DELETE", undefined, `?id=${c.id}&partner=${partner.id}&pin=${encodeURIComponent(pin)}`), { forcePrompt: true });
  }

  async function confirmImport() {
    if (!preview || !preview.periodStart || !preview.periodEnd) { setErr("ไฟล์ไม่มีวันที่ที่อ่านได้"); return; }
    const ps = preview.periodStart, pe = preview.periodEnd;
    if (importKind === "catchup") {
      await guarded(async (pin) => {
        // The server subtracts what is already recorded for these days, so a whole-span file never double counts.
        const r = await mutateCatchup("POST", { partner: partner.id, sales_from: ps, sales_to: pe, file_total: posTotal, source: "pos_import", source_filename: preview.filename, categories: [...selCats], category_values: preview.categories.filter((c) => selCats.has(c.category)).map((c) => ({ name: c.category, value: baseVal(c) })), pin });
        if (r.ok) setPreview(null);
        return r;
      }, { forcePrompt: true });
      return;
    }
    await guarded(async (pin) => {
      const r = await mutate("POST", {
        partner: partner.id, period_start: ps, period_end: pe,
        sales_amount: posTotal, bill_count: posBills,
        source: "pos_import", source_filename: preview.filename, label: preview.label ?? undefined, pin
      });
      if (r.ok) setPreview(null);
      return r;
    }, { forcePrompt: true });
  }

  return (
    <div className="space-y-4">
      {ConfirmDialog}
      {err && <p className="text-sm text-rose-600">{err}</p>}

      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => shift(-1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">←</button>
        <span className="text-sm font-bold text-slate-700">{TH_MONTHS_FULL[month]} พ.ศ. {year + 543}</span>
        <button type="button" onClick={() => shift(1)} disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">→</button>
      </div>

      <div className="card text-[11px] text-slate-500">
        จังหวะการทำงาน: <b className="text-slate-700">นำเข้าไฟล์ยอดขายประจำวัน</b> → ระบบรวม <b className="text-slate-700">ยอดโอนรายสัปดาห์</b> (จ–อา) ให้อัตโนมัติ → <b className="text-slate-700">สรุปยอด / สร้างใบวางบิล</b> ที่หน้าสรุปยอด
      </div>

      <div className="card flex flex-wrap items-center gap-2">
        <label className="btn-secondary text-sm cursor-pointer">
          นำเข้าไฟล์ยอดขายประจำวัน
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => onFile(e, "daily")} disabled={busy} />
        </label>
        <span className="text-[11px] text-slate-400">
          1 วัน/ไฟล์ · นำเข้าจากไฟล์เท่านั้น (เพิ่มยอดเองไม่ได้) · ยอดจากไฟล์ล็อกไว้ แก้ต้องใส่ PIN
          {verified && <span className="ml-1 text-emerald-600">· ✓ ยืนยันตัวตนแล้ว ({operatorName})</span>}
        </span>
        <span className="flex-1" />
        <button type="button" onClick={openXfer}
          className="rounded-md border border-brand text-brand px-4 py-2 text-sm font-bold hover:bg-brand/5">
          สร้างรอบโอนเอง
        </button>
        <Link href={`/admin/accounta/revshare/settlement?partner=${partner.id}&year=${year}&month=${month}`}
          className="rounded-full bg-brand text-white px-4 py-2 text-sm font-bold hover:opacity-90">
          สรุปยอด / สร้างใบวางบิล →
        </Link>
      </div>

      {/* Sales-file import preview */}
      {preview && (
        <div className="card space-y-3 ring-1 ring-brand/30">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-sm font-bold text-slate-800">{importKind === "catchup" ? "นำเข้ายอดตกสำรวจ" : "นำเข้ายอดขาย"} · {preview.label ?? "(ไม่พบวันที่)"} <span className="text-[11px] font-normal text-slate-400">{preview.filename}</span></div>
            <button type="button" onClick={() => { setPreview(null); setRecon(null); }} className="text-xs text-slate-400 hover:text-slate-700">✕ ยกเลิก</button>
          </div>
          {posMultiDay && <p className="text-[11px] text-amber-700">ไฟล์นี้ครอบหลายวัน ({preview.label}) — จะบันทึกเป็นรายการเดียว ถ้าต้องการรายวันให้ส่งออกจาก POS แบบ 1 วัน/ไฟล์</p>}
          <div className="flex items-center justify-between gap-2 flex-wrap rounded-md bg-slate-50 px-3 py-2">
            <span className="text-[11px] text-slate-500">
              {catsLocked
                ? "ระบบเลือกหมวดตามที่ตั้งค่าไว้ให้แล้ว — กดปลดล็อกด้วย PIN ถ้าต้องการแก้ไขการเลือก"
                : <span className="text-emerald-600">✓ ปลดล็อกแล้ว — แก้ไขหมวด/ฐานยอดได้</span>}
            </span>
            {catsLocked
              ? <button type="button" onClick={unlockCats} disabled={busy} className="text-[11px] text-brand hover:underline">แก้ไขการเลือกหมวด (PIN)</button>
              : <button type="button" onClick={() => setCatsLocked(true)} className="text-[11px] text-slate-400 hover:underline">ล็อกอีกครั้ง</button>}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">ฐานยอดขาย:</span>
            <select className="input w-48 text-sm disabled:bg-slate-100 disabled:text-slate-400" value={base} disabled={catsLocked} onChange={(e) => setBase(e.target.value as SalesBase)}>
              {(Object.keys(BASE_LABEL) as SalesBase[]).map((b) => <option key={b} value={b}>{BASE_LABEL[b]}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-100">
                <th className="text-left py-1.5 px-2">เลือก</th><th className="text-left py-1.5 px-2">หมวด</th>
                <th className="text-right py-1.5 px-2">Gross</th><th className="text-right py-1.5 px-2">หลังส่วนลด</th><th className="text-right py-1.5 px-2">Nett</th>
              </tr></thead>
              <tbody>
                {preview.categories.map((c) => (
                  <tr key={c.category} className="border-b border-slate-50">
                    <td className="py-1.5 px-2"><input type="checkbox" checked={selCats.has(c.category)} disabled={catsLocked} onChange={(e) => {
                      setSelCats((s) => { const n = new Set(s); if (e.target.checked) n.add(c.category); else n.delete(c.category); return n; });
                    }} /></td>
                    <td className="py-1.5 px-2 text-slate-700">{c.category}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.gross)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.afterDiscount)}</td>
                    <td className="py-1.5 px-2 text-right font-mono">{fmtMoney(c.nett)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {importKind === "catchup" && recon && (() => {
            const missing = Math.round((posTotal - recon.dailyTotal - recon.catchupTotal) * 100) / 100;
            return (
              <div className={`rounded-xl border px-3 py-2 text-sm space-y-0.5 ${missing >= 0.01 ? "border-amber-300 bg-amber-50" : "border-rose-200 bg-rose-50"}`}>
                <div className="flex justify-between"><span className="text-slate-600">ยอดรวมในไฟล์ (หมวด/ฐานที่เลือก)</span><span className="font-mono">฿{fmtMoney(posTotal)}</span></div>
                <div className="flex justify-between"><span className="text-slate-600">หัก ยอดรายวันที่นำเข้าแล้วในช่วงนี้ ({recon.dailyDays} วัน)</span><span className="font-mono">− ฿{fmtMoney(recon.dailyTotal)}</span></div>
                {recon.catchupTotal > 0 && <div className="flex justify-between"><span className="text-slate-600">หัก ยอดตกสำรวจเดิมของช่วงนี้ ({recon.catchupCount} รายการ)</span><span className="font-mono">− ฿{fmtMoney(recon.catchupTotal)}</span></div>}
                <div className="flex justify-between border-t border-amber-200 pt-1 font-bold"><span>ยอดที่ตกหล่น (จะบันทึกเป็นยอดตกสำรวจ)</span><span className="font-mono">฿{fmtMoney(Math.max(missing, 0))}</span></div>
                {missing < 0.01 && <p className="text-[11px] text-rose-600">{missing < -0.009 ? "ยอดรายวันที่นำเข้าไว้แล้วมากกว่ายอดในไฟล์ — ตรวจหมวดสินค้า/ฐานยอดขายให้ตรงกับที่ใช้นำเข้ารายวัน" : "ไม่พบยอดที่ตกหล่นในช่วงนี้"}</p>}
                {missing >= 0.01 && (() => {
                  // The shortfall equals one (or a few) of the file's categories to the satang → that category was left
                  // out of the daily imports. Stated first because it is the direct answer.
                  const exact = matchMissingCategories(preview.categories.filter((c) => selCats.has(c.category)).map((c) => ({ name: c.category, value: baseVal(c) })), missing);
                  return exact ? (
                    <div className="mt-2 rounded-lg bg-white/70 px-2.5 py-1.5 text-[12px] text-slate-800">
                      <b>ตกสำรวจจากหมวด: {exact.map((e) => e.name).join(", ")}</b> — ยอดที่ขาด ฿{fmtMoney(missing)} ตรงกับยอดของหมวดนี้ในไฟล์พอดี ({exact.map((e) => `฿${fmtMoney(e.value)}`).join(" + ")}) น่าจะเป็นหมวดที่ไม่ได้เลือกตอนนำเข้ารายวัน
                    </div>
                  ) : null;
                })()}
                {missing >= 0.01 && (
                  <div className="mt-2 border-t border-amber-200 pt-2 space-y-1">
                    <div className="text-[11px] font-bold text-slate-700">ตกสำรวจจากวันและหมวดไหน (อ้างอิง ANALYTICA)</div>
                    <div className="text-[11px] text-slate-600">
                      วันที่ในช่วงนี้ที่ไม่มียอดรายวัน ({recon.missingDates.length} วัน): {recon.missingDates.length ? recon.missingDates.map((d) => roundLabel(d, d)).join(", ") : "ไม่มี — ผลต่างอาจมาจากยอดของวันที่นำเข้าไปไม่ครบ"}
                    </div>
                    {recon.analyticaMissing ? (
                      <div className="text-[11px] text-slate-500">ANALYTICA ยังไม่มียอดขายแยกหมวดของวันเหล่านี้ จึงแยกหมวดให้ไม่ได้</div>
                    ) : (() => {
                      const total = recon.categories.reduce((s, c) => s + c.sales, 0);
                      return (
                        <table className="w-full text-[11px]">
                          <thead><tr className="text-slate-400"><th className="text-left font-normal">หมวด</th><th className="text-right font-normal">ยอดขายวันที่ขาด (ANALYTICA)</th><th className="text-right font-normal">สัดส่วน</th><th className="text-right font-normal">ประมาณของยอดตกหล่น</th></tr></thead>
                          <tbody>
                            {recon.categories.map((c) => (
                              <tr key={c.name} className="border-t border-amber-100">
                                <td className="py-0.5 text-slate-700">{c.name}</td>
                                <td className="py-0.5 text-right font-mono">฿{fmtMoney(c.sales)}</td>
                                <td className="py-0.5 text-right tabular-nums">{total > 0 ? ((c.sales / total) * 100).toFixed(1) : "0.0"}%</td>
                                <td className="py-0.5 text-right font-mono">฿{fmtMoney(total > 0 ? Math.max(missing, 0) * (c.sales / total) : 0)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                  </div>
                )}
                <p className="text-[10px] text-slate-500">วันและหมวดอ้างอิงจากข้อมูล ANALYTICA ของวันที่ไม่มียอดรายวัน (ยอด Nett) เป็นการประมาณสัดส่วน · ยอดตกสำรวจเดิมที่ไม่ระบุวันไม่ถูกนำมาหัก</p>
              </div>
            );
          })()}
          <div className="flex items-center justify-between">
            <div className="text-sm">{importKind === "catchup" && recon ? "ยอดตกหล่นที่จะบันทึก:" : "ยอดที่จะบันทึก:"} <b className="text-brand">฿{fmtMoney(importKind === "catchup" && recon ? Math.max(posTotal - recon.dailyTotal - recon.catchupTotal, 0) : posTotal)}</b> <span className="text-[11px] text-slate-400">({BASE_LABEL[base]})</span> <span className="text-[11px] text-slate-500">· จำนวนบิล <b>{posBills}</b></span></div>
            <button type="button" onClick={confirmImport} disabled={busy || posTotal <= 0 || (importKind === "catchup" && (!recon || posTotal - recon.dailyTotal - recon.catchupTotal < 0.01))} className="btn-primary text-sm disabled:opacity-50">{importKind === "catchup" ? "ยืนยันบันทึกเป็นยอดตกสำรวจ" : "ยืนยันบันทึกยอดวันนี้"}</button>
          </div>
        </div>
      )}

      {/* Daily entries grouped by week (weekly transfer subtotal) */}
      <div className="card space-y-2">
        <div className="text-sm font-bold text-slate-800">ยอดขายรายวัน + ยอดโอนรายสัปดาห์</div>
        {rounds.length === 0 && catchups.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มีข้อมูล — กดปุ่ม “นำเข้าไฟล์ยอดขายประจำวัน” ด้านบน</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">วันที่</th>
                <th className="text-right py-1.5 px-2">ยอดขาย</th>
                <th className="text-right py-1.5 px-2" title="ยอดขายร้านจ้อจี้ (รวมภาษี) ÷ ยอดขายทั้งร้านของวันนั้น">สัดส่วนต่อยอดร้าน</th>
                <th className="text-left py-1.5 px-2">ที่มา</th>
                <th></th>
              </tr></thead>
              <tbody>
                {weeks.map((w) => (
                  <Fragment key={w.wk}>
                    {w.rounds.map((r) => (
                      <tr key={r.id} className="border-b border-slate-50">
                        <td className="py-1 px-2 text-slate-600 whitespace-nowrap">
                          {roundLabel(r.period_start, r.period_start)}
                          {r.sent_at && <span className="ml-1.5 text-[10px] text-emerald-600" title="ส่งเข้ากลุ่มแล้ว — แก้ไข/ลบต้องยืนยัน PIN">✓</span>}
                        </td>
                        <td className="py-1 px-2 text-right">
                          {isLocked(r) && editingId !== r.id ? (
                            <span className="tabular-nums font-sans text-slate-700 inline-flex items-center gap-1 justify-end" title="ล็อกอยู่ — กด “แก้ไข” เพื่อปลด (ต้องใส่ PIN)">
                              <span className="text-[10px] text-slate-400"></span>฿{fmtMoney(r.sales_amount)}
                            </span>
                          ) : (
                            <SalesInput value={r.sales_amount} disabled={busy} autoFocus={editingId === r.id}
                              onSave={(v) => { saveSales(r, v); setEditingId(null); }} />
                          )}
                        </td>
                        <td className="py-1 px-2 text-right tabular-nums text-xs text-sky-700 whitespace-nowrap">
                          {shopShare.perDay[r.period_start] != null ? `${shopShare.perDay[r.period_start].toFixed(2)}%` : <span className="text-slate-300" title="ยังไม่มียอดขายร้านของวันนี้">—</span>}
                        </td>
                        <td className="py-1 px-2 text-[11px] text-slate-400">
                          {r.source === "pos_import" ? "นำเข้าไฟล์" : "กรอกเอง"}
                          {r.bill_count != null && <span className="text-slate-500"> · {r.bill_count} บิล</span>}
                        </td>
                        <td className="py-1 px-2 text-right whitespace-nowrap">
                          {isLocked(r) && editingId !== r.id && (
                            <button type="button" onClick={() => unlockEdit(r)} disabled={busy}
                              className="text-[11px] text-slate-500 hover:text-brand hover:underline mr-3" title="ปลดล็อกเพื่อแก้ยอด (ต้องใส่ PIN)">แก้ไข</button>
                          )}
                          {partner.line_group_id && (
                            <button type="button" onClick={() => setSendModal({
                              key: `d:${r.period_start}`, heading: "ส่งสรุปยอดขายประจำวัน",
                              preview: <DailyCardPreview shop={shop} sellerName={sellerName} dateLabel={roundLabel(r.period_start, r.period_start)} sales={r.sales_amount} vatRate={vatRate} salesIncludesVat={salesBaseIncludesVat(partner.sales_base)} billCount={r.bill_count} partnerId={partner.id} date={r.period_start} />,
                              body: { kind: "daily", date: r.period_start }
                            })} className="text-[11px] text-emerald-600 hover:underline mr-3">
                              {sentKey === `d:${r.period_start}` || r.sent_at ? "✓ ส่งแล้ว" : "ส่งยอดวันนี้"}
                            </button>
                          )}
                          <button type="button" onClick={() => del(r)} disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ</button>
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <td className="py-1 px-2 text-[11px] font-bold text-slate-600">
                        ยอดโอนสัปดาห์ {w.label}
                        {w.catchup > 0 && <div className="text-[10px] font-normal text-amber-700">รวมยอดตกสำรวจ ฿{fmtMoney(w.catchup)} (บรรทัดแยก)</div>}
                      </td>
                      <td className="py-1 px-2 text-right font-mono font-bold text-brand">฿{fmtMoney(w.total)}</td>
                      <td colSpan={3} className="py-1 px-2 text-[10px] text-slate-400">
                        โอนเต็มจำนวนให้คู่ค้า
                        {partner.line_group_id && (
                          <button type="button" onClick={() => setSendModal({
                            key: `w:${w.first}`, heading: "ส่งสรุปยอดขายประจำสัปดาห์",
                            preview: <WeeklyCardPreview shop={shop} sellerName={sellerName} weekLabel={w.label} transferAmount={w.total} catchupAmount={w.catchup} catchupCategories={w.catchupCats} dayCount={daySpan(w.first, w.last)} vatRate={vatRate} salesIncludesVat={salesBaseIncludesVat(partner.sales_base)} partnerId={partner.id} start={w.rounds[0].period_start} end={w.rounds[w.rounds.length - 1].period_start} />,
                            body: { kind: "weekly", week_start: w.first }
                          })} className="ml-2 text-[11px] font-bold text-emerald-600 hover:underline">
                            {sentKey === `w:${w.first}` ? "✓ ส่งแล้ว" : "ส่งสรุปสัปดาห์"}
                          </button>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-slate-300 font-bold">
                <td className="py-1.5 px-2 text-slate-700">รวมทั้งเดือน</td>
                <td className="py-1.5 px-2 text-right font-mono">฿{fmtMoney(totalSales + catchupTotal)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-xs text-sky-700 whitespace-nowrap">{shopShare.cumulative ? `${shopShare.cumulative.pct.toFixed(2)}%` : "—"}</td>
                <td colSpan={2} className="py-1.5 px-2 text-[11px] text-slate-400">ส่วนแบ่งคำนวณรายเดือนที่หน้าสรุปยอด</td>
              </tr></tfoot>
            </table>
          </div>
        )}
        {(rounds.length > 0 || catchups.length > 0) && (() => {
          // ยอดขายรายวันที่กรอก = ยอดก่อนภาษี (gross) — แยก VAT + ยอดรวมให้เห็น
          // (owner 2026-07-27). ทำตาม sales_base ของคู่ค้า (nett = ถอด VAT ออก).
          const v = salesVat(totalSales + catchupTotal, vatRate, salesBaseIncludesVat(partner.sales_base));
          return (
            <div className="mt-3 ml-auto max-w-xs rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
              {catchupTotal > 0 && <div className="flex justify-between text-[11px] text-amber-700"><span>รวมยอดตกสำรวจ</span><span className="font-mono">฿{fmtMoney(catchupTotal)}</span></div>}
              <div className="flex justify-between"><span className="text-slate-500">ยอดก่อนภาษี</span><span className="font-mono">฿{fmtMoney(v.base)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">ภาษีมูลค่าเพิ่ม {Math.round(vatRate * 100)}%</span><span className="font-mono">฿{fmtMoney(v.vat)}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 font-bold"><span>ยอดรวม</span><span className="font-mono text-brand">฿{fmtMoney(v.total)}</span></div>
            </div>
          );
        })()}
        {(shopShare.cumulative || shopShare.forecast) && (
          <section className="mt-4 rounded-xl border border-sky-200 bg-white p-4 space-y-3" aria-label="สัดส่วนยอดขายต่อยอดขายร้าน">
            <div>
              <h3 className="font-bold text-slate-800">สัดส่วนยอดขายของ {shop} ต่อยอดขายทั้งร้าน</h3>
              <p className="text-xs text-slate-500 mt-0.5">{sellerName} · {TH_MONTHS_FULL[month]} พ.ศ. {year + 543}</p>
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-center">
              {[
                shopShare.latest && { k: "d", label: `รายวัน (${roundLabel(shopShare.latest.date, shopShare.latest.date)})`, pct: shopShare.latest.pct, sub: `฿${fmtMoney(shopShare.latest.partner)} จากยอดร้าน ฿${fmtMoney(shopShare.latest.shop)}` },
                shopShare.cumulative && { k: "c", label: `สะสมทั้งเดือน (${shopShare.cumulative.days} วัน)`, pct: shopShare.cumulative.pct, sub: `฿${fmtMoney(shopShare.cumulative.partner)} จากยอดร้าน ฿${fmtMoney(shopShare.cumulative.shop)}` },
                shopShare.forecast && { k: "f", label: "คาดการณ์ทั้งเดือน (ประมาณการ)", pct: shopShare.forecast.pct, sub: `฿${fmtMoney(shopShare.forecast.partner)} จากยอดร้าน ฿${fmtMoney(shopShare.forecast.shop)}` }
              ].filter((x): x is { k: string; label: string; pct: number; sub: string } => !!x).map((x) => (
                <div key={x.k} className="rounded-lg bg-sky-50/60 border border-sky-100 px-2 py-2.5">
                  <dt className="text-[11px] text-slate-500">{x.label}</dt>
                  <dd className="text-xl font-bold text-sky-700 tabular-nums">{x.pct.toFixed(2)}%</dd>
                  <dd className="text-[10px] text-slate-400">{x.sub}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[11px] text-slate-500">
              คำนวณจากยอดขายที่รวมภาษีมูลค่าเพิ่มทั้งสองฝั่ง เทียบกับยอดขายรวม (Total Sales) ของร้านในแต่ละวัน นับเฉพาะวันที่มีข้อมูลทั้งสองฝั่ง ·
              ตัวเลขคาดการณ์เป็นประมาณการ ใช้ประกอบการพิจารณาภายในเท่านั้น ไม่นำไปคิดส่วนแบ่ง ใบวางบิล หรือส่งในรายงาน
            </p>
          </section>
        )}
        {monthForecast && monthForecast.remainingDays > 0 && (() => {
          // Display-only estimate (owner 2026-10-06): not part of the settlement,
          // the invoice, or any card/report sent to the partner.
          const f = monthForecast;
          const v = salesVat(f.total, vatRate, salesBaseIncludesVat(partner.sales_base));
          const actualPct = f.total > 0 ? Math.round((f.actual / f.total) * 100) : 0;
          const perDay = f.remainingDays > 0 ? f.remainingEstimate / f.remainingDays : 0;
          return (
            <section className="mt-4 rounded-xl border border-sky-200 bg-sky-50/50 p-4 space-y-3" aria-label="ประมาณการยอดขายรวมทั้งเดือน">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-slate-800">ประมาณการยอดขายรวมทั้งเดือน</h3>
                    <span className="rounded-full bg-sky-100 text-sky-700 text-[10px] font-semibold px-2 py-0.5">ประมาณการ</span>
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5">{TH_MONTHS_FULL[month]} พ.ศ. {year + 543}</p>
                </div>
                <div className="text-right">
                  <div className="font-mono text-2xl font-bold text-sky-700 leading-tight">฿{fmtMoney(v.base)}</div>
                  <div className="text-[11px] text-slate-500">ก่อนภาษีมูลค่าเพิ่ม</div>
                </div>
              </div>

              <div>
                <div className="h-2.5 w-full rounded-full bg-sky-100 overflow-hidden" role="img" aria-label={`ยอดขายที่นำเข้าแล้วร้อยละ ${actualPct} ของยอดประมาณการ`}>
                  <div className="h-full rounded-full bg-sky-600" style={{ width: `${Math.min(100, Math.max(0, actualPct))}%` }} />
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="flex items-center gap-1.5 text-slate-500"><span className="inline-block h-2 w-2 rounded-sm bg-sky-600" />ยอดขายที่นำเข้าแล้ว ({actualPct}%)</div>
                    <div className="font-mono text-sm font-semibold text-slate-800 mt-0.5">฿{fmtMoney(f.actual)}</div>
                  </div>
                  <div className="text-right">
                    <div className="flex items-center justify-end gap-1.5 text-slate-500"><span className="inline-block h-2 w-2 rounded-sm bg-sky-200" />ประมาณการส่วนที่เหลือ ({100 - actualPct}%)</div>
                    <div className="font-mono text-sm font-semibold text-slate-800 mt-0.5">฿{fmtMoney(f.remainingEstimate)}</div>
                  </div>
                </div>
              </div>

              <dl className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-white/70 border border-sky-100 px-2 py-2">
                  <dt className="text-[11px] text-slate-500">นำเข้าข้อมูลแล้ว</dt>
                  <dd className="text-sm font-semibold text-slate-800">{f.actualDays} วัน</dd>
                </div>
                <div className="rounded-lg bg-white/70 border border-sky-100 px-2 py-2">
                  <dt className="text-[11px] text-slate-500">วันทำการที่เหลือ</dt>
                  <dd className="text-sm font-semibold text-slate-800">{f.remainingDays} วัน</dd>
                </div>
                <div className="rounded-lg bg-white/70 border border-sky-100 px-2 py-2">
                  <dt className="text-[11px] text-slate-500">เฉลี่ยต่อวันทำการ (ประมาณการ)</dt>
                  <dd className="text-sm font-semibold text-slate-800 font-mono">฿{fmtMoney(perDay)}</dd>
                </div>
              </dl>

              {vatRate > 0 && (
                <div className="flex items-center justify-between text-sm border-t border-sky-200 pt-2">
                  <span className="text-slate-600">ยอดประมาณการรวมภาษีมูลค่าเพิ่ม {Math.round(vatRate * 100)}%</span>
                  <span className="font-mono font-semibold text-slate-800">฿{fmtMoney(v.total)}</span>
                </div>
              )}

              <details className="text-[11px] text-slate-500">
                <summary className="cursor-pointer select-none text-sky-700 hover:underline">วิธีคำนวณและข้อจำกัด</summary>
                <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                  <li>ประมาณการจากค่าเฉลี่ยยอดขายของแต่ละวันในสัปดาห์ จากข้อมูลที่นำเข้าย้อนหลังประมาณ 8 สัปดาห์ ({f.basisDays} วัน){f.method === "overall" ? " โดยวันใดของสัปดาห์ที่ยังไม่มีข้อมูล ใช้ค่าเฉลี่ยรวมทุกวันแทน" : ""}</li>
                  <li>ไม่นับวันที่ร้านปิดประจำสัปดาห์{f.lastDate ? ` และนับต่อจากวันที่ข้อมูลล่าสุด (${roundLabel(f.lastDate, f.lastDate)})` : ""}</li>
                  <li>ไม่ได้ปรับตามวันหยุดนักขัตฤกษ์ กิจกรรมพิเศษ หรือสภาพอากาศ</li>
                </ul>
              </details>
              <p className="text-[11px] text-slate-500">
                ข้อมูลส่วนนี้ใช้ประกอบการพิจารณาภายในเท่านั้น ไม่นำไปคำนวณส่วนแบ่ง ใบวางบิล และไม่ส่งในรายงานหรือกลุ่มของคู่ค้า
              </p>
            </section>
          );
        })()}
        <p className="text-[11px] text-slate-400">
          ยอดที่นำเข้า/ส่งแล้วล็อกไว้ กด “แก้ไข” + ใส่ PIN ก่อนแก้ · ยอดโอนรายสัปดาห์รวมจันทร์–อาทิตย์ให้อัตโนมัติ
          {partner.line_group_id
            ? " · กด “ส่งยอดวันนี้” แจ้งคู่ค้าตอนนำเข้า, “ส่งสรุปสัปดาห์” ตอนจะโอน"
            : " · ตั้ง LINE group ในหน้าตั้งค่าคู่ค้าเพื่อส่งแจ้งเตือนรายวัน/สัปดาห์ได้"}
        </p>
      </div>

      {/* ยอดตกสำรวจ — its own round (owner 2026-10-17): sales found after their day was imported/sent/settled.
          Never edits a past round; counts in the period it is recorded and shows as a separate transfer line. */}
      <div className="card space-y-3 border-amber-200">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <div className="text-sm font-bold text-slate-800">รอบยอดตกสำรวจ</div>
            <p className="text-[11px] text-slate-500 mt-0.5">ยอดขายที่ตกหล่น ไม่ได้นำเข้าตามวัน พบทีหลัง — บันทึกแยกจากยอดรายวัน <b>ไม่แก้รอบที่ผ่านมาแล้ว</b> นับรวมในช่วงที่บันทึก (ยอดโอนสัปดาห์นี้ และส่วนแบ่ง/ขั้นบันไดของเดือนนี้) และขึ้นเป็นบรรทัดแยกในการ์ดโอน</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <label className="btn-secondary text-sm cursor-pointer">
              นำเข้าไฟล์ยอดตกสำรวจ
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => onFile(e, "catchup")} disabled={busy} />
            </label>
            <button type="button" className="btn-secondary text-sm" onClick={() => setCuOpen((o) => !o)}>{cuOpen ? "ปิดแบบกรอก" : "กรอกยอดตกสำรวจเอง"}</button>
          </div>
        </div>
        {cuOpen && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/40 p-3 space-y-2">
            <div className="grid sm:grid-cols-2 gap-2.5">
              <label className="text-xs text-slate-600">ยอดตกสำรวจ (ฐานเดียวกับยอดรายวัน)
                <input inputMode="decimal" className="input mt-1" placeholder="เช่น 12,500.00" value={cuAmount} onChange={(e) => setCuAmount(e.target.value)} />
              </label>
              <label className="text-xs text-slate-600">หมายเหตุ <span className="text-slate-400">(ถ้ามี)</span>
                <input className="input mt-1" maxLength={300} placeholder="เช่น ยอดขายที่ไม่ได้ส่งออกจาก POS" value={cuNote} onChange={(e) => setCuNote(e.target.value)} />
              </label>
              <label className="text-xs text-slate-600">ยอดนี้เป็นของวันที่ — เริ่ม <span className="text-slate-400">(เว้นว่างถ้ายังไม่แน่ใจ)</span>
                <input type="date" className="input mt-1" value={cuFrom} max={cuTo || undefined} onChange={(e) => setCuFrom(e.target.value)} />
              </label>
              <label className="text-xs text-slate-600">ถึงวันที่
                <input type="date" className="input mt-1" value={cuTo} min={cuFrom || undefined} onChange={(e) => setCuTo(e.target.value)} />
              </label>
            </div>
            <div className="flex justify-end">
              <button type="button" className="btn-primary text-sm" disabled={busy || !cuAmount.trim()} onClick={addManualCatchup}>บันทึกยอดตกสำรวจ (PIN)</button>
            </div>
          </div>
        )}
        {catchups.length === 0 ? (
          <p className="text-xs text-slate-400">ยังไม่มียอดตกสำรวจในเดือนนี้</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-slate-400 border-b border-slate-200">
                <th className="text-left py-1.5 px-2">บันทึกเมื่อ</th>
                <th className="text-left py-1.5 px-2">เป็นยอดของวันที่</th>
                <th className="text-right py-1.5 px-2">ยอด</th>
                <th className="text-left py-1.5 px-2">ที่มา / หมายเหตุ</th>
                <th className="text-left py-1.5 px-2">สถานะ</th>
                <th></th>
              </tr></thead>
              <tbody>
                {catchups.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50">
                    <td className="py-1 px-2 text-slate-600 whitespace-nowrap">{roundLabel(c.counted_date, c.counted_date)}</td>
                    <td className="py-1 px-2 text-slate-600 whitespace-nowrap">{c.sales_from ? roundLabel(c.sales_from, c.sales_to ?? c.sales_from) : <span className="text-slate-400">ไม่ระบุ</span>}</td>
                    <td className="py-1 px-2 text-right font-mono">฿{fmtMoney(c.sales_amount)}</td>
                    <td className="py-1 px-2 text-[11px] text-slate-500">
                      {c.source === "pos_import" ? "นำเข้าไฟล์" : "กรอกเอง"}{c.bill_count != null && ` · ${c.bill_count} บิล`}{c.note && ` · ${c.note}`}
                      {c.breakdown?.exact && c.breakdown.exact.length > 0 && (
                        <div className="mt-0.5 font-bold text-amber-900">ตกสำรวจจากหมวด: {c.breakdown.exact.map((e) => e.name).join(", ")} (ตรงกับยอดของหมวดในไฟล์)</div>
                      )}
                      {c.breakdown && !c.breakdown.exact && !c.breakdown.analyticaMissing && c.breakdown.categories.length > 0 && (
                        <div className="mt-0.5 text-amber-800">หมวด: {c.breakdown.categories.map((b) => `${b.name} ฿${fmtMoney(b.allocated)} (${(b.share * 100).toFixed(0)}%)`).join(" · ")}</div>
                      )}
                      {c.breakdown && c.breakdown.dates.length > 0 && c.breakdown.dates.length <= 10 && (
                        <div className="text-slate-400">วันที่ไม่มียอดรายวัน: {c.breakdown.dates.map((d) => roundLabel(d, d)).join(", ")}</div>
                      )}
                    </td>
                    <td className="py-1 px-2 text-[11px]">{c.sent_at ? <span className="text-emerald-600">✓ รวมในรอบโอนแล้ว</span> : <span className="text-amber-700">รอรอบโอน</span>}</td>
                    <td className="py-1 px-2 text-right">{!c.sent_at && <button type="button" onClick={() => delCatchup(c)} disabled={busy} className="text-[11px] text-rose-500 hover:underline">ลบ</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t border-slate-200 font-bold">
                <td className="py-1.5 px-2 text-slate-700" colSpan={2}>รวมยอดตกสำรวจเดือนนี้</td>
                <td className="py-1.5 px-2 text-right font-mono text-amber-700">฿{fmtMoney(catchupTotal)}</td>
                <td colSpan={3}></td>
              </tr></tfoot>
            </table>
          </div>
        )}
      </div>

      {drinkWelfare && drinkWelfare.month.count > 0 && (
        <div className="card space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-bold text-slate-800">สวัสดิการเครื่องดื่มพนักงาน (จ้อจี้)</div>
            <span className="text-xs text-slate-400">อ่านจากการเบิกสิทธิ์ · ไม่คิด GP · ส่งแยกจากยอดขาย</span>
          </div>
          {drinkWelfare.weeks.map((w) => (
            <div key={w.weekStart} className="flex items-center justify-between gap-2 text-sm border-b border-slate-100 pb-2">
              <div>
                <div className="font-medium text-slate-700">{roundLabel(w.start, w.end)}</div>
                <div className="text-xs text-slate-400">{w.summary.count} แก้ว · ฿{fmtMoney(w.summary.total)}</div>
              </div>
              <button type="button" onClick={() => setSendModal({
                key: `dw-${w.weekStart}`, heading: "ส่งสรุปสวัสดิการเครื่องดื่ม (สัปดาห์)",
                preview: <DrinkWelfareCardPreview shop={shop} sellerName={sellerName} periodLabel={roundLabel(w.start, w.end)} count={w.summary.count} total={w.summary.total} vatRate={vatRate} byTier={w.summary.byTier} cashCount={w.summary.cashCount} cashTotal={w.summary.cashTotal} />,
                body: { kind: "drink_welfare", week_start: w.weekStart }
              })} className="btn-secondary !py-1 !px-2.5 !text-xs shrink-0">ส่งรายงานสัปดาห์นี้</button>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2 text-sm pt-1">
            <div>
              <div className="font-bold text-slate-800">รวมทั้งเดือน ({TH_MONTHS_FULL[month]} พ.ศ. {year + 543})</div>
              <div className="text-xs text-slate-400">{drinkWelfare.month.count} แก้ว · ฿{fmtMoney(drinkWelfare.month.total)}</div>
            </div>
            <button type="button" onClick={() => setSendModal({
              key: "dw-month", heading: "ส่งสรุปสวัสดิการเครื่องดื่ม (สิ้นเดือน)",
              preview: <DrinkWelfareCardPreview shop={shop} sellerName={sellerName} periodLabel={`${TH_MONTHS_FULL[month]} พ.ศ. ${year + 543}`} count={drinkWelfare.month.count} total={drinkWelfare.month.total} vatRate={vatRate} byTier={drinkWelfare.month.byTier} cashCount={drinkWelfare.month.cashCount} cashTotal={drinkWelfare.month.cashTotal} />,
              body: { kind: "drink_welfare" }
            })} className="btn-primary !py-1 !px-2.5 !text-xs shrink-0">ส่งรายงานสิ้นเดือน</button>
          </div>
        </div>
      )}

      {pinRun && (
        <PinPromptModal
          title="ยืนยันตัวตนด้วย PIN"
          description={<>กรอก PIN 4 หลักของคุณเพื่อยืนยันผู้ทำรายการ (นำเข้า/แก้ไข/ลบยอดขาย หรือส่งแจ้งเตือนเข้ากลุ่มคู่ค้า)</>}
          submitLabel="ยืนยัน"
          onSubmit={onPinSubmit}
          onClose={() => setPinRun(null)}
        />
      )}

      {sendModal && (
        <SendPreviewModal
          heading={sendModal.heading}
          preview={sendModal.preview}
          busy={busy}
          onConfirm={confirmSend}
          onClose={() => setSendModal(null)}
        />
      )}

      {/* Flexible transfer round — pick a custom span, review the total, confirm. */}
      {xferOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setXferOpen(false); }}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-semibold text-slate-800">สร้างรอบโอนเอง</h3>
                <p className="text-xs text-slate-500">{shop} — เลือกช่วงวันที่จะโอน (รวบหลายสัปดาห์/ข้ามเดือนได้)</p>
              </div>
              <button type="button" onClick={() => setXferOpen(false)} className="text-slate-400 hover:text-slate-700 text-sm">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-slate-600">วันเริ่ม
                <input type="date" className="input mt-1" value={xferStart}
                  max={xferEnd || undefined}
                  onChange={(e) => setXferStart(e.target.value)} />
              </label>
              <label className="text-xs text-slate-600">วันจบ
                <input type="date" className="input mt-1" value={xferEnd}
                  min={xferStart || undefined}
                  onChange={(e) => setXferEnd(e.target.value)} />
              </label>
            </div>
            <button type="button" onClick={() => loadXfer(xferStart, xferEnd)} disabled={xferLoading || !xferStart || !xferEnd}
              className="btn-secondary text-xs disabled:opacity-50">↻ ดูสรุปช่วงนี้</button>

            {xferMsg && <p className="text-xs text-rose-600">{xferMsg}</p>}
            {xferLoading && <p className="text-xs text-slate-400">กำลังโหลด…</p>}

            {xferPreview && !xferLoading && (
              <div className="rounded-lg border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                  รอบโอน {xferPreview.label} · {xferPreview.rows.length} วัน{xferPreview.catchups.length > 0 ? ` + ยอดตกสำรวจ ${xferPreview.catchups.length} รายการ` : ""}
                  {xferPreview.alreadySentCount > 0 &&
                    <span className="ml-1 font-normal text-amber-600">({xferPreview.alreadySentCount} วันเคยโอนแล้ว จะไม่โอนซ้ำ)</span>}
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {xferPreview.rows.map((r) => (
                      <tr key={r.date} className="border-t border-slate-100">
                        <td className="px-3 py-1 text-slate-600">{r.date}{r.sent && <span className="ml-1 text-[10px] text-amber-500">โอนแล้ว</span>}</td>
                        <td className="px-3 py-1 text-right tabular-nums">฿{fmtMoney(r.sales)}</td>
                      </tr>
                    ))}
                    {xferPreview.rows.length === 0 && xferPreview.catchups.length === 0 && (
                      <tr><td className="px-3 py-2 text-slate-400" colSpan={2}>ช่วงนี้ไม่มียอดขาย</td></tr>
                    )}
                    {xferPreview.catchups.map((c) => (
                      <tr key={`cu${c.id}`} className="border-t border-slate-100 bg-amber-50/60">
                        <td className="px-3 py-1 text-amber-800">ยอดตกสำรวจ{c.salesFrom ? ` (ของวันที่ ${roundLabel(c.salesFrom, c.salesTo ?? c.salesFrom)})` : ""}{c.sent && <span className="ml-1 text-[10px] text-amber-500">โอนแล้ว</span>}</td>
                        <td className="px-3 py-1 text-right tabular-nums">฿{fmtMoney(c.sales)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="border-t border-slate-200 px-3 py-2 space-y-0.5 text-xs">
                  <div className="flex justify-between"><span className="text-slate-500">ยอดก่อนภาษี</span><span className="tabular-nums">฿{fmtMoney(xferPreview.vat.base)}</span></div>
                  {xferPreview.vatEnabled && (
                    <div className="flex justify-between"><span className="text-slate-500">ภาษีมูลค่าเพิ่ม 7%</span><span className="tabular-nums">฿{fmtMoney(xferPreview.vat.vat)}</span></div>
                  )}
                  <div className="flex justify-between font-bold text-slate-800"><span>ยอดโอนรวม</span><span className="tabular-nums">฿{fmtMoney(xferPreview.vat.total)}</span></div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setXferOpen(false)} className="btn-secondary text-sm">ปิด</button>
              <button type="button" disabled={!xferPreview || (xferPreview.rows.length === 0 && xferPreview.catchups.length === 0) || xferLoading}
                onClick={() => setXferPinOpen(true)}
                className="rounded-full bg-brand text-white px-4 py-2 text-sm font-bold hover:opacity-90 disabled:opacity-50">
                ยืนยันโอน + ส่งรายงาน (PIN)
              </button>
            </div>
          </div>
        </div>
      )}

      {xferPinOpen && (
        <PinPromptModal
          title="ยืนยันรอบโอน"
          description={<div className="space-y-2">
            {partner.line_group_id && xferPreview && (
              <div className="rounded-xl bg-slate-100 p-2">
                <WeeklyCardPreview shop={shop} sellerName={sellerName} weekLabel={xferPreview.label}
                  transferAmount={xferPreview.totalSales} catchupAmount={xferPreview.catchupTotal} catchupCategories={xferPreview.catchupCategories} dayCount={xferPreview.dayCount} vatRate={vatRate}
                  salesIncludesVat={salesBaseIncludesVat(partner.sales_base)} partnerId={partner.id}
                  start={xferPreview.start} end={xferPreview.end} showCategories={false} />
              </div>
            )}
            <p className="text-xs text-slate-600">
              โอนยอดช่วง <b>{xferPreview?.label}</b> รวม <b>฿{fmtMoney(xferPreview?.vat.total ?? 0)}</b> — ใส่ PIN เพื่อยืนยัน
              {partner.line_group_id ? " และส่งรายงานเข้ากลุ่ม LINE คู่ค้า" : ""}
            </p>
          </div>}
          submitLabel="ยืนยันโอน"
          onSubmit={confirmXfer}
          onClose={() => setXferPinOpen(false)}
        />
      )}
    </div>
  );
}

// Editable daily-sales input: shows the value grouped with thousand separators
// at rest (and in the app font, not the browser's number-input font), drops the
// commas for clean editing on focus, re-formats + saves on blur.
function SalesInput({ value, onSave, disabled, autoFocus }: { value: number; onSave: (v: string) => void; disabled?: boolean; autoFocus?: boolean }) {
  const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [text, setText] = useState(fmt(value));
  return (
    <input
      type="text" inputMode="decimal" disabled={disabled} autoFocus={autoFocus}
      className="input w-32 text-right text-sm py-1 font-sans"
      value={text}
      onFocus={() => setText(value ? String(value) : "")}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        const n = Number(e.target.value.replace(/,/g, ""));
        if (Number.isFinite(n)) { setText(fmt(n)); onSave(String(n)); }
        else setText(fmt(value));
      }}
    />
  );
}
