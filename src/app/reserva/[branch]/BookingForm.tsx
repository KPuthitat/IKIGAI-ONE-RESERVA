"use client";

import { useState, useMemo, useEffect } from "react";
import Script from "next/script";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// LIFF SDK — types only. The SDK itself is loaded as an external <Script>
// tag below, then attaches to window.liff at runtime.
type LiffProfile = { userId: string; displayName: string; pictureUrl?: string };
type LiffSDK = {
  init: (cfg: { liffId: string }) => Promise<void>;
  ready: Promise<void>;
  isInClient: () => boolean;
  isLoggedIn: () => boolean;
  login: (cfg?: { redirectUri?: string }) => void;
  getProfile: () => Promise<LiffProfile>;
};
declare global {
  interface Window { liff?: LiffSDK }
}

type TableOption = {
  id: number;
  label: string;
  capacity: number;
  shape: string;
  fitScore: number;
};

// Source values (เก็บใน DB ใช้ key คงที่) + i18n key สำหรับ display
const SOURCE_DEFS: Array<{ value: string; key: string }> = [
  { value: "Instagram", key: "booking.source.Instagram" },
  { value: "Facebook", key: "booking.source.Facebook" },
  { value: "TikTok", key: "booking.source.TikTok" },
  { value: "Google Maps", key: "booking.source.GoogleMaps" },
  { value: "เพื่อนแนะนำ", key: "booking.source.friend" },
  { value: "ผ่านมาเห็น", key: "booking.source.passing" },
  { value: "อื่นๆ", key: "booking.source.other" }
];

const ORIGIN_DEFS: Array<{ value: string; key: string }> = [
  { value: "sriracha", key: "booking.origin.sriracha" },
  { value: "chonburi", key: "booking.origin.chonburi" },
  { value: "other_province", key: "booking.origin.other_province" }
];

export type BookingFormMode = "customer" | "walkin" | "phone";

