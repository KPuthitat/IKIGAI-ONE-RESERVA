"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Booking, Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";
import BookingForm, { type BookingFormMode } from "@/app/reserva/[branch]/BookingForm";

type Row = Booking & { table_label: string | null };

function formatSource(s: string | null): string {
  if (!s) return "";
  if (s.startsWith("[")) {
    try { return (JSON.parse(s) as string[]).join(", "); } catch { return s; }
  }
  return s;
}

export default function BookingsClient({
  bookings,
  tables,
  canEdit,
  branch
}: {
  bookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  canEdit: boolean;
  branch: Branch;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { confirm, alert, ConfirmDialog } = useConfirm();
  // Channel of the active add-booking modal — null = closed.
  const [addModalOpen, setAddModalOpen] = useState<null | "walkin" | "phone">(null);

  async function setStatus(id: number, status: Row["status"]) {
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    setBusyId(null);
    if (!res.ok) alert({
      title: t("common.error"),
      body: <p>{t("admin.bookings.errorGeneric")}</p>,
      variant: "danger",
      okLabel: t("common.confirm")
    });
    router.refresh();
  }

  async function cancelBooking(id: number) {
    const ok = await confirm({
      title: t("admin.bookings.confirmCancelTitle"),
      body: <p>{t("admin.bookings.confirmCancel")}</p>,
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.back"),
      variant: "danger"
    });
    if (ok === null) return;
    setStatus(id, "cancelled");
  }

  async function assignTable(id: number, tableId: number | null) {
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/table`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table_id: tableId })
    });
    setBusyId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(j.error || t("admin.bookings.errorGeneric"));
    }
    router.refresh();
  }

  if (bookings.length === 0) {
    return <div className="card text-slate-500 text-center py-10">{t("admin.dashboard.noBookings")}</div>;
  }

  return (
    <>
    <div className="space-y-3">
      {/* Quick-add buttons — walk-in for customers in front of you,
          phone for someone calling to reserve a future slot. */}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setAddModalOpen("walkin")}
          className="btn-primary text-sm">
          + {t("admin.bookings.addWalkin")}
        </button>
        <button type="button" onClick={() => setAddModalOpen("phone")}
          className="btn-secondary text-sm">
          + {t("admin.bookings.addPhone")}
        </button>
      </div>
      {bookings.map((b) => (
        <div key={b.id} className={`card ${b.status === "cancelled" ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="text-2xl font-bold w-20">{b.booking_time}</div>
            <div className="flex-1 min-w-[200px]">
              <div className="font-medium flex items-center gap-2 flex-wrap">
                {b.customer_name}
                <span className="text-slate-500 font-normal">{t("admin.bookings.partySize", { n: b.party_size })}</span>
                {b.is_member === 1 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-bold">
                    {t("admin.bookings.member.is")}
                  </span>
                )}
                {b.is_member === 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">
                    {t("admin.bookings.member.not")}
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-500 flex flex-wrap gap-x-2">
                <a href={`tel:${b.customer_phone}`} className="text-brand">{b.customer_phone}</a>
                {b.source && (
                  <span>{t("admin.bookings.knownFrom", { source: formatSource(b.source) })}</span>
                )}
                {b.customer_origin && (
                  <span>{t("admin.bookings.from", { origin: t(`booking.origin.${b.customer_origin}`) })}</span>
                )}
              </div>
              {b.notes && <div className="text-sm text-slate-600 mt-1">📝 {b.notes}</div>}
            </div>
            <div className="text-sm">
              <span className={`px-2 py-1 rounded text-xs status-${b.status}`}>
                {t(`status.${b.status}`)}
              </span>
              <div className="mt-1 text-slate-600">
                {t("admin.bookings.tableLabel")}{" "}
                {canEdit ? (
                  <select
                    className="text-sm border rounded px-1"
                    value={b.table_id ?? ""}
                    onChange={(e) => assignTable(b.id, e.target.value ? Number(e.target.value) : null)}
                    disabled={busyId === b.id || b.status === "cancelled"}
                  >
                    <option value="">{t("admin.bookings.tableNone")}</option>
                    {tables.map((tab) => (
                      <option key={tab.id} value={tab.id}>{tab.label} ({tab.capacity})</option>
                    ))}
                  </select>
                ) : (b.table_label ?? "—")}
              </div>
            </div>
          </div>

          {canEdit && b.status !== "cancelled" && b.status !== "completed" && (
            <div className="flex flex-wrap gap-2 mt-3 border-t border-slate-100 pt-3">
              {b.status === "confirmed" && (
                <button
                  onClick={() => setStatus(b.id, "seated")}
                  disabled={busyId === b.id}
                  className="btn-success"
                >{t("admin.bookings.btn.markSeated")}</button>
              )}
              {b.status === "seated" && (
                <button
                  onClick={() => setStatus(b.id, "completed")}
                  disabled={busyId === b.id}
                  className="btn-secondary"
                >{t("admin.bookings.btn.markCompleted")}</button>
              )}
              {b.status === "confirmed" && (
                <>
                  <button
                    onClick={() => setStatus(b.id, "no_show")}
                    disabled={busyId === b.id}
                    className="btn-secondary text-amber-700"
                  >{t("admin.bookings.btn.markNoShow")}</button>
                  <button
                    onClick={() => cancelBooking(b.id)}
                    disabled={busyId === b.id}
                    className="btn-danger"
                  >{t("admin.bookings.btn.cancel")}</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
    {ConfirmDialog}
    {addModalOpen && (
      <AddBookingModal
        mode={addModalOpen}
        branch={branch}
        onClose={() => setAddModalOpen(null)}
        onSaved={() => { setAddModalOpen(null); router.refresh(); }}
      />
    )}
    </>
  );
}

// ── Walk-in / Phone booking modal ─────────────────────────────────────
// Wraps the same BookingForm component that customers use online, with a
// `mode` prop that switches submit endpoint and adjusts defaults. This
// guarantees the staff form looks and selects exactly like the customer
// form — no parallel implementation to keep in sync.
function AddBookingModal({
  mode, branch, onClose, onSaved
}: {
  mode: "walkin" | "phone";
  branch: Branch;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const titleKey = mode === "walkin" ? "admin.bookings.modal.walkinTitle" : "admin.bookings.modal.phoneTitle";
  const subtitleKey = mode === "walkin" ? "admin.bookings.modal.walkinSubtitle" : "admin.bookings.modal.phoneSubtitle";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-slate-100 rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 my-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800 text-lg">{t(titleKey)}</h2>
            <p className="text-xs text-slate-500 mt-1">{t(subtitleKey)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2"
          >×</button>
        </div>

        {/* Reuse the customer-facing BookingForm so both flows share the
            exact same input layout, chip groups, party-size picker, time
            pickers, and validation. The mode prop adjusts defaults +
            submit endpoint. liffId=null because admin doesn't need LIFF. */}
        <BookingForm
          branch={branch}
          liffId={null}
          mode={mode}
          onSuccess={() => onSaved()}
        />
      </div>
    </div>
  );
}
