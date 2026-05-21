"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { nameWithPrefix } from "@/lib/name";

export type ReportType =
  | "shift_open"
  | "shift_close"
  | "readiness_1130"
  | "readiness_1600";

export type TodayReportRow = {
  id: number;
  type: ReportType;
  user_id: number;
  report_date: string;
  created_at: string;
  opener_name: string;
  opener_prefix: string | null;
  // chain length minus 1 — i.e. how many superseded predecessors
  // exist for the same (branch, date, type). 0 = first submission.
  revision_count: number;
};

// One link in a (branch, date, type) chain. Ordered oldest → newest in
// the chain array; the last link is always the live row. `granted_unlock`
// is attached to the link that GOT superseded (i.e. it's the unlock that
// caused this version to be replaced) — so the last link's granted_unlock
// is always null (nothing has superseded it).
export type ChainLink = {
  id: number;
  user_name: string;
  user_prefix: string | null;
  created_at: string;
  is_live: boolean;
  granted_unlock: {
    id: number;
    requester_name: string;
    requester_prefix: string | null;
    reason: string;
    decided_by_name: string | null;
    decided_by_prefix: string | null;
    decided_at: string | null;
    decision_note: string | null;
  } | null;
};

export type ChainsByType = Record<ReportType, ChainLink[]>;

export type PendingUnlockRow = {
  id: number;                 // shift_unlock_requests.id
  daily_report_id: number;
  reason: string;
  created_at: string;         // request created
  report_type: ReportType;
  report_date: string;
  opener_id: number;
  report_created_at: string;
  requester_name: string;
  requester_prefix: string | null;
  opener_name: string;
  opener_prefix: string | null;
};

// Display order — pre-shift first (chronological), then post-shift.
// Exported so the server page can keep its Record initialiser in sync.
export const REPORT_TYPE_ORDER: ReportType[] = [
  "shift_open",
  "readiness_1130",
  "readiness_1600",
  "shift_close"
];

const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  shift_open:     "Check list ก่อนเริ่มงาน",
  shift_close:    "Check list หลังเลิกงาน",
  readiness_1130: "รายงานความพร้อมรอบเช้า",
  readiness_1600: "รายงานความพร้อมรอบบ่าย"
};

