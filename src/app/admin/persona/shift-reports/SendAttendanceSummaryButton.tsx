"use client";

import { useState } from "react";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

// Manual "fire daily attendance summary now" button. Sits on the
// admin's shift-reports page next to the today's-status panel so
// admin doesn't have to wait for the cron — useful when:
//   • attendance_summary_time isn't configured yet for the branch
//   • cron service is down / hasn't pinged us in the right window
//   • admin made a roster change late + wants the summary re-sent
//   • testing the LINE Flex layout end-to-end
//
// Posts to /api/admin/persona/attendance-summary/send. The endpoint
// stamps attendance_summary_last_sent_date on success so the
// auto-flow won't double-send today afterwards.

export default function SendAttendanceSummaryButton() {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: "ok"; rows: number; date: string }
    | { kind: "err"; code: string; message?: string }
    | null
  >(null);

  async function send() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(
        apiUrl("/api/admin/persona/attendance-summary/send"),
        { method: "POST" }
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setResult({ kind: "ok", rows: j.rows_sent, date: j.date });
      } else {
        setResult({
          kind: "err",
          code: j?.error ?? "unknown",
          message: j?.message
        });
      }
    } catch (e) {
      setResult({
        kind: "err",
        code: "network",
        message: e instanceof Error ? e.message : "network_error"
      });
    } finally {
      setBusy(false);
    }
  }

  // Per-code human copy. Falls back to the raw message when we
  // don't have a friendlier explanation.
  function errCopy(code: string, msg?: string): string {
    const map: Record<string, string> = {
      empty_roster: t("admin.persona.attendanceSummary.errEmptyRoster"),
      monthly_quota_exceeded: t("admin.persona.shiftReports.resendFailQuota"),
      no_active_branch: t("admin.notAssignedBranch"),
      forbidden: t("admin.persona.attendanceSummary.errForbidden")
    };
    if (map[code]) return map[code];
    return msg ? `${code}: ${msg}` : code;
  }

  // Slim chip-style button — designed to slot inline next to the
  // attendance summary card's title (2026-05-25). Earlier full-card
  // version moved out; keeping the API the same so the embed point
  // changes are minimal.
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={send}
        disabled={busy}
        className="text-[10px] px-2 py-1 rounded border border-brand text-brand hover:bg-rose-50 font-bold whitespace-nowrap disabled:opacity-50"
      >
        {busy
          ? t("common.submitting")
          : t("admin.persona.shiftReports.resendBtn")}
      </button>
      {result && (
        <div
          className={`text-[10px] ${
            result.kind === "ok" ? "text-emerald-700" : "text-rose-600"
          }`}
        >
          {result.kind === "ok"
            ? "✓ " + t("admin.persona.attendanceSummary.sentOk", {
                n: result.rows,
                date: result.date
              })
            : "✗ " + errCopy(result.code, result.message)}
        </div>
      )}
    </div>
  );
}
