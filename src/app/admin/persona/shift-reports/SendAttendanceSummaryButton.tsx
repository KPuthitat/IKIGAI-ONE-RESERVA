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

  return (
    <div className="card flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="text-sm font-bold text-slate-800">
            📊 {t("admin.persona.attendanceSummary.title")}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {t("admin.persona.attendanceSummary.hint")}
          </div>
        </div>
        <button
          type="button"
          onClick={send}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-lg bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50 whitespace-nowrap"
        >
          {busy
            ? t("common.submitting")
            : "📨 " + t("admin.persona.attendanceSummary.sendBtn")}
        </button>
      </div>
      {result && (
        <div
          className={`text-xs ${
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
