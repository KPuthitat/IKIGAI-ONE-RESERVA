"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Booking } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import CancelReasonModal from "../bookings/CancelReasonModal";

// Quick-action modal opened when admin clicks a booking block on the
// timetable. Mirrors the controls available on /admin/reserva/bookings:
//   - reassign table (dropdown limited to free + capacity-fitting tables)
//   - mark seated / completed / no_show
//   - cancel with reason (opens nested CancelReasonModal)
//   - link to the full /r/<ref> detail page for anything more advanced
//
// Date/time/party_size editing isn't here — that's the customer edit
// page (/reserva/edit/<ref>) and would clutter this small popover.

type Tone = "primary" | "success" | "warn" | "danger" | "neutral";

export default function BookingActionsModal({
  booking,
  availableTableIds,
  tables,
  onClose
}: {
  booking: Booking;
  /** Free tables for this booking's slot (excludes its own current table
   *  from the overlap check, so reassigning to "self" doesn't disappear). */
  availableTableIds: number[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  onClose: () => void;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showCancel, setShowCancel] = useState(false);

  async function setStatus(status: "seated" | "completed" | "no_show") {
    setBusy(true);
    setErr(null);
    const res = await fetch(apiUrl(`/api/admin/bookings/${booking.id}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    setBusy(false);
    if (!res.ok) {
      setErr(t("admin.bookings.errorGeneric"));
      return;
    }
    router.refresh();
    onClose();
  }

  async function changeTable(tableId: number | null) {
    setBusy(true);
    setErr(null);
    const res = await fetch(apiUrl(`/api/admin/bookings/${booking.id}/table`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table_id: tableId })
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || t("admin.bookings.errorGeneric"));
      return;
    }
    router.refresh();
  }

  async function submitCancel(reason: string) {
    setBusy(true);
    setErr(null);
    const res = await fetch(apiUrl(`/api/admin/bookings/${booking.id}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled", cancel_reason: reason })
    });
    setBusy(false);
    setShowCancel(false);
    if (!res.ok) {
      setErr(t("admin.bookings.errorGeneric"));
      return;
    }
    router.refresh();
    onClose();
  }

  // Visible action buttons depend on current status. Once seated, only
  // "completed" remains; once completed/cancelled, the modal is read-only.
  const allowSeat = booking.status === "confirmed";
  const allowComplete = booking.status === "seated";
  const allowNoShow = booking.status === "confirmed";
  const allowCancel = booking.status !== "cancelled" && booking.status !== "completed";

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
        onClick={onClose}
      >
        <div
          className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 my-8 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="font-bold text-slate-800 text-lg truncate">
                {booking.customer_name}
              </h2>
              <p className="text-xs text-slate-500 mt-1">
                {booking.booking_date} · {booking.booking_time} ·{" "}
                {t("admin.bookings.partySize", { n: booking.party_size })}
                {booking.ref_no && ` · #${booking.ref_no}`}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2"
            >×</button>
          </div>

          {/* Status pill */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">{t("admin.bookings.statusLabel")}:</span>
            <span className={`px-2 py-1 rounded text-xs status-${booking.status}`}>
              {t(`status.${booking.status}`)}
            </span>
          </div>

          {/* Phone (click to call) */}
          {booking.customer_phone && (
            <div className="text-sm">
              <span className="text-slate-500">{t("edit.row.phone")}: </span>
              <a href={`tel:${booking.customer_phone}`} className="text-brand font-medium">
                {booking.customer_phone}
              </a>
            </div>
          )}

          {booking.notes && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-sm">
              <div className="text-xs text-slate-500 mb-1">
                {t("admin.bookings.notesLabel")}
              </div>
              <div className="text-slate-700 whitespace-pre-wrap">{booking.notes}</div>
            </div>
          )}

          {/* Table reassignment — only when booking is still active */}
          {allowCancel && (
            <div>
              <label className="text-xs font-semibold text-slate-500">
                {t("admin.bookings.tableLabel")}
              </label>
              <select
                className="input mt-1"
                value={booking.table_id ?? ""}
                onChange={(e) =>
                  changeTable(e.target.value ? Number(e.target.value) : null)
                }
                disabled={busy}
              >
                <option value="">{t("admin.bookings.tableNone")}</option>
                {tables
                  .filter((tab) =>
                    tab.capacity >= booking.party_size &&
                    (tab.id === booking.table_id || availableTableIds.includes(tab.id))
                  )
                  .map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label} ({tab.capacity})
                    </option>
                  ))}
              </select>
            </div>
          )}

          {err && <div className="text-rose-600 text-sm">{err}</div>}

          {/* Status action buttons */}
          {(allowSeat || allowComplete || allowNoShow) && (
            <div className="grid grid-cols-1 gap-2 pt-1">
              {allowSeat && (
                <ActionButton tone="success" busy={busy} onClick={() => setStatus("seated")}>
                  {t("admin.bookings.btn.markSeated")}
                </ActionButton>
              )}
              {allowComplete && (
                <ActionButton tone="neutral" busy={busy} onClick={() => setStatus("completed")}>
                  {t("admin.bookings.btn.markCompleted")}
                </ActionButton>
              )}
              {allowNoShow && (
                <ActionButton tone="warn" busy={busy} onClick={() => setStatus("no_show")}>
                  {t("admin.bookings.btn.markNoShow")}
                </ActionButton>
              )}
            </div>
          )}

          {/* Footer: cancel + open in detail */}
          <div className="flex flex-col sm:flex-row gap-2 pt-3 border-t border-slate-100">
            {allowCancel && (
              <button
                type="button"
                onClick={() => setShowCancel(true)}
                disabled={busy}
                className="flex-1 py-2.5 rounded-lg border border-rose-300 text-rose-700 hover:bg-rose-50 text-sm font-medium"
              >
                {t("admin.bookings.btn.cancel")}
              </button>
            )}
            <Link
              href={`/r/${booking.ref_no ?? booking.id}`}
              target="_blank"
              className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium text-center"
            >
              {t("admin.bookings.btn.openDetail")}
            </Link>
          </div>
        </div>
      </div>

      {showCancel && (
        <CancelReasonModal
          bookingRef={booking.ref_no}
          customerLang={booking.lang === "en" ? "en" : "th"}
          busy={busy}
          onClose={() => setShowCancel(false)}
          onConfirm={submitCancel}
        />
      )}
    </>
  );
}

function ActionButton({
  tone, busy, onClick, children
}: {
  tone: Tone;
  busy: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const cls =
    tone === "primary" ? "btn-primary"
    : tone === "success" ? "btn-success"
    : tone === "warn" ? "btn-secondary text-amber-700"
    : tone === "danger" ? "btn-danger"
    : "btn-secondary";
  return (
    <button type="button" onClick={onClick} disabled={busy} className={`${cls} text-sm`}>
      {children}
    </button>
  );
}
