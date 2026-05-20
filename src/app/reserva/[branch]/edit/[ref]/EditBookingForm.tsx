"use client";

// Compact edit form embedded in /reserva/edit/[ref]. Customer can change
// party size, date, time, notes — or cancel the booking outright. The
// 2-hour cutoff is enforced both here (button states) and on the API
// route (definitive guard).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import type { Branch } from "@/lib/db";
import { useLang } from "@/lib/LangProvider";
import TimePicker from "@/app/components/TimePicker";

export default function EditBookingForm({
  ref_no, branch, initial
}: {
  ref_no: string;
  branch: Branch;
  initial: {
    party_size: number;
    booking_date: string;
    booking_time: string;
    notes: string;
  };
}) {
  const router = useRouter();
  const { t } = useLang();

  const [partySize, setPartySize] = useState(initial.party_size);
  const [date, setDate] = useState(initial.booking_date);
  const [time, setTime] = useState(initial.booking_time);
  const [notes, setNotes] = useState(initial.notes);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 15-min slots between open and close on the selected date, minus
  // any lunch break that applies to that day. Mirrors the picker on
  // the new-booking form so customers see the same options.
  const timeOptions = useMemo(() => {
    const toMin = (s: string | null | undefined): number | null => {
      if (!s || !/^\d{2}:\d{2}$/.test(s)) return null;
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m;
    };
    const fromMin = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const parseArr = <T,>(s: string | null): T[] => {
      if (!s) return [];
      try { const a = JSON.parse(s); return Array.isArray(a) ? a as T[] : []; } catch { return []; }
    };
    const open  = toMin(branch.open_time)  ?? 11 * 60;
    const close = toMin(branch.close_time) ?? 22 * 60;
    // Resolve lunch break for the selected date (skips weekends or
    // dates listed in no_lunch_break_dates, matching the customer
    // landing page rule).
    let lbS: number | null = null, lbE: number | null = null;
    const lbStart = toMin(branch.lunch_break_start);
    const lbEnd   = toMin(branch.lunch_break_end);
    if (lbStart != null && lbEnd != null && lbEnd > lbStart) {
      const weekdays = parseArr<number>(branch.lunch_break_weekdays);
      const exceptions = new Set(parseArr<string>(branch.no_lunch_break_dates));
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekdays.includes(dow) && !exceptions.has(date)) {
        lbS = lbStart; lbE = lbEnd;
      }
    }
    const start = Math.ceil(open / 15) * 15;
    const end = Math.floor(close / 15) * 15;
    const opts: string[] = [];
    for (let m = start; m <= end; m += 15) {
      if (lbS != null && lbE != null && m >= lbS && m < lbE) continue;
      opts.push(fromMin(m));
    }
    return opts;
  }, [branch.open_time, branch.close_time,
      branch.lunch_break_start, branch.lunch_break_end,
      branch.lunch_break_weekdays, branch.no_lunch_break_dates, date]);

  // When the date change makes the previously-picked time invalid
  // (e.g. it now lands inside a lunch break that wasn't there before),
  // snap to the closest same-or-later available slot so the customer
  // can't save a time the kitchen won't accept.
  useEffect(() => {
    if (timeOptions.length === 0) return;
    if (timeOptions.includes(time)) return;
    const parts = time.split(":");
    const cur = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : NaN;
    const later = Number.isFinite(cur)
      ? timeOptions.find((o) => {
          const [oh, om] = o.split(":").map(Number);
          return oh * 60 + om >= cur;
        })
      : undefined;
    setTime(later ?? timeOptions[0]);
  }, [timeOptions, time]);

  async function save(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/reserva/edit/${ref_no}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          party_size: partySize,
          booking_date: date,
          booking_time: time,
          notes
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t("edit.savedOk") });
        router.refresh();
      } else {
        const errKey =
          j?.error === "edit_window_closed" ? "edit.err.cutoff" :
          j?.error === "table_unavailable" ? "edit.err.tableUnavailable" :
          j?.error === "not_found" ? "edit.err.notFound" :
          "common.error";
        setMsg({ kind: "err", text: t(errKey) });
      }
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
    }
  }

  async function cancelBooking(): Promise<void> {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/reserva/edit/${ref_no}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        setMsg({ kind: "ok", text: t("edit.cancelOk") });
        router.refresh();
      } else {
        const errKey =
          j?.error === "edit_window_closed" ? "edit.err.cutoff" :
          j?.error === "not_found" ? "edit.err.notFound" :
          "common.error";
        setMsg({ kind: "err", text: t(errKey) });
      }
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }

  return (
    <div className="card space-y-4">
      <h2 className="font-semibold text-slate-800">
        {t("edit.formTitle")}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">{t("edit.row.party")}</label>
          <input type="number" min={1} max={50} className="input"
            value={partySize}
            onChange={(e) => setPartySize(Math.max(1, Number(e.target.value)))} />
        </div>
        <div>
          <label className="label">{t("edit.row.date")}</label>
          <input type="date" className="input" value={date} min={today}
            onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">{t("edit.row.time")}</label>
          <TimePicker
            value={time}
            onChange={setTime}
            options={timeOptions}
            hourLabel={t("booking.timeHour")}
            minuteLabel={t("booking.timeMinute")}
          />
        </div>
      </div>

      <div>
        <label className="label">{t("edit.row.notes")}</label>
        <textarea className="input" rows={2} maxLength={500}
          value={notes}
          onChange={(e) => setNotes(e.target.value)} />
      </div>

      {msg && (
        <div className={`text-sm ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={save} disabled={busy}
          className="flex-1 btn-primary">
          {busy ? "…" : t("edit.btn.save")}
        </button>
        {confirmCancel ? (
          <div className="flex-1 flex gap-2">
            <button type="button" onClick={() => setConfirmCancel(false)} disabled={busy}
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
              {t("common.cancel")}
            </button>
            <button type="button" onClick={cancelBooking} disabled={busy}
              className="flex-1 py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm font-bold">
              {busy ? "…" : t("edit.btn.confirmCancel")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmCancel(true)} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm font-medium">
            {t("edit.btn.cancelBooking")}
          </button>
        )}
      </div>
    </div>
  );
}
