"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
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
  const [addModalOpen, setAddModalOpen] = useState<null | "walkin" | "phone" | "line">(null);

  // After a successful +จองผ่านไลน์ save WITHOUT a known LINE userId, we
  // pop a second modal that gives admin a claim link to paste in the LINE
  // chat. Customer taps the link → LIFF login → server captures userId →
  // Flex card auto-pushed. ref is used to build the URL.
  const [claimModalRef, setClaimModalRef] = useState<string | null>(null);

  // Per-row table picker state for the pending-review section. Keyed by
  // booking id so the admin can be reviewing several pending bookings at
  // once and each remembers its own pick.
  const [pendingTablePick, setPendingTablePick] = useState<Record<number, number | "">>({});

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

  // Promote a pending_review booking to confirmed and push the Flex card.
  // This is the core of the two-step customer flow: customer submits without
  // a table, admin picks a table here, then this fires off the confirmation.
  async function confirmAndNotify(id: number) {
    // pendingTablePick[id] is `number | "" | undefined`; falsy check covers
    // all three (empty string, undefined, and the impossible 0). After the
    // guard tableId is narrowed to a positive number ready for the API call.
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

  // Split into pending (top, prominent) and the rest (timeline). Pending
  // ones are sorted by submitted time so admin can FIFO through them.
  const pending = bookings.filter((b) => b.status === "pending_review");
  const others = bookings.filter((b) => b.status !== "pending_review");

  if (bookings.length === 0) {
    return (
      <>
        <div className="space-y-3">
          <AddBookingButtons setAddModalOpen={setAddModalOpen} t={t} />
          <div className="card text-slate-500 text-center py-10">
            {t("admin.dashboard.noBookings")}
          </div>
        </div>
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

  return (
    <>
    <div className="space-y-3">
      <AddBookingButtons setAddModalOpen={setAddModalOpen} t={t} />

      {/* Pending review section — customer-submitted bookings waiting for
          admin to pick a table and confirm. Visually distinct (amber tint)
          so they don't get lost in the timeline of confirmed bookings. */}
      {pending.length > 0 && (
        <div className="rounded-2xl border-[1.5px] border-amber-300 bg-amber-50/50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">⏳</span>
            <h2 className="font-bold text-amber-900">
              {t("admin.bookings.pending.title", { n: pending.length })}
            </h2>
          </div>
          <p className="text-xs text-amber-800/80">
            {t("admin.bookings.pending.hint")}
          </p>
          {pending.map((b) => (
            <div key={b.id} className="card border-amber-200">
              <div className="flex flex-wrap items-start gap-3">
                <div className="text-2xl font-bold w-20">{b.booking_time}</div>
                <div className="flex-1 min-w-[200px]">
                  <div className="font-medium flex items-center gap-2 flex-wrap">
                    {b.customer_name}
                    <span className="text-slate-500 font-normal">{t("admin.bookings.partySize", { n: b.party_size })}</span>
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
                    onClick={() => confirmAndNotify(b.id)}
                    disabled={busyId === b.id || !pendingTablePick[b.id]}
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
              )}
            </div>
          ))}
        </div>
      )}

      {/* Confirmed / seated / completed timeline */}
      {others.map((b) => (
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
        onSaved={(result) => {
          setAddModalOpen(null);
          // For +จองผ่านไลน์ without a userId on file → pop the claim-link
          // modal so admin can copy + paste into the LINE chat. Otherwise
          // (walkin / phone / line w/ userId) just refresh and we're done.
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

// ── Quick-add buttons (walk-in / phone / line) + scan QR shortcut ─────
// Walk-in = customer is here now; Phone = future booking from a phone call;
// Line = staff manually adding a booking that came via direct LINE chat
// (didn't go through the public form). Scan = open camera to read a
// customer's confirmation QR from the LINE Flex card.
function AddBookingButtons({
  setAddModalOpen,
  t
}: {
  setAddModalOpen: (m: "walkin" | "phone" | "line") => void;
  t: (k: string, vars?: Record<string, string | number>) => string;
}) {
  return (
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
  );
}

// ── Walk-in / Phone / Line booking modal ───────────────────────────────
// Wraps the same BookingForm component that customers use online, with a
// `mode` prop that switches submit endpoint and adjusts defaults. This
// guarantees the staff form looks and selects exactly like the customer
// form — no parallel implementation to keep in sync.
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

        {/* Reuse the customer-facing BookingForm so all flows share the
            exact same input layout, chip groups, party-size picker, time
            pickers, and validation. The mode prop adjusts defaults +
            submit endpoint. liffId=null because admin doesn't need LIFF. */}
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
//    LINE userId. Gives admin a one-tap link to paste into the LINE OA
//    chat. Customer taps → silent LIFF login → booking gets claimed →
//    Flex card auto-pushed to their LINE.
function ClaimLinkModal({ refNo, onClose }: { refNo: string; onClose: () => void }) {
  const { t } = useLang();
  const [copied, setCopied] = useState<"" | "link" | "msg">("");

  // Build absolute URL — we read window.location.origin at click time so
  // the same UI works on dev (localhost) and prod (ikigaimedihealth.com).
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
