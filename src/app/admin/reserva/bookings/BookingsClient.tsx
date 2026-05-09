"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Booking, Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";
import BookingForm from "@/app/reserva/[branch]/BookingForm";

type Row = Booking & { table_label: string | null };

function formatSource(s: string | null): string {
  if (!s) return "";
  if (s.startsWith("[")) {
    try { return (JSON.parse(s) as string[]).join(", "); } catch { return s; }
  }
  return s;
}

// How often we re-fetch the bookings list to surface new pending requests.
// 30s is a balance between latency (admin sees a new booking within ~30s
// of the customer pressing submit) and CPU/network cost (lightweight SQL
// query, no LINE API hits). router.refresh() preserves scroll + state.
const AUTO_REFRESH_MS = 30_000;

export default function BookingsClient({
  pendingBookings,
  upcomingBookings,
  tables,
  canEdit,
  branch,
  fromDate
}: {
  pendingBookings: Row[];
  upcomingBookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  canEdit: boolean;
  branch: Branch;
  fromDate: string;
}) {
  const router = useRouter();
  const { t, lang } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  const { confirm, alert, ConfirmDialog } = useConfirm();
  // Channel of the active add-booking modal — null = closed.
  const [addModalOpen, setAddModalOpen] = useState<null | "walkin" | "phone" | "line">(null);

  // After +จองผ่านไลน์ saves WITHOUT a known LINE userId, pop a second
  // modal that gives admin a claim link to paste in the LINE chat.
  const [claimModalRef, setClaimModalRef] = useState<string | null>(null);

  // Per-row table picker for the pending-review section.
  const [pendingTablePick, setPendingTablePick] = useState<Record<number, number | "">>({});

  // Last refresh timestamp, shown in the header so admin can see the page
  // is alive. Updated each time router.refresh() resolves (we just track
  // when the auto-refresh tick fires).
  const [lastRefresh, setLastRefresh] = useState<Date>(() => new Date());

  // Auto-refresh: poll every 30s. Pauses when the tab is in the background
  // (saves battery + LINE API quota; admin will see the count update when
  // they switch back). Also pauses while a modal is open so the form
  // doesn't get re-rendered out from under the user.
  useEffect(() => {
    const modalOpen = addModalOpen !== null || claimModalRef !== null;
    if (modalOpen) return;
    const tick = () => {
      if (document.hidden) return;
      router.refresh();
      setLastRefresh(new Date());
    };
    const id = setInterval(tick, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [router, addModalOpen, claimModalRef]);

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

  async function confirmAndNotify(id: number) {
    const tableId = pendingTablePick[id];
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

  // Group upcoming bookings by date so we can render with date headers.
  // Keys are YYYY-MM-DD strings; iteration order is insertion order which
  // matches the SQL ORDER BY booking_date ASC.
  const groupedByDate = useMemo(() => {
    const map = new Map<string, Row[]>();
    for (const b of upcomingBookings) {
      const arr = map.get(b.booking_date) ?? [];
      arr.push(b);
      map.set(b.booking_date, arr);
    }
    return map;
  }, [upcomingBookings]);

  const isEmpty = pendingBookings.length === 0 && upcomingBookings.length === 0;

  return (
    <>
    <div className="space-y-3">
      <AddBookingButtons setAddModalOpen={setAddModalOpen} t={t} />

      <div className="text-xs text-slate-400 text-right">
        {t("admin.bookings.lastRefresh", {
          time: lastRefresh.toLocaleTimeString(lang === "en" ? "en-US" : "th-TH", {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
          })
        })}
      </div>

      {/* Pending review — always at top. Crosses dates because admin needs
          to act on these regardless of when the booking is for. */}
      {pendingBookings.length > 0 && (
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
            <PendingBookingCard
              key={b.id}
              b={b}
              tables={tables}
              busyId={busyId}
              canEdit={canEdit}
              pendingTablePick={pendingTablePick}
              setPendingTablePick={setPendingTablePick}
              onConfirm={() => confirmAndNotify(b.id)}
              onCancel={() => cancelBooking(b.id)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Empty state when no upcoming + no pending */}
      {isEmpty && (
        <div className="card text-slate-500 text-center py-10">
          {t("admin.dashboard.noBookings")}
        </div>
      )}

      {/* Upcoming bookings, grouped by date */}
      {Array.from(groupedByDate.entries()).map(([date, list]) => (
        <DateGroup
          key={date}
          date={date}
          bookings={list}
          tables={tables}
          busyId={busyId}
          canEdit={canEdit}
          onAssignTable={assignTable}
          onSetStatus={setStatus}
          onCancel={cancelBooking}
          t={t}
          lang={lang}
        />
      ))}

      {fromDate && upcomingBookings.length === 0 && pendingBookings.length === 0 && (
        <div className="text-center text-xs text-slate-400 py-2">
          {t("admin.bookings.noUpcomingFromDate", {
            date: formatDateThaiShort(fromDate, lang)
          })}
        </div>
      )}
    </div>
    {ConfirmDialog}
    {addModalOpen && (
      <AddBookingModal
        mode={addModalOpen}
        branch={branch}
        onClose={() => setAddModalOpen(null)}
        onSaved={(result) => {
          setAddModalOpen(null);
          if (result?.mode === "line" && result.ref && !result.hasLineUserId) {
            setClaimModalRef(result.ref);
          }
          router.refresh();
        }}
      />
    )}
    {claimModalRef && (
      <ClaimLinkModal
        refNo={claimModalRef}
        onClose={() => setClaimModalRef(null)}
      />
    )}
    </>
  );
}

// ── "เพิ่มการจอง" section — quick-add buttons (walk-in / phone / line)
//    + scan QR shortcut. Labeled section so admin sees a clear visual
//    grouping for the actions, distinct from the listings below.
function AddBookingButtons({
  setAddModalOpen,
  t
}: {
  setAddModalOpen: (m: "walkin" | "phone" | "line") => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-bold text-slate-700">
        {t("admin.bookings.addSection")}
      </h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setAddModalOpen("walkin")}
          className="btn-primary text-sm">
          + {t("admin.bookings.addWalkin")}
        </button>
        <button type="button" onClick={() => setAddModalOpen("phone")}
          className="btn-secondary text-sm">
          + {t("admin.bookings.addPhone")}
        </button>
        <button type="button" onClick={() => setAddModalOpen("line")}
          className="btn-secondary text-sm">
          + {t("admin.bookings.addLine")}
        </button>
        <Link href="/admin/reserva/scan"
          className="ml-auto inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 text-sm text-slate-700 hover:bg-slate-50">
          {t("admin.bookings.scanBtn")}
        </Link>
      </div>
    </section>
  );
}

// ── Pending review card ──────────────────────────────────────────────
function PendingBookingCard({
  b, tables, busyId, canEdit, pendingTablePick, setPendingTablePick,
  onConfirm, onCancel, t
}: {
  b: Row;
  tables: Array<{ id: number; label: string; capacity: number }>;
  busyId: number | null;
  canEdit: boolean;
  pendingTablePick: Record<number, number | "">;
  setPendingTablePick: (fn: (prev: Record<number, number | "">) => Record<number, number | "">) => void;
  onConfirm: () => void;
  onCancel: () => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="card border-amber-200">
      <div className="flex flex-wrap items-start gap-3">
        <div className="text-2xl font-bold w-20">{b.booking_time}</div>
        <div className="flex-1 min-w-[200px]">
          <div className="font-medium flex items-center gap-2 flex-wrap">
            {b.customer_name}
            <span className="text-slate-500 font-normal">{t("admin.bookings.partySize", { n: b.party_size })}</span>
            <span className="text-xs text-amber-700">· {b.booking_date}</span>
          </div>
          <div className="text-sm text-slate-500 flex flex-wrap gap-x-2">
            <a href={`tel:${b.customer_phone}`} className="text-brand">{b.customer_phone}</a>
            {b.ref_no && <span className="text-slate-400">#{b.ref_no}</span>}
            {b.source && (
              <span>{t("admin.bookings.knownFrom", { source: formatSource(b.source) })}</span>
            )}
          </div>
          {b.notes && <div className="text-sm text-slate-600 mt-1">{t("admin.bookings.notesLabel")}: {b.notes}</div>}
        </div>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 mt-3 border-t border-slate-100 pt-3">
          <label className="text-sm text-slate-600">
            {t("admin.bookings.pending.assignTable")}:
          </label>
          <select
            className="text-sm border rounded px-2 py-1.5"
            value={pendingTablePick[b.id] ?? ""}
            onChange={(e) =>
              setPendingTablePick((prev) => ({
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
            onClick={onConfirm}
            disabled={busyId === b.id || !pendingTablePick[b.id]}
            className="btn-primary text-sm ml-auto"
          >
            {t("admin.bookings.pending.confirmAndNotify")}
          </button>
          <button
            onClick={onCancel}
            disabled={busyId === b.id}
            className="btn-secondary text-sm text-rose-700"
          >
            {t("admin.bookings.btn.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Date group with header ────────────────────────────────────────────
function DateGroup({
  date, bookings, tables, busyId, canEdit,
  onAssignTable, onSetStatus, onCancel,
  t, lang
}: {
  date: string;
  bookings: Row[];
  tables: Array<{ id: number; label: string; capacity: number }>;
  busyId: number | null;
  canEdit: boolean;
  onAssignTable: (id: number, tableId: number | null) => void;
  onSetStatus: (id: number, status: Row["status"]) => void;
  onCancel: (id: number) => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
  lang: "th" | "en";
}) {
  return (
    <section id={`date-${date}`} className="space-y-2 pt-1">
      <h3 className="sticky top-0 z-10 -mx-1 px-3 py-1.5 bg-slate-100/95 backdrop-blur text-sm font-bold text-slate-700 border-b border-slate-200">
        {formatDateHeader(date, lang)}
        <span className="font-normal text-slate-500 ml-2">
          · {t("admin.bookings.dateGroupCount", { n: bookings.length })}
        </span>
      </h3>
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
              {b.notes && <div className="text-sm text-slate-600 mt-1">{t("admin.bookings.notesLabel")}: {b.notes}</div>}
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
                    onChange={(e) => onAssignTable(b.id, e.target.value ? Number(e.target.value) : null)}
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
                  onClick={() => onSetStatus(b.id, "seated")}
                  disabled={busyId === b.id}
                  className="btn-success"
                >{t("admin.bookings.btn.markSeated")}</button>
              )}
              {b.status === "seated" && (
                <button
                  onClick={() => onSetStatus(b.id, "completed")}
                  disabled={busyId === b.id}
                  className="btn-secondary"
                >{t("admin.bookings.btn.markCompleted")}</button>
              )}
              {b.status === "confirmed" && (
                <>
                  <button
                    onClick={() => onSetStatus(b.id, "no_show")}
                    disabled={busyId === b.id}
                    className="btn-secondary text-amber-700"
                  >{t("admin.bookings.btn.markNoShow")}</button>
                  <button
                    onClick={() => onCancel(b.id)}
                    disabled={busyId === b.id}
                    className="btn-danger"
                  >{t("admin.bookings.btn.cancel")}</button>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// ── Walk-in / Phone / Line booking modal ───────────────────────────────
function AddBookingModal({
  mode, branch, onClose, onSaved
}: {
  mode: "walkin" | "phone" | "line";
  branch: Branch;
  onClose: () => void;
  onSaved: (result?: {
    id: number;
    ref: string | null;
    mode: "customer" | "walkin" | "phone" | "line";
    hasLineUserId: boolean;
  }) => void;
}) {
  const { t } = useLang();
  const titleKey =
    mode === "walkin" ? "admin.bookings.modal.walkinTitle"
    : mode === "phone" ? "admin.bookings.modal.phoneTitle"
    : "admin.bookings.modal.lineTitle";
  const subtitleKey =
    mode === "walkin" ? "admin.bookings.modal.walkinSubtitle"
    : mode === "phone" ? "admin.bookings.modal.phoneSubtitle"
    : "admin.bookings.modal.lineSubtitle";

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

        <BookingForm
          branch={branch}
          liffId={null}
          mode={mode}
          onSuccess={(result) => onSaved(result)}
        />
      </div>
    </div>
  );
}

// ── Claim-link modal — shown after +จองผ่านไลน์ saves a booking with no
//    LINE userId. Gives admin a one-tap link to paste into the LINE OA chat.
function ClaimLinkModal({ refNo, onClose }: { refNo: string; onClose: () => void }) {
  const { t } = useLang();
  const [copied, setCopied] = useState<"" | "link" | "msg">("");

  function buildUrl(): string {
    if (typeof window === "undefined") return `/r/${refNo}/claim`;
    return `${window.location.origin}/r/${refNo}/claim`;
  }
  function buildMessage(): string {
    return t("admin.bookings.claimLink.messageTemplate", {
      ref: refNo,
      url: buildUrl()
    });
  }

  async function copyToClipboard(text: string, kind: "link" | "msg") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      // ignore — older browser fallback could be added if needed
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-lg w-full p-5 my-8 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold text-slate-800 text-lg">
              {t("admin.bookings.claimLink.title")}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              {t("admin.bookings.claimLink.subtitle", { ref: refNo })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2"
          >×</button>
        </div>

        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {t("admin.bookings.claimLink.savedHint")}
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500">
            {t("admin.bookings.claimLink.linkLabel")}
          </label>
          <div className="mt-1 flex gap-2">
            <input
              type="text"
              readOnly
              value={buildUrl()}
              className="input font-mono text-xs flex-1"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={() => copyToClipboard(buildUrl(), "link")}
              className="btn-secondary text-sm whitespace-nowrap"
            >
              {copied === "link"
                ? t("admin.bookings.claimLink.copied")
                : t("admin.bookings.claimLink.copyBtn")}
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500">
            {t("admin.bookings.claimLink.messageLabel")}
          </label>
          <textarea
            readOnly
            value={buildMessage()}
            rows={5}
            className="input font-mono text-xs mt-1 w-full"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={() => copyToClipboard(buildMessage(), "msg")}
            className="btn-primary text-sm w-full mt-2"
          >
            {copied === "msg"
              ? t("admin.bookings.claimLink.copied")
              : t("admin.bookings.claimLink.copyMessageBtn")}
          </button>
        </div>

        <div className="text-xs text-slate-500 border-t border-slate-100 pt-3">
          {t("admin.bookings.claimLink.howItWorks")}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────
// Full month names in both Thai and English. The Thai variant uses
// unabbreviated names (พฤษภาคม, not พ.ค.) so the section headers read
// formal — short forms can feel like a quick draft on a customer-facing
// admin tool. Buddhist year (พ.ศ.) for Thai, common-era for English.
function formatDateHeader(yyyymmdd: string, lang: "th" | "en"): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  const dow = d.getUTCDay();
  if (lang === "en") {
    const dows = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
    const months = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    return `${dows[dow]} · ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const dowsTh = ["อาทิตย์","จันทร์","อังคาร","พุธ","พฤหัสบดี","ศุกร์","เสาร์"];
  const monthsTh = [
    "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
    "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"
  ];
  return `${dowsTh[dow]} · ${d.getUTCDate()} ${monthsTh[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
}

function formatDateThaiShort(yyyymmdd: string, lang: "th" | "en"): string {
  const d = new Date(`${yyyymmdd}T00:00:00Z`);
  if (lang === "en") {
    const months = [
      "January","February","March","April","May","June",
      "July","August","September","October","November","December"
    ];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const monthsTh = [
    "มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน",
    "กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"
  ];
  return `${d.getUTCDate()} ${monthsTh[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}`;
}