// Format an ISO timestamp to Bangkok HH:MM. Used on the request card
// so admin sees when the staff filed it without parsing UTC.
function formatBkkTime(iso: string): string {
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mm = String(bkk.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// Inline revision-chain renderer. Receives the full chain (oldest →
// newest, last = live) and renders one card per version. Between
// versions, when the predecessor has an attached granted unlock
// request, an arrow + reason block is shown — that's the audit
// breadcrumb explaining WHY a revision happened.
//
// Visual: indented under the "today's status" row, with a left
// border in amber to echo the chip colour. Compact — admin scans for
// "who edited, why, and when admin approved", not for prose.
function ChainView({ chain }: { chain: ChainLink[] }) {
  const { t } = useLang();
  // Helper: human label for a chain position. The live (tail) link is
  // always "ฉบับปัจจุบัน"; position 0 is "ฉบับแรก"; everything else
  // is "ฉบับแก้ไข ครั้งที่ N" where N = 1-indexed position. Keeps the
  // labels deterministic regardless of chain length.
  function versionLabel(idx: number, link: ChainLink): string {
    if (link.is_live) return t("admin.persona.shiftReports.chain.current");
    if (idx === 0) return t("admin.persona.shiftReports.chain.first");
    return t("admin.persona.shiftReports.chain.revisionN", { n: String(idx) });
  }
  return (
    <div className="ml-7 pl-3 border-l-2 border-amber-200 space-y-2">
      <div className="text-[10px] font-bold tracking-[1px] text-amber-700 uppercase">
        {t("admin.persona.shiftReports.chain.heading")}
      </div>
      {chain.map((link, idx) => (
        <div key={link.id} className="space-y-2">
          <div
            className={`rounded border p-2 ${
              link.is_live
                ? "border-emerald-200 bg-emerald-50/50"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs font-bold text-slate-800">
                {versionLabel(idx, link)}
              </div>
              <div className="text-[11px] text-slate-500">
                {nameWithPrefix(link.user_prefix, link.user_name)} · {formatBkkTime(link.created_at)}
              </div>
            </div>
          </div>
          {/* Arrow + granted-unlock breadcrumb between this link and
              the next one — only rendered when the current link was
              superseded (granted_unlock attached). */}
          {link.granted_unlock && (
            <div className="ml-2 pl-3 border-l border-amber-300 space-y-1 py-1">
              <div className="text-[10px] text-amber-700 font-bold">
                ↓ {t("admin.persona.shiftReports.chain.requestArrow")}
              </div>
              <div className="text-[11px] text-slate-700">
                <span className="font-bold">
                  {t("admin.persona.shiftReports.chain.requesterLabel")}:
                </span>{" "}
                {nameWithPrefix(link.granted_unlock.requester_prefix, link.granted_unlock.requester_name)}
              </div>
              <div className="text-[11px] text-slate-700 whitespace-pre-wrap pl-2 border-l-2 border-slate-200 italic">
                "{link.granted_unlock.reason}"
              </div>
              {link.granted_unlock.decided_by_name && link.granted_unlock.decided_at && (
                <div className="text-[10px] text-slate-500">
                  {t("admin.persona.shiftReports.chain.approvedBy", {
                    admin: nameWithPrefix(link.granted_unlock.decided_by_prefix, link.granted_unlock.decided_by_name),
                    time: formatBkkTime(link.granted_unlock.decided_at)
                  })}
                </div>
              )}
              {link.granted_unlock.decision_note && (
                <div className="text-[10px] text-slate-500 italic">
                  {t("admin.persona.shiftReports.chain.adminNote")}: "
                  {link.granted_unlock.decision_note}"
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ShiftReportsClient({
  branchName, today, todayReports, chains, pending
}: {
  branchName: string;
  today: string;
  // One slot per report type — null = not submitted yet today.
  // Renders 4 rows in REPORT_TYPE_ORDER so admin always sees the
  // full daily schedule, not just the types that happened to be done.
  todayReports: Record<ReportType, TodayReportRow | null>;
  // Revision chains per type — oldest → newest, last = live. Expanded
  // inline when admin clicks the "แก้ไข N×" chip. Empty array = no
  // chain to show (or no submission yet today).
  chains: ChainsByType;
  pending: PendingUnlockRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  // Which request id has the reject-form expanded + the note text in
  // its textarea. Reject is a 2-step: open the form, type the note,
  // then submit. Grant is a 1-step confirm dialog.
  const [rejectForm, setRejectForm] = useState<{ id: number; note: string } | null>(null);
  // Manual LINE resend state per report id. Keys are the daily_reports
  // row id; value is the in-flight / result state. Cleared after a
  // few seconds so the row goes back to its neutral look.
  const [resendBusyId, setResendBusyId] = useState<number | null>(null);
  const [resendMsg, setResendMsg] = useState<{
    reportId: number; kind: "ok" | "err"; text: string
  } | null>(null);

  async function resendNotification(reportId: number) {
    setResendBusyId(reportId);
    setResendMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/persona/daily-report/${reportId}/resend-notification`),
        { method: "POST" }
      );
      const body = await res.json().catch(() => ({}));
      if (res.ok && body?.ok) {
        setResendMsg({
          reportId,
          kind: "ok",
          text: t("admin.persona.shiftReports.resendOk")
        });
      } else {
        // Show the actual error from the server so admin knows whether
        // the issue is token / group / LINE API itself. Falls back to
        // the generic message when the API returned nothing useful.
        const detail = body?.message || body?.error
          ? `${body?.error ?? "error"}${body?.message ? ` — ${body.message}` : ""}`
          : "";
        setResendMsg({
          reportId,
          kind: "err",
          text: detail
            ? `${t("admin.persona.shiftReports.resendFail")} · ${detail}`
            : t("admin.persona.shiftReports.resendFail")
        });
      }
    } catch (e) {
      setResendMsg({
        reportId,
        kind: "err",
        text: `${t("admin.persona.shiftReports.resendFail")} · ${
          e instanceof Error ? e.message : "network"
        }`
      });
    } finally {
      setResendBusyId(null);
    }
  }
  // Set of report types whose revision chain is currently expanded.
  // Multiple can be open at once — admin might want to compare two
  // types' history side-by-side.
  const [expandedChains, setExpandedChains] = useState<Set<ReportType>>(new Set());
  function toggleChain(type: ReportType) {
    setExpandedChains((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function grant(requestId: number) {
    if (!confirm(t("admin.persona.shiftReports.confirmGrant"))) return;
    setBusyId(requestId);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/shift-unlock-request/${requestId}/decide`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision: "granted" })
        }
      );
      if (!res.ok) throw new Error("grant failed");
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject() {
    if (!rejectForm) return;
    setBusyId(rejectForm.id);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/shift-unlock-request/${rejectForm.id}/decide`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: "rejected",
            decision_note: rejectForm.note.trim() || undefined
          })
        }
      );
      if (!res.ok) throw new Error("reject failed");
      setRejectForm(null);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Today's report status — one row per type (4 total). Each row
          is ✓ when a LIVE daily_reports exists, ○ otherwise. The amber
          "แก้ไข N×" chip is a button when revision_count ≥ 1; clicking
          expands the full chain (original → ... → current) inline
          below the row, with each granted edit request annotated. */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-3">
          {t("admin.persona.shiftReports.todayTitle")} · {branchName} · {today}
        </h2>
        <ul className="space-y-2">
          {REPORT_TYPE_ORDER.map((type) => {
            const r = todayReports[type];
            const label = REPORT_TYPE_LABELS[type];
            const chain = chains[type];
            const isExpanded = expandedChains.has(type);
            const hasChain = r != null && r.revision_count > 0 && chain.length > 1;
            return (
              <li key={type} className="flex flex-col gap-2">
                <div className="flex items-start gap-2 text-sm">
                  {r ? (
                    <>
                      <span className="text-emerald-700 text-lg leading-none mt-0.5 select-none">
                        ✓
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-800">{label}</div>
                        <div className="text-xs text-slate-500">
                          {nameWithPrefix(r.opener_prefix, r.opener_name)} · {formatBkkTime(r.created_at)}
                        </div>
                      </div>
                      {hasChain && (
                        <button
                          type="button"
                          onClick={() => toggleChain(type)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 font-bold whitespace-nowrap inline-flex items-center gap-1 cursor-pointer transition-colors"
                          title={t("admin.persona.shiftReports.row.revisionTitle")}
                          aria-expanded={isExpanded}
                        >
                          {t("admin.persona.shiftReports.row.revisionChip", {
                            n: String(r.revision_count)
                          })}
                          <span className="text-[9px] leading-none">
                            {isExpanded ? "▴" : "▾"}
                          </span>
                        </button>
                      )}
                      {/* Manual LINE resend — same endpoint that the
                          staff lock screen uses. Admins reach for this
                          when the auto-push didn't land in the group
                          (token misconfig, group not joined yet, LINE
                          transient outage). Awaits the API so the
                          status under the row reflects the real push
                          outcome. */}
                      <button
                        type="button"
                        disabled={resendBusyId === r.id}
                        onClick={() => resendNotification(r.id)}
                        className="text-[10px] px-1.5 py-0.5 rounded border border-brand text-brand hover:bg-rose-50 font-bold whitespace-nowrap disabled:opacity-50"
                        title={t("admin.persona.shiftReports.resendHint")}
                      >
                        📨 {resendBusyId === r.id
                          ? t("common.submitting")
                          : t("admin.persona.shiftReports.resendBtn")}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-slate-300 text-lg leading-none mt-0.5 select-none">
                        ○
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-slate-500">{label}</div>
                        <div className="text-xs text-slate-400">
                          {t("admin.persona.shiftReports.row.notDone")}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {hasChain && isExpanded && (
                  <ChainView chain={chain} />
                )}
                {r && resendMsg && resendMsg.reportId === r.id && (
                  <div
                    className={`text-xs pl-7 ${
                      resendMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
                    }`}
                  >
                    {resendMsg.kind === "ok" ? "✓ " : "✗ "}{resendMsg.text}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Pending unlock requests */}
      <div>
        <h2 className="font-bold text-slate-800 mb-2 flex items-center gap-2">
          {t("admin.persona.shiftReports.pendingTitle")}
          {pending.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-brand text-white font-bold">
              {pending.length}
            </span>
          )}
        </h2>
        {pending.length === 0 ? (
          <div className="card text-sm text-slate-400 text-center py-6">
            {t("admin.persona.shiftReports.pendingEmpty")}
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((r) => {
              const isBusy = busyId === r.id;
              return (
                <div key={r.id} className="card border-l-4 border-amber-400 space-y-3">
                  <div>
                    <div className="text-xs text-slate-400 tracking-[0.5px] uppercase">
                      {t("admin.persona.shiftReports.requestLabel")}
                    </div>
                    <div className="text-sm text-slate-800 font-bold mt-0.5">
                      {REPORT_TYPE_LABELS[r.report_type]}
                    </div>
                    <div className="text-xs text-slate-600 mt-0.5">
                      {t("admin.persona.shiftReports.requestSummary", {
                        date: r.report_date,
                        opener: nameWithPrefix(r.opener_prefix, r.opener_name),
                        time: formatBkkTime(r.report_created_at)
                      })}
                    </div>
                  </div>

                  <div className="bg-amber-50 border border-amber-200 rounded p-2.5 space-y-1">
                    <div className="text-[10px] font-bold tracking-[1px] text-amber-700 uppercase">
                      {t("admin.persona.shiftReports.reasonLabel")} · {nameWithPrefix(r.requester_prefix, r.requester_name)}
                    </div>
                    <div className="text-sm text-slate-800 whitespace-pre-wrap">
                      {r.reason}
                    </div>
                    <div className="text-[10px] text-slate-400 pt-1">
                      {t("admin.persona.shiftReports.requestedAt", {
                        time: formatBkkTime(r.created_at)
                      })}
                    </div>
                  </div>

                  {rejectForm?.id === r.id ? (
                    <div className="space-y-2 bg-rose-50/50 border border-rose-200 rounded-lg p-3">
                      <div className="text-sm font-bold text-slate-800">
                        {t("admin.persona.shiftReports.rejectFormTitle")}
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 block mb-1">
                          {t("admin.persona.shiftReports.rejectNoteLabel")}
                        </label>
                        <textarea
                          className="input text-sm"
                          rows={2}
                          maxLength={500}
                          placeholder={t("admin.persona.shiftReports.rejectNotePlaceholder")}
                          value={rejectForm.note}
                          onChange={(e) => setRejectForm({ ...rejectForm, note: e.target.value })}
                        />
                        <p className="text-[10px] text-slate-400 mt-1">
                          {t("admin.persona.shiftReports.rejectNoteHint")}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setRejectForm(null)}
                          disabled={isBusy}
                          className="btn-secondary flex-1 text-sm"
                        >
                          {t("common.cancel")}
                        </button>
                        <button
                          type="button"
                          onClick={submitReject}
                          disabled={isBusy}
                          className="btn-danger flex-1 text-sm"
                        >
                          {isBusy
                            ? t("common.submitting")
                            : t("admin.persona.shiftReports.rejectSendBtn")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setRejectForm({ id: r.id, note: "" })}
                        disabled={isBusy}
                        className="btn-secondary flex-1 text-sm"
                      >
                        {t("admin.persona.shiftReports.reject")}
                      </button>
                      <button
                        type="button"
                        onClick={() => grant(r.id)}
                        disabled={isBusy}
                        className="btn-primary flex-1 text-sm"
                      >
                        {isBusy
                          ? t("common.submitting")
                          : t("admin.persona.shiftReports.grant")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
