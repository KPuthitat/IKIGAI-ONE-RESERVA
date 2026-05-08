"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Booking } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";

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
  branchOpenTime,
  branchCloseTime
}: {
  bookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  canEdit: boolean;
  branchOpenTime?: string;        // 'HH:MM' — for the walk-in modal time picker
  branchCloseTime?: string;
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { confirm, alert, ConfirmDialog } = useConfirm();
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
        kind={addModalOpen}
        tables={tables}
        branchOpenTime={branchOpenTime}
        branchCloseTime={branchCloseTime}
        onClose={() => setAddModalOpen(null)}
        onSaved={() => { setAddModalOpen(null); router.refresh(); }}
      />
    )}
    </>
  );
}

// ── Walk-in / Phone booking modal ──────────────────────────────────────

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

function AddBookingModal({
  kind, tables, branchOpenTime, branchCloseTime, onClose, onSaved
}: {
  kind: "walkin" | "phone";
  tables: Array<{ id: number; label: string; capacity: number }>;
  branchOpenTime?: string;
  branchCloseTime?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();

  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16);

  const [name, setName] = useState(kind === "walkin" ? t("admin.bookings.walkinDefaultName") : "");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [tableId, setTableId] = useState<number | null>(null);
  // Walk-in defaults to today + now; phone defaults to today + branch open
  const [date, setDate] = useState(todayBkk);
  const [time, setTime] = useState(kind === "walkin" ? nowBkk : (branchOpenTime ?? "18:00"));
  const [sources, setSources] = useState<string[]>([]);
  const [origin, setOrigin] = useState<string>("");
  const [isMember, setIsMember] = useState<0 | 1 | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function toggleSource(v: string): void {
    setSources((prev) => prev.includes(v) ? prev.filter((s) => s !== v) : [...prev, v]);
  }

  async function save(): Promise<void> {
    if (!name.trim()) { setErr(t("admin.bookings.err.nameRequired")); return; }
    if (kind === "phone" && !phone.trim()) { setErr(t("admin.bookings.err.phoneRequired")); return; }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl("/api/admin/reserva/bookings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: name.trim(),
          customer_phone: phone.trim(),
          party_size: partySize,
          booking_date: date,
          booking_time: time,
          table_id: tableId,
          source: sources.length > 0 ? JSON.stringify(sources) : "",
          customer_origin: origin || "",
          is_member: isMember,
          notes: notes.trim(),
          booking_channel: kind
        })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.id) {
        onSaved();
      } else {
        const errKey =
          j?.error === "table_unavailable" ? "admin.bookings.err.tableUnavailable" :
          j?.error === "no_past_booking" ? "admin.bookings.err.noPast" :
          "common.error";
        setErr(t(errKey));
      }
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const titleKey = kind === "walkin" ? "admin.bookings.modal.walkinTitle" : "admin.bookings.modal.phoneTitle";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold text-slate-800 text-lg">{t(titleKey)}</h3>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("booking.field.name")} *</label>
            <input className="input" value={name} maxLength={100}
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">
              {t("booking.field.phone")} {kind === "phone" ? "*" : ""}
            </label>
            <input className="input" value={phone} maxLength={30}
              type="tel" inputMode="tel"
              onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">{t("admin.bookings.partySizeLabel")} *</label>
            <input type="number" className="input" min={1} max={50}
              value={partySize}
              onChange={(e) => setPartySize(Math.max(1, Number(e.target.value)))} />
          </div>
          <div>
            <label className="label">{t("booking.field.date")} *</label>
            <input type="date" className="input" value={date} min={kind === "phone" ? todayBkk : undefined}
              onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">{t("booking.field.time")} *</label>
            <input type="time" className="input" value={time}
              min={branchOpenTime} max={branchCloseTime}
              onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">{t("admin.bookings.tableLabel")}</label>
          <select className="input"
            value={tableId == null ? "" : String(tableId)}
            onChange={(e) => setTableId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">— {t("admin.bookings.tableAuto")} —</option>
            {tables
              .filter((tbl) => tbl.capacity >= partySize)
              .map((tbl) => (
                <option key={tbl.id} value={String(tbl.id)}>
                  {tbl.label} ({tbl.capacity})
                </option>
              ))}
          </select>
        </div>

        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
            {t("admin.bookings.moreFields")}
          </summary>
          <div className="space-y-3 mt-3 pt-3 border-t border-slate-200">
            <div>
              <label className="label">{t("booking.field.source")}</label>
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_DEFS.map((s) => (
                  <button type="button" key={s.value}
                    onClick={() => toggleSource(s.value)}
                    className={`text-xs px-2 py-1 rounded border ${
                      sources.includes(s.value)
                        ? "bg-brand text-white border-brand"
                        : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                    }`}>
                    {t(s.key)}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">{t("booking.field.origin")}</label>
                <select className="input" value={origin} onChange={(e) => setOrigin(e.target.value)}>
                  <option value="">—</option>
                  {ORIGIN_DEFS.map((o) => (
                    <option key={o.value} value={o.value}>{t(o.key)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label">{t("booking.field.isMember")}</label>
                <select className="input"
                  value={isMember == null ? "" : String(isMember)}
                  onChange={(e) => setIsMember(e.target.value === "" ? null : (Number(e.target.value) as 0 | 1))}>
                  <option value="">—</option>
                  <option value="1">{t("admin.bookings.member.is")}</option>
                  <option value="0">{t("admin.bookings.member.not")}</option>
                </select>
              </div>
            </div>
            <div>
              <label className="label">{t("booking.field.notes")}</label>
              <textarea className="input min-h-[60px]" value={notes} maxLength={500}
                onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
        </details>

        {err && <p className="text-rose-600 text-sm">✗ {err}</p>}

        <div className="flex gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
            {busy ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
