"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import ReportDetailView, { type ReportDetail } from "@/app/components/ReportDetailView";

// Locked-state card shown when today's report (any of the 4 types)
// has already been submitted at this branch. Includes an inline
// "ขอแก้ไข" form that posts to the unlock-request endpoint — admin
// gets a Flex card in the staff group asking to approve. Admin
// approves/rejects via /admin/persona/shift-reports.
//
// `typeLabel` is the human-readable Thai name of the report type
// ("เช็คลิสต์ก่อนเริ่มงาน" etc.), interpolated into the title/body
// so this one component handles all 4 report types.

function formatBkkTime(iso: string): string {
  // The created_at column stores ISO timestamps in UTC. Convert to
  // Bangkok time for the user-facing "ส่งเมื่อ" line.
  const d = new Date(iso);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const hh = String(bkk.getUTCHours()).padStart(2, "0");
  const mm = String(bkk.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export default function ShiftReportLocked({
  branchName, typeLabel, reportId, openerName, openedAtIso,
  alreadyRequested, lastRejected
}: {
  branchName: string;
  /** Human-readable Thai report-type label, e.g. "เช็คลิสต์ก่อนเริ่มงาน".
   *  Interpolated into the locked-state copy so this component renders
   *  correctly for shift_open / shift_close / readiness_*. */
  typeLabel: string;
  reportId: number;
  openerName: string;
  openedAtIso: string;
  alreadyRequested: boolean;
  /** Set when staff's most recent unlock request was rejected. We
   *  surface admin's decision_note (if any) inline so staff knows
   *  what to do — accept the lock, or file another request with a
   *  better-framed reason. */
  lastRejected: { decisionNote: string | null } | null;
}) {
  const router = useRouter();
  const { t } = useLang();

  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(alreadyRequested);
  const [err, setErr] = useState<string | null>(null);
  // Manual LINE-resend state. Lets staff retrigger the notification
  // when the auto-push didn't reach the group (token misconfigured,
  // group not joined yet, transient LINE outage). Result toast hangs
  // around for a few seconds so staff sees it without scrolling.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Inline "ดูรายละเอียด" state — lets staff re-check the values
  // they just submitted before deciding whether to request an
  // unlock. Cached on first open since daily_reports rows are
  // immutable post-submit.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function toggleDetail() {
    const next = !detailOpen;
    setDetailOpen(next);
    if (!next || detail || detailLoading) return;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(apiUrl(`/api/persona/daily-report/${reportId}`));
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setDetailError(j?.error ?? "fetch_failed");
        return;
      }
      setDetail(j.report as ReportDetail);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "network_error");
    } finally {
      setDetailLoading(false);
    }
  }

  async function resendNotification() {
    setResendBusy(true);
    setResendMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/persona/daily-report/${reportId}/resend-notification`),
        { method: "POST" }
      );
      if (res.ok) {
        setResendMsg({
          kind: "ok",
          text: t("staff.persona.shiftReport.locked.resendOk")
        });
      } else {
        setResendMsg({
          kind: "err",
          text: t("staff.persona.shiftReport.locked.resendFail")
        });
      }
    } catch {
      setResendMsg({
        kind: "err",
        text: t("staff.persona.shiftReport.locked.resendFail")
      });
    } finally {
      setResendBusy(false);
    }
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (reason.trim().length < 3) {
      setErr(t("staff.persona.shiftReport.locked.reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/shift-unlock-request"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ daily_report_id: reportId, reason: reason.trim() })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        if (j.error === "already_requested") {
          setDone(true);
          return;
        }
        setErr(t("common.error"));
        return;
      }
      setDone(true);
      router.refresh();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card text-center space-y-3">
        <h2 className="text-xl font-bold text-slate-800">
          {t("staff.persona.shiftReport.locked.requestSent.title")}
        </h2>
        <p className="text-sm text-slate-600">
          {t("staff.persona.shiftReport.locked.requestSent.body")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card border-l-4 border-emerald-400 bg-emerald-50/50">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shiftReport.locked.title")}
            </h2>
            <p className="text-sm text-slate-600">
              {t("staff.persona.shiftReport.locked.body", {
                branch: branchName,
                type: typeLabel,
                opener: openerName,
                time: formatBkkTime(openedAtIso)
              })}
            </p>
            <p className="text-xs text-slate-500 pt-1">
              {t("staff.persona.shiftReport.locked.hint", { type: typeLabel })}
            </p>
          </div>
        </div>
      </div>

      {/* Manual LINE resend — visible to anyone viewing the lock
          screen. The auto-flow is fire-and-forget so an admin can't
          tell from the UI whether the LINE push succeeded; this
          button gives a deterministic retry path. Awaits the API so
          the success/fail toast reflects the actual push outcome. */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="text-sm font-bold text-slate-700">
            {t("staff.persona.shiftReport.locked.resendBtn")}
          </div>
          <div className="text-[11px] text-slate-500">
            {t("staff.persona.shiftReport.locked.resendHint")}
          </div>
        </div>
        <button
          type="button"
          disabled={resendBusy}
          onClick={resendNotification}
          className="text-sm px-3 py-1.5 rounded-lg border border-brand text-brand font-bold hover:bg-rose-50 disabled:opacity-50"
        >
          {resendBusy ? t("common.submitting") : t("staff.persona.shiftReport.locked.resendBtn")}
        </button>
      </div>
      {resendMsg && (
        <div
          className={`text-sm text-center ${
            resendMsg.kind === "ok" ? "text-emerald-700" : "text-rose-600"
          }`}
        >
          {resendMsg.kind === "ok" ? "✓ " : "✗ "}{resendMsg.text}
        </div>
      )}

      {/* "ดูรายละเอียด" — staff re-checks what they submitted
          before deciding whether to file an unlock request. Lazy-
          fetches the report on first open. */}
      <div className="card flex items-center justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="text-sm font-bold text-slate-700">
            {t("staff.persona.shiftReport.locked.viewDetail")}
          </div>
          <div className="text-[11px] text-slate-500">
            {t("staff.persona.shiftReport.locked.viewDetailHint")}
          </div>
        </div>
        <button
          type="button"
          onClick={toggleDetail}
          className="text-sm px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 font-bold hover:bg-slate-50"
          aria-expanded={detailOpen}
        >
          {t("staff.persona.shiftReport.locked.viewDetail")}
          <span className="ml-1 text-[10px] leading-none">
            {detailOpen ? "▴" : "▾"}
          </span>
        </button>
      </div>
      {detailOpen && (
        <ReportDetailView
          reportId={reportId}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          t={t}
        />
      )}

      {/* Last-rejected banner — only when staff's most recent request
          was rejected. Shows admin's note so staff knows whether to
          accept the lock or file another request with better framing. */}
      {lastRejected && (
        <div className="card border-l-4 border-rose-400 bg-rose-50/50 space-y-1">
          <h3 className="font-bold text-slate-800 text-sm flex items-center gap-2">
            <span>✗</span>
            {t("staff.persona.shiftReport.locked.lastRejected.title")}
          </h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">
            {lastRejected.decisionNote
              ? t("staff.persona.shiftReport.locked.lastRejected.body", {
                  note: lastRejected.decisionNote
                })
              : t("staff.persona.shiftReport.locked.lastRejected.noNote")}
          </p>
        </div>
      )}

      {!reasonOpen ? (
        <button
          type="button"
          onClick={() => setReasonOpen(true)}
          className="btn-secondary w-full"
        >
          {lastRejected
            ? t("staff.persona.shiftReport.locked.requestAgain")
            : t("staff.persona.shiftReport.locked.requestBtn")}
        </button>
      ) : (
        <form onSubmit={submitRequest} className="card space-y-3">
          <h3 className="font-bold text-slate-800">
            {t("staff.persona.shiftReport.locked.formTitle")}
          </h3>
          <div>
            <label className="label">
              {t("staff.persona.shiftReport.locked.reasonLabel")} *
            </label>
            <textarea
              className="input text-sm"
              rows={3}
              maxLength={500}
              placeholder={t("staff.persona.shiftReport.locked.reasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-[10px] text-slate-400 mt-1">
              {t("staff.persona.shiftReport.locked.reasonHint")}
            </p>
          </div>
          {err && (
            <div className="text-sm text-rose-600 text-center">{err}</div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => { setReasonOpen(false); setReason(""); setErr(null); }}
              className="btn-secondary flex-1"
            >
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="btn-primary flex-1"
            >
              {busy
                ? t("common.submitting")
                : t("staff.persona.shiftReport.locked.sendBtn")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
