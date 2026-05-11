"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

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
        <div className="text-5xl">📨</div>
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
      <div className="card border-l-4 border-amber-400 bg-amber-50/50">
        <div className="flex items-start gap-3">
          <div className="text-3xl">🔒</div>
          <div className="flex-1 space-y-1">
            <h2 className="font-bold text-slate-800">
              {t("staff.persona.shiftReport.locked.title", {
                branch: branchName,
                type: typeLabel
              })}
            </h2>
            <p className="text-sm text-slate-600">
              {t("staff.persona.shiftReport.locked.body", {
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
