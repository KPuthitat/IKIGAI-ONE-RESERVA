"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Booking } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";

type Row = Booking & { table_label: string | null };

const AUTO_REFRESH_MS = 30_000;

export default function PendingClient({
  pendingBookings,
  tables
}: {
  pendingBookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
}) {
  const router = useRouter();
  const { t, lang } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  // Per-row table picker state. Allow each pending booking to remember its
  // own pick while admin is reviewing several at once.
  const [tablePick, setTablePick] = useState<Record<number, number | "">>({});
  const [lastRefresh, setLastRefresh] = useState<Date>(() => new Date());

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return;
      router.refresh();
      setLastRefresh(new Date());
    };
    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [router]);

  async function confirmAndNotify(id: number) {
    const tableId = tablePick[id];
    if (!tableId) {
      alert({
        title: t("common.error"),
        body: <p>{t("admin.bookings.pending.noTablePicked")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
      return;
    }
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/confirm`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table_id: tableId })
    });
    setBusyId(null);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const codeMap: Record<string, string> = {
        table_unavailable: t("admin.bookings.err.tableUnavailable")
      };
      alert({
        title: t("common.error"),
        body: <p>{codeMap[j.error] || t("admin.bookings.errorGeneric")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
      return;
    }
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
    setBusyId(id);
    const res = await fetch(apiUrl(`/api/admin/bookings/${id}/status`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "cancelled" })
    });
    setBusyId(null);
    if (!res.ok) {
      alert({
        title: t("common.error"),
        body: <p>{t("admin.bookings.errorGeneric")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
      return;
    }
    router.refresh();
  }

  if (pendingBookings.length === 0) {
    return (
      <>
        <div className="text-xs text-slate-400 text-right">
          {t("admin.bookings.lastRefresh", {
            time: lastRefresh.toLocaleTimeString(lang === "en" ? "en-US" : "th-TH", {
              hour: "2-digit", minute: "2-digit", second: "2-digit"
            })
          })}
        </div>
        <div className="card text-slate-500 text-center py-12">
          <div className="text-3xl mb-2">✓</div>
          <div className="font-bold text-slate-700">{t("admin.pending.empty.title")}</div>
          <div className="text-xs mt-1">{t("admin.pending.empty.body")}</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="text-xs text-slate-400 text-right">
        {t("admin.bookings.lastRefresh", {
          time: lastRefresh.toLocaleTimeString(lang === "en" ? "en-US" : "th-TH", {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
          })
        })}
      </div>
      <div className="rounded-2xl border-[1.5px] border-amber-300 bg-amber-50/50 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">⏳</span>
          <h2 className="font-bold text-amber-900">
            {t("admin.bookings.pending.title", { n: pendingBookings.length })}
          </h2>
        </div>
        <p className="text-xs text-amber-800/80">
          {t("admin.bookings.pending.hint")}
        </p>
        {pendingBookings.map((b) => (
          <div key={b.id} className="card border-amber-200">
            <div className="flex flex-wrap items-start gap-3">
              <div className="text-2xl font-bold w-20">{b.booking_time}</div>
              <div className="flex-1 min-w-[200px]">
                <div className="font-medium flex items-center gap-2 flex-wrap">
                  {b.customer_name}
                  <span className="text-slate-500 font-normal">
                    {t("admin.bookings.partySize", { n: b.party_size })}
                  </span>
                  <span className="text-xs text-amber-700">· {b.booking_date}</span>
                </div>
                <div className="text-sm text-slate-500 flex flex-wrap gap-x-2">
                  <a href={`tel:${b.customer_phone}`} className="text-brand">
                    {b.customer_phone}
                  </a>
                  {b.ref_no && <span className="text-slate-400">#{b.ref_no}</span>}
                </div>
                {b.notes && (
                  <div className="text-sm text-slate-600 mt-1">
                    {t("admin.bookings.notesLabel")}: {b.notes}
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3 border-t border-slate-100 pt-3">
              <label className="text-sm text-slate-600">
                {t("admin.bookings.pending.assignTable")}:
              </label>
              <select
                className="text-sm border rounded px-2 py-1.5"
                value={tablePick[b.id] ?? ""}
                onChange={(e) =>
                  setTablePick((prev) => ({
                    ...prev,
                    [b.id]: e.target.value ? Number(e.target.value) : ""
                  }))
                }
                disabled={busyId === b.id}
              >
                <option value="">{t("admin.bookings.tableNone")}</option>
                {tables
                  .filter((tab) => tab.capacity >= b.party_size)
                  .map((tab) => (
                    <option key={tab.id} value={tab.id}>
                      {tab.label} ({tab.capacity})
                    </option>
                  ))}
              </select>
              <button
                onClick={() => confirmAndNotify(b.id)}
                disabled={busyId === b.id || !tablePick[b.id]}
                className="btn-primary text-sm ml-auto"
              >
                {t("admin.bookings.pending.confirmAndNotify")}
              </button>
              <button
                onClick={() => cancelBooking(b.id)}
                disabled={busyId === b.id}
                className="btn-secondary text-sm text-rose-700"
              >
                {t("admin.bookings.btn.cancel")}
              </button>
            </div>
          </div>
        ))}
      </div>
      {ConfirmDialog}
    </>
  );
}
