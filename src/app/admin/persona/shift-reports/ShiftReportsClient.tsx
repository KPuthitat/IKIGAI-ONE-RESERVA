"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export type TodayReportRow = {
  id: number;
  user_id: number;
  report_date: string;
  created_at: string;
  opener_name: string;
};

export type PendingUnlockRow = {
  id: number;                 // shift_unlock_requests.id
  daily_report_id: number;
  reason: string;
  created_at: string;         // request created
  report_type: "shift_open" | "shift_close" | "readiness_1130" | "readiness_1600";
  report_date: string;
  opener_id: number;
  report_created_at: string;
  requester_name: string;
  opener_name: string;
};

const REPORT_TYPE_LABELS: Record<PendingUnlockRow["report_type"], string> = {
  shift_open:     "เช็คลิสต์ก่อนเริ่มงาน",
  shift_close:    "เช็คลิสต์หลังเลิกงาน",
  readiness_1130: "รายงานความพร้อมรอบ 11:30 น.",
  readiness_1600: "รายงานความพร้อมรอบ 16:00 น."
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

export default function ShiftReportsClient({
  branchName, today, todayReport, pending
}: {
  branchName: string;
  today: string;
  todayReport: TodayReportRow | null;
  pending: PendingUnlockRow[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const [busyId, setBusyId] = useState<number | null>(null);
  // Which request id has the reject-form expanded + the note text in
  // its textarea. Reject is a 2-step: open the form, type the note,
  // then submit. Grant is a 1-step confirm dialog.
  const [rejectForm, setRejectForm] = useState<{ id: number; note: string } | null>(null);

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
      {/* Today's shift_open status */}
      <div className="card">
        <h2 className="font-bold text-slate-800 mb-2">
          {t("admin.persona.shiftReports.todayTitle")} · {today}
        </h2>
        {todayReport ? (
          <div className="text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-emerald-700 text-lg">✓</span>
              <span className="text-slate-700">
                {t("admin.persona.shiftReports.todayDone", {
                  branch: branchName,
                  opener: todayReport.opener_name,
                  time: formatBkkTime(todayReport.created_at)
                })}
              </span>
            </div>
            <div className="text-xs text-slate-400 pl-7">
              {t("admin.persona.shiftReports.reportRef", { id: String(todayReport.id) })}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="text-slate-300 text-lg">○</span>
            <span>
              {t("admin.persona.shiftReports.todayNone", { branch: branchName })}
            </span>
          </div>
        )}
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
                        opener: r.opener_name,
                        time: formatBkkTime(r.report_created_at)
                      })}
                    </div>
                  </div>

                  <div className="bg-amber-50 border border-amber-200 rounded p-2.5 space-y-1">
                    <div className="text-[10px] font-bold tracking-[1px] text-amber-700 uppercase">
                      {t("admin.persona.shiftReports.reasonLabel")} · {r.requester_name}
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