export default function BookingForm({
  branch, liffId, mode = "customer", onSuccess,
  initialTableId, initialBookingTime, initialBookingDate
}: {
  branch: Branch;
  liffId: string | null;
  mode?: BookingFormMode;
  /** Admin modes call this after a successful save instead of showing
   *  the customer "done" screen. The admin caller then closes the modal
   *  and refreshes the bookings list. */
  onSuccess?: (bookingId: number) => void;
  /** Pre-fill table when staff click an empty cell in the timetable grid */
  initialTableId?: number | null;
  /** Pre-fill HH:MM when opening from a specific time slot */
  initialBookingTime?: string;
  /** Pre-fill YYYY-MM-DD when not today (e.g., timetable showing future date) */
  initialBookingDate?: string;
}) {
  const router = useRouter();
  const { t, formatDate, lang } = useLang();

  // LIFF only applies to the customer-facing flow. Admin walk-in / phone
  // bookings are entered by staff who don't need a LINE userId.
  const liffActive = mode === "customer" && !!liffId;

  // Track LIFF connection status — drives the badge shown above the form
  const [liffStatus, setLiffStatus] = useState<"idle" | "init" | "ready" | "guest" | "error">(
    liffActive ? "init" : "idle"
  );
  const [liffSdkReady, setLiffSdkReady] = useState(false);

  const SOURCES = SOURCE_DEFS.map((s) => ({ value: s.value, label: t(s.key) }));
  const ORIGINS = ORIGIN_DEFS.map((o) => ({ value: o.value, label: t(o.key) }));

  const today = useMemo(() => {
    const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }, []);

  // Default starting values vary by mode:
  //   walk-in : customer is here right now → time = now (rounded to 5 min),
  //             status will become 'seated' on save, name pre-filled with
  //             the placeholder so staff can submit in seconds.
  //   phone   : customer is calling about a future slot → time = branch open,
  //             name pre-filled with "ลูกค้าจองทางโทรศัพท์".
  //   customer: classic public booking flow.
  const initialName = useMemo(() => {
    if (mode === "walkin") return t("admin.bookings.walkinDefaultName");
    if (mode === "phone") return t("admin.bookings.phoneDefaultName");
    return "";
  }, [mode, t]);
  const initialTime = useMemo(() => {
    if (mode === "walkin") {
      const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const totalMin = bkk.getUTCHours() * 60 + bkk.getUTCMinutes();
      const snapped = Math.round(totalMin / 5) * 5;
      const h = Math.floor(snapped / 60), m = snapped % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    return branch.open_time && /^\d{2}:\d{2}$/.test(branch.open_time)
      ? branch.open_time
      : "18:00";
  }, [mode, branch.open_time]);

  const [form, setForm] = useState({
    customer_name: initialName,
    customer_phone: "",
    party_size: 2,
    // Caller-provided overrides win — admin clicking on a future-day
    // timetable cell wants that exact date/time, not today/now defaults
    booking_date: initialBookingDate && /^\d{4}-\d{2}-\d{2}$/.test(initialBookingDate)
      ? initialBookingDate
      : today,
    booking_time: initialBookingTime && /^\d{2}:\d{2}$/.test(initialBookingTime)
      ? initialBookingTime
      : initialTime,
    sources: [] as string[],
    customer_origin: "",
    is_member: null as 0 | 1 | null,
    notes: "",
    line_user_id: ""
  });
  const [step, setStep] = useState<"form" | "choose" | "done">("form");
  const [suggestions, setSuggestions] = useState<TableOption[]>([]);
  // Pre-select the table when caller passed an initial id — saves the
  // staff a click since they already chose the cell in the timetable.
  const [chosenTable, setChosenTable] = useState<number | "auto" | null>(
    initialTableId ?? null
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultId, setResultId] = useState<number | null>(null);

  // ── LIFF init — captures the customer's LINE userId + display name when
  //    the booking page is opened via the OA's Rich Menu (LIFF link). With
  //    Bot link feature 'Aggressive', the userId returned is valid in the
  //    Messaging API channel's namespace, so we can push notifications back.
  //    No-op if liffId is not configured (admin hasn't set it yet) or the
  //    SDK is unavailable (page opened in regular browser, network issue).
  useEffect(() => {
    if (!liffActive || !liffSdkReady) return;
    const liff = typeof window !== "undefined" ? window.liff : undefined;
    if (!liff) { setLiffStatus("error"); return; }

    let cancelled = false;
    (async () => {
      try {
        await liff.init({ liffId });
        if (cancelled) return;
        if (!liff.isLoggedIn()) {
          // In LINE app: login is silent. In external browser: redirects to
          // LINE login page then back. With 'Aggressive' bot link, the user
          // is also asked to add the OA as a friend.
          liff.login();
          return;
        }
        const profile = await liff.getProfile();
        if (cancelled) return;
        setForm((f) => ({
          ...f,
          line_user_id: profile.userId,
          // Pre-fill name only if the field is still empty so we don't
          // overwrite a manual edit
          customer_name: f.customer_name || profile.displayName
        }));
        setLiffStatus("ready");
      } catch {
        if (!cancelled) setLiffStatus("error");
      }
    })();
    return () => { cancelled = true; };
  }, [liffActive, liffId, liffSdkReady]);

  // ครัวปิด 30 นาทีก่อนร้านปิด — เวลาจองสุดท้าย
  const KITCHEN_CLOSE_OFFSET = 30;
  const NEAR_CLOSE_THRESHOLD = 30;
  const TODAY_BOOKING_BUFFER = 30;

  function hhmmToMin(s: string | null | undefined): number | null {
    if (!s || !/^\d{2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  }
  function minToHHMM(m: number): string {
    const c = Math.max(0, Math.min(23 * 60 + 59, m));
    return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
  }
  function ceilToFive(m: number): number { return Math.ceil(m / 5) * 5; }
  function parseJsonArr<T>(s: string | null): T[] {
    if (!s) return [];
    try { const a = JSON.parse(s); return Array.isArray(a) ? a as T[] : []; } catch { return []; }
  }

  const timeBounds = useMemo(() => {
    const openMin = hhmmToMin(branch.open_time) ?? 11 * 60;
    const closeMin = hhmmToMin(branch.close_time) ?? 22 * 60;
    const kitchenCloseMin = closeMin - KITCHEN_CLOSE_OFFSET;
    const bkkNow = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const nowMin = bkkNow.getUTCHours() * 60 + bkkNow.getUTCMinutes();
    const todayBkk = bkkNow.toISOString().slice(0, 10);
    return { openMin, closeMin, kitchenCloseMin, nowMin, todayBkk };
  }, [branch.open_time, branch.close_time]);

  // Lunch break ของวันที่เลือก (อาจไม่มี ถ้าเสาร์อาทิตย์ หรือวันพิเศษ)
  const lunchBreak = useMemo(() => {
    const lbStart = hhmmToMin(branch.lunch_break_start);
    const lbEnd = hhmmToMin(branch.lunch_break_end);
    if (lbStart == null || lbEnd == null || lbEnd <= lbStart) return null;
    const applyOnWeekdays = parseJsonArr<number>(branch.lunch_break_weekdays);
    if (applyOnWeekdays.length === 0) return null;
    const noLunchDates = new Set(parseJsonArr<string>(branch.no_lunch_break_dates));
    if (noLunchDates.has(form.booking_date)) return null;  // วันพิเศษ = ไม่พักกลางวัน
    // วัน-of-week ของ booking_date
    const d = new Date(`${form.booking_date}T00:00:00Z`);
    const dow = d.getUTCDay();
    if (!applyOnWeekdays.includes(dow)) return null;
    return { start: lbStart, end: lbEnd };
  }, [branch.lunch_break_start, branch.lunch_break_end, branch.lunch_break_weekdays,
      branch.no_lunch_break_dates, form.booking_date]);

  const { minTimeStr, maxTimeStr } = useMemo(() => {
    let minM = timeBounds.openMin;
    if (form.booking_date === timeBounds.todayBkk) {
      minM = Math.max(minM, ceilToFive(timeBounds.nowMin + TODAY_BOOKING_BUFFER));
    }
    minM = Math.min(minM, timeBounds.kitchenCloseMin);
    return {
      minTimeStr: minToHHMM(minM),
      maxTimeStr: minToHHMM(timeBounds.kitchenCloseMin)
    };
  }, [form.booking_date, timeBounds]);

  // snap เวลาให้อยู่ในช่วงที่ valid (ปัด 5 นาที, ไม่ก่อน min, ไม่หลัง max, ข้าม lunch break)
  function snapTime(raw: string): string {
    const m = hhmmToMin(raw);
    if (m == null) return minTimeStr;
    let total = Math.round(m / 5) * 5;
    const minM = hhmmToMin(minTimeStr) ?? timeBounds.openMin;
    const maxM = hhmmToMin(maxTimeStr) ?? timeBounds.kitchenCloseMin;
    if (total < minM) total = minM;
    if (total > maxM) total = maxM;
    if (lunchBreak && total >= lunchBreak.start && total < lunchBreak.end) {
      // ถ้าตกในช่วงพักกลางวัน → ดันไปที่จุดสิ้นสุด lunch break
      total = lunchBreak.end;
      if (total > maxM) total = maxM;
    }
    return minToHHMM(total);
  }

  // เปลี่ยนวันที่/branch → snap เวลาที่เคยเลือกให้ valid อีกครั้ง
  useEffect(() => {
    if (!form.booking_time) return;
    const snapped = snapTime(form.booking_time);
    if (snapped !== form.booking_time) {
      setForm((f) => ({ ...f, booking_time: snapped }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minTimeStr, maxTimeStr, lunchBreak]);

  const isNearKitchenClose = useMemo(() => {
    if (!form.booking_time) return false;
    const sel = hhmmToMin(form.booking_time);
    return sel != null && sel >= timeBounds.kitchenCloseMin - NEAR_CLOSE_THRESHOLD;
  }, [form.booking_time, timeBounds.kitchenCloseMin]);

  const lunchBreakLabel = useMemo(() => {
    if (!lunchBreak) return null;
    return { start: minToHHMM(lunchBreak.start), end: minToHHMM(lunchBreak.end) };
  }, [lunchBreak]);

  // วันที่เลือกเป็น "วันพิเศษ" (อยู่ใน no_lunch_break_dates) AND วันธรรมดามักมีพัก
  const isSpecialOpenDay = useMemo(() => {
    const noLunchDates = parseJsonArr<string>(branch.no_lunch_break_dates);
    if (!noLunchDates.includes(form.booking_date)) return false;
    // เป็นวันพิเศษเฉพาะถ้าวันนั้นโดยทั่วไปมีพัก (วัน-of-week อยู่ใน lunch_break_weekdays)
    const applyOnWeekdays = parseJsonArr<number>(branch.lunch_break_weekdays);
    if (applyOnWeekdays.length === 0) return false;
    const dow = new Date(`${form.booking_date}T00:00:00Z`).getUTCDay();
    return applyOnWeekdays.includes(dow);
  }, [branch.no_lunch_break_dates, branch.lunch_break_weekdays, form.booking_date]);

  // เวลาที่เลือกผ่านมาแล้วหรือไม่ (สำหรับวันนี้)
  const isPastTime = useMemo(() => {
    if (form.booking_date !== timeBounds.todayBkk) return false;
    const sel = hhmmToMin(form.booking_time);
    if (sel == null) return false;
    return sel <= timeBounds.nowMin;
  }, [form.booking_date, form.booking_time, timeBounds]);


  async function findTables(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.customer_name.trim() || !form.customer_phone.trim()) {
      setError(t("booking.error.missingNamePhone"));
      return;
    }
    if (isPastTime) {
      setError(t("booking.error.pastTime"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl("/api/bookings/suggest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch_slug: branch.slug,
          party_size: form.party_size,
          booking_date: form.booking_date,
          booking_time: form.booking_time
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t("common.error"));
      if (data.suggestions.length === 0) {
        setError(t("booking.error.noTable", { n: form.party_size }));
        return;
      }
      setSuggestions(data.suggestions);
      setChosenTable("auto");
      setStep("choose");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmBooking() {
    setSubmitting(true);
    setError(null);
    try {
      const tableId = chosenTable === "auto" ? suggestions[0].id : chosenTable;
      // Admin modes hit a different endpoint that accepts booking_channel
      // and lets staff skip the past-time guard for walk-ins.
      const isAdmin = mode === "walkin" || mode === "phone";
      const url = isAdmin ? "/api/admin/reserva/bookings" : "/api/bookings";
      const body: Record<string, unknown> = isAdmin
        ? {
            customer_name: form.customer_name.trim() || (
              mode === "walkin"
                ? t("admin.bookings.walkinDefaultName")
                : t("admin.bookings.phoneDefaultName")
            ),
            customer_phone: form.customer_phone.trim(),
            party_size: form.party_size,
            booking_date: form.booking_date,
            booking_time: form.booking_time,
            source: form.sources.length > 0 ? JSON.stringify(form.sources) : "",
            customer_origin: form.customer_origin || "",
            is_member: form.is_member,
            notes: form.notes,
            table_id: tableId,
            booking_channel: mode
          }
        : {
            branch_slug: branch.slug,
            ...form,
            source: form.sources.length > 0 ? JSON.stringify(form.sources) : "",
            table_id: tableId,
            lang   // customer flow: tag booking with current UI lang so the
                   // LINE Flex card renders in the same language
          };
      const res = await fetch(apiUrl(url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) {
        // Admin endpoint returns short error codes; translate them to plain
        // Thai/EN sentences. Customer endpoint already returns localized
        // messages, so passing data.error through is fine for that path.
        const codeMap: Record<string, string> = {
          table_unavailable: t("admin.bookings.err.tableUnavailable"),
          no_past_booking: t("admin.bookings.err.noPast"),
          no_active_branch: t("admin.notAssignedBranch"),
          branch_not_found: t("common.error")
        };
        throw new Error(codeMap[data.error] || data.error || t("common.error"));
      }
      // Admin caller (modal) handles its own follow-up — close + refresh.
      // Customer flow shows the success card.
      if (isAdmin && onSuccess) {
        onSuccess(data.id);
        return;
      }
      setResultId(data.id);
      setStep("done");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("common.error"));
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "done" && resultId) {
    return (
      <div className="card text-center">
        <div className="text-5xl mb-3">✅</div>
        <h2 className="text-xl font-bold mb-2 text-slate-800">{t("booking.success.title")}</h2>
        <p className="text-slate-600 mb-1">
          <span dangerouslySetInnerHTML={{
            __html: t("booking.success.bookingId", { id: `<span class="font-bold">${resultId}</span>` })
          }} />
        </p>
        <p className="text-slate-600 mb-6">
          {t("booking.success.summary", { name: form.customer_name, n: form.party_size })}<br />
          {t("booking.success.dateTime", { date: formatDate(form.booking_date), time: form.booking_time })}
        </p>
        <p className="text-sm text-slate-500 mb-4">
          {t("booking.success.lineNotice")}
        </p>

        {form.is_member === 0 && (
          <div className="bg-brand/5 border border-brand/30 rounded-xl p-4 mb-4 text-left">
            <div className="font-bold text-brand mb-1">{t("booking.success.memberCta.title")}</div>
            <div className="text-sm text-slate-600">{t("booking.success.memberCta.body")}</div>
          </div>
        )}

        <button onClick={() => router.push("/reserva")} className="btn-secondary w-full">
          {t("booking.success.backToBranch")}
        </button>
      </div>
    );
  }

  if (step === "choose") {
    return (
      <div className="card">
        <h2 className="text-lg font-bold mb-3 text-slate-800">{t("booking.choose.title")}</h2>
        <p className="text-sm text-slate-500 mb-4">{t("booking.choose.subtitle")}</p>

        <label className="border-[1.5px] border-brand bg-brand/5 rounded-xl p-3.5 mb-2 flex items-center cursor-pointer">
          <input
            type="radio" name="table" className="mr-3 w-5 h-5"
            checked={chosenTable === "auto"}
            onChange={() => setChosenTable("auto")}
          />
          <div>
            <div className="font-bold">{t("booking.choose.auto")}</div>
            <div className="text-sm text-slate-500">
              {t("booking.choose.tableX", { label: suggestions[0].label })} · {t("booking.choose.seats", { n: suggestions[0].capacity })}
            </div>
          </div>
        </label>

        {suggestions.map((s) => (
          <label key={s.id} className="border-[1.5px] border-slate-200 rounded-xl p-3.5 mb-2 flex items-center cursor-pointer hover:border-brand">
            <input
              type="radio" name="table" className="mr-3 w-5 h-5"
              checked={chosenTable === s.id}
              onChange={() => setChosenTable(s.id)}
            />
            <div>
              <div className="font-bold">{t("booking.choose.tableX", { label: s.label })}</div>
              <div className="text-sm text-slate-500">
                {t("booking.choose.seats", { n: s.capacity })} {s.shape === "round" ? t("booking.choose.round") : ""}
              </div>
            </div>
          </label>
        ))}

        {error && <div className="text-red-600 text-sm mt-2">{error}</div>}

        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={() => setStep("form")} className="btn-secondary">{t("common.back")}</button>
          <button
            onClick={confirmBooking}
            disabled={submitting || chosenTable === null}
            className="btn-primary"
          >
            {submitting ? t("booking.cta.confirming") : t("booking.cta.confirm")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={findTables} className="space-y-4">
      {/* Load LIFF SDK only on the customer-facing flow when a liffId is
          configured. Admin walk-in / phone bookings skip this entirely. */}
      {liffActive && (
        <Script
          src="https://static.line-scdn.net/liff/edge/2/sdk.js"
          strategy="afterInteractive"
          onLoad={() => setLiffSdkReady(true)}
        />
      )}

      {/* LIFF status badge — only shown when LIFF is active */}
      {liffActive && (
        <div className="text-xs">
          {liffStatus === "init" && (
            <span className="inline-flex items-center gap-1.5 text-slate-500">
              <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse"></span>
              {t("booking.liff.connecting")}
            </span>
          )}
          {liffStatus === "ready" && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              {t("booking.liff.connected")}
            </span>
          )}
          {(liffStatus === "guest" || liffStatus === "error") && (
            <span className="inline-flex items-center gap-1.5 text-amber-700">
              <span className="w-2 h-2 rounded-full bg-amber-400"></span>
              {t("booking.liff.guest")}
            </span>
          )}
        </div>
      )}

      <div className="card space-y-4">
        <div>
          <label className="label">
            {t("booking.field.name")}
            {mode !== "walkin" && " *"}
          </label>
          <input
            className="input"
            required={mode !== "walkin"}
            autoComplete="name"
            value={form.customer_name}
            onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
            placeholder={mode === "walkin" ? t("admin.bookings.walkinDefaultName") : ""}
          />
          {mode === "walkin" && (
            <p className="text-[11px] text-slate-400 mt-1">
              {t("admin.bookings.walkinNameHint")}
            </p>
          )}
        </div>

        <div>
          <label className="label">
            {t("booking.field.phone")}
            {mode !== "walkin" && " *"}
          </label>
          <input
            className="input"
            required={mode !== "walkin"}
            type="tel"
            inputMode="tel" autoComplete="tel"
            placeholder={t("booking.field.phonePlaceholder")}
            value={form.customer_phone}
            onChange={(e) => setForm({ ...form, customer_phone: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">{t("booking.field.date")} *</label>
            <input
              type="date" className="input" required min={today}
              value={form.booking_date}
              onChange={(e) => setForm({ ...form, booking_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t("booking.field.time")} *</label>
            <input
              type="time" step={300}
              className="input"
              required
              value={form.booking_time}
              min={minTimeStr}
              max={maxTimeStr}
              onChange={(e) => setForm({ ...form, booking_time: snapTime(e.target.value) })}
              onBlur={(e) => setForm({ ...form, booking_time: snapTime(e.target.value) })}
            />
            <p className="text-[11px] text-slate-400 mt-1">
              {t("booking.timeHint", { open: minTimeStr, close: maxTimeStr })}
            </p>
            {lunchBreakLabel && (
              <p className="text-[11px] text-rose-600 mt-0.5">
                {t("booking.lunchBreakInfo", { start: lunchBreakLabel.start, end: lunchBreakLabel.end })}
              </p>
            )}
            {isSpecialOpenDay && (
              <p className="text-[11px] text-emerald-700 mt-0.5">
                ✓ {t("booking.specialOpenDayInfo")}
              </p>
            )}
            {isPastTime && (
              <div className="mt-1.5 text-xs px-3 py-2 rounded-lg border border-rose-300 bg-rose-50 text-rose-700 font-medium">
                ✗ {t("booking.error.pastTime")}
              </div>
            )}
            {!isPastTime && isNearKitchenClose && (
              <div className="mt-1.5 text-xs px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-900">
                ⚠ {t("booking.kitchenCloseWarn")}
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="label">{t("booking.field.partySize")} *</label>
          <PartySizePicker
            value={form.party_size}
            onChange={(n) => setForm({ ...form, party_size: n })}
          />
        </div>

        <div>
          <label className="label">{t("booking.field.notes")}</label>
          <textarea
            className="input" rows={2}
            placeholder={t("booking.field.notesPlaceholder")}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>
      </div>

      {/* คำถามเพิ่มเติม */}
      <div className="bg-white/60 rounded-2xl p-5 space-y-4 border border-slate-200">
        <div className="text-center">
          <div className="text-sm font-bold text-slate-700">{t("booking.helpUs.title")}</div>
          <div className="text-xs text-slate-500">{t("booking.helpUs.subtitle")}</div>
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.origin")}</div>
          <ChipGroup
            options={ORIGINS}
            value={form.customer_origin}
            onChange={(v) => setForm({ ...form, customer_origin: v ?? "" })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.source")}</div>
          <MultiChipGroup
            options={SOURCES}
            values={form.sources}
            onChange={(vs) => setForm({ ...form, sources: vs })}
          />
        </div>

        <div>
          <div className="text-xs font-semibold text-slate-500 mb-2">{t("booking.field.member")}</div>
          <ChipGroup
            options={[
              { value: "1", label: t("booking.member.yes") },
              { value: "0", label: t("booking.member.no") }
            ]}
            value={form.is_member === null ? "" : String(form.is_member)}
            onChange={(v) =>
              setForm({ ...form, is_member: v === null ? null : (Number(v) as 0 | 1) })
            }
          />
          {form.is_member === 0 && (
            <div className="mt-2 text-xs text-slate-500 bg-brand/5 border border-brand/20 rounded-lg p-2.5">
              {t("booking.member.hint")}
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-red-600 text-sm text-center">{error}</div>}

      <button disabled={submitting || isPastTime} className="btn-primary w-full text-base py-3.5">
        {submitting ? t("booking.cta.searching") : t("booking.cta.findTable")}
      </button>
    </form>
  );
}

function ChipGroup({
  options, value, onChange
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string | null) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => onChange(selected ? null : o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >{o.label}</button>
        );
      })}
    </div>
  );
}

function MultiChipGroup({
  options, values, onChange
}: {
  options: Array<{ value: string; label: string }>;
  values: string[];
  onChange: (vs: string[]) => void;
}) {
  function toggle(v: string) {
    if (values.includes(v)) onChange(values.filter((x) => x !== v));
    else onChange([...values, v]);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const selected = values.includes(o.value);
        return (
          <button
            type="button"
            key={o.value}
            onClick={() => toggle(o.value)}
            className={`px-3.5 py-2 rounded-full text-sm border-[1.5px] transition min-h-[40px] ${
              selected
                ? "bg-brand text-white border-brand shadow-sm"
                : "bg-white text-slate-600 border-slate-200 hover:border-brand/60 active:scale-95"
            }`}
          >
            {selected && <span className="mr-1">✓</span>}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PartySizePicker({
  value, onChange
}: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, value - 1))}
        className="w-12 h-12 rounded-xl border-[1.5px] border-slate-200 bg-white text-2xl font-bold text-slate-600 hover:border-brand active:scale-95 disabled:opacity-50"
        disabled={value <= 1}
      >−</button>
      <input
        type="number"
        inputMode="numeric"
        min={1} max={50}
        value={value}
        onChange={(e) => onChange(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
        className="input text-center text-xl font-bold flex-1 min-w-0"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(50, value + 1))}
        className="w-12 h-12 rounded-xl border-[1.5px] border-slate-200 bg-white text-2xl font-bold text-slate-600 hover:border-brand active:scale-95"
      >+</button>
    </div>
  );
}
