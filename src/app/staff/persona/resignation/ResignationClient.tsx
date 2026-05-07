"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";

export type ResignationStatus = "pending" | "approved" | "rejected" | "cancelled" | "revision_requested";

export type ResignationRow = {
  id: number;
  proposed_last_day: string;
  computed_min_last_day: string;
  reason: string;
  evidence_filename: string | null;
  is_special_request: number;
  status: ResignationStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  ref_no?: string | null;
};

export default function ResignationClient({
  requests,
  todayBkk,
  minLastDay,
  hasPending,
  isUnlocked
}: {
  requests: ResignationRow[];
  todayBkk: string;
  minLastDay: string;
  hasPending: boolean;
  isUnlocked: boolean;
}) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();
  const { confirm, ConfirmDialog } = useConfirm();

  const [proposed, setProposed] = useState(minLastDay);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isSpecial, setIsSpecial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isEarlierThanMin = proposed < minLastDay;
  const submitDisabled = busy || hasPending || (isEarlierThanMin && !isSpecial);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!reason.trim()) { setErr(t("staff.persona.resignation.err.reason_required")); return; }
    if (proposed < todayBkk) { setErr(t("staff.persona.resignation.err.past_date_not_allowed")); return; }
    if (isEarlierThanMin && !isSpecial) {
      setErr(t("staff.persona.resignation.err.earlier_than_min_use_special_track"));
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("proposed_last_day", proposed);
      fd.append("reason", reason);
      if (file) fd.append("file", file);
      if (isSpecial) fd.append("is_special_request", "1");

      const res = await fetch(apiUrl("/api/persona/resignation"), { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errKey = `staff.persona.resignation.err.${data.error}`;
        const tr = t(errKey as any);
        setErr(tr === errKey ? (data.error || t("common.error")) : tr);
        return;
      }
      setReason("");
      setFile(null);
      setIsSpecial(false);
      startTransition(() => router.refresh());
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest(id: number) {
    const ok = await confirm({
      title: t("staff.persona.resignation.confirmCancelTitle"),
      body: <p>{t("staff.persona.resignation.confirmCancel")}</p>,
      confirmLabel: t("common.confirm"),
      cancelLabel: t("common.back"),
      variant: "warning"
    });
    if (ok === null) return;
    const res = await fetch(apiUrl(`/api/persona/resignation/${id}`), { method: "DELETE" });
    if (res.ok) startTransition(() => router.refresh());
    else {
      const j = await res.json().catch(() => ({}));
      window.alert(j.error || t("common.error"));
    }
  }

  return (
    <>
      {/* กฏระเบียบการลาออก */}
      <div className="card border-l-4 border-amber-400 bg-amber-50">
        <h2 className="font-semibold text-slate-800 mb-2">
          {t("staff.persona.resignation.rulesTitle")}
        </h2>
        <ul className="text-sm text-slate-700 space-y-1 list-disc list-inside">
          <li>{t("staff.persona.resignation.rule.advanceNotice")}</li>
          <li dangerouslySetInnerHTML={{
            __html: t("staff.persona.resignation.rule.example", {
              today: formatDate(todayBkk),
              minLastDay: formatDate(minLastDay)
            })
          }} />
          <li>{t("staff.persona.resignation.rule.adminGate")}</li>
          <li>{t("staff.persona.resignation.rule.specialTrack")}</li>
        </ul>
      </div>

      {/* Locked state — ยังไม่ได้รับการเปิดสิทธิ์ */}
      {!isUnlocked && !hasPending && (
        <div className="card border-2 border-slate-300 bg-slate-50 text-center py-8">
          <div className="text-5xl mb-3 opacity-50">🔒</div>
          <h3 className="font-semibold text-slate-700 mb-2">
            {t("staff.persona.resignation.lockedTitle")}
          </h3>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            {t("staff.persona.resignation.lockedBody")}
          </p>
        </div>
      )}

      {/* Pending message */}
      {hasPending && (
        <div className="card border-2 border-amber-300 bg-amber-50 text-center py-6">
          <div className="text-4xl mb-2">⏳</div>
          <h3 className="font-semibold text-slate-800">
            {t("staff.persona.resignation.alreadyPending")}
          </h3>
        </div>
      )}

      {/* Form — แสดงเมื่อ unlocked + ไม่มี pending */}
      {isUnlocked && !hasPending && (
        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-3">
            {t("staff.persona.resignation.formTitle")}
          </h2>
          <div className="bg-emerald-50 border-l-4 border-emerald-400 px-3 py-2 mb-4 text-sm text-emerald-800">
            {t("staff.persona.resignation.unlockedNote")}
          </div>
          <form onSubmit={submit} className="space-y-3">
            <div>
              <label className="label">
                {t("staff.persona.resignation.proposedLastDay")}
                <span className="text-rose-500 ml-1">*</span>
              </label>
              <input
                type="date"
                className="input"
                value={proposed}
                min={todayBkk}
                onChange={(e) => setProposed(e.target.value)}
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                {t("staff.persona.resignation.minLastDayHint", { date: formatDate(minLastDay) })}
              </p>
            </div>

            <div>
              <label className="label">
                {t("staff.persona.resignation.reason")}
                <span className="text-rose-500 ml-1">*</span>
              </label>
              <textarea
                className="input min-h-[80px]"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("staff.persona.resignation.reasonPlaceholder")}
                maxLength={500}
                required
              />
            </div>

            <div>
              <label className="label">
                {t("staff.persona.resignation.evidence")}
                <span className="text-slate-400 ml-1 text-xs">{t("staff.persona.leave.optional")}</span>
              </label>
              <input
                type="file" accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="input file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-slate-200 file:text-slate-700"
              />
              <p className="text-xs text-slate-500 mt-1">
                {t("staff.persona.resignation.evidenceHint")}
              </p>
            </div>

            {/* Special-track checkbox — แสดงเฉพาะกรณีต้องใช้ */}
            {isEarlierThanMin && (
              <div className="border-2 border-amber-400 bg-amber-50 rounded-lg p-3">
                <label className="flex items-start gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSpecial}
                    onChange={(e) => setIsSpecial(e.target.checked)}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="font-medium text-amber-900">
                      {t("staff.persona.resignation.specialTrack.title")}
                    </div>
                    <div className="text-xs text-amber-800 mt-1">
                      {t("staff.persona.resignation.specialTrack.description", {
                        proposed: formatDate(proposed),
                        minLastDay: formatDate(minLastDay)
                      })}
                    </div>
                  </div>
                </label>
              </div>
            )}

            {err && <div className="text-rose-600 text-sm">{err}</div>}

            <button className="btn-primary w-full" disabled={submitDisabled}>
              {busy ? t("common.submitting") : t("staff.persona.resignation.submit")}
            </button>
          </form>
        </div>
      )}

      {/* History */}
      {requests.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-slate-800 mb-3">
            {t("staff.persona.resignation.historyTitle")}
          </h2>
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="border-b last:border-0 border-slate-100 pb-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1">
                    {r.ref_no && (
                      <div className="text-xs text-slate-400 font-mono mb-0.5">#{r.ref_no}</div>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-800">
                        {t("staff.persona.resignation.lastDayLabel")}: {formatDate(r.proposed_last_day)}
                      </span>
                      <StatusBadge status={r.status} />
                      {r.is_special_request === 1 && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-violet-100 text-violet-700">
                          {t("staff.persona.leave.specialBadge")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 italic">"{r.reason}"</div>
                    {r.evidence_filename && (
                      <a
                        href={apiUrl(`/api/persona/resignation/${r.id}/attachment`)}
                        target="_blank" rel="noopener"
                        className="inline-block text-xs text-brand hover:underline mt-1"
                      >
                        {t("staff.persona.leave.viewEvidence")}
                      </a>
                    )}
                    {r.decision_note && (
                      <div className="text-xs text-slate-600 mt-1 bg-slate-50 px-2 py-1 rounded">
                        <span className="font-medium">{t("staff.persona.leave.adminNote")}:</span> {r.decision_note}
                      </div>
                    )}
                  </div>
                  {r.status === "pending" && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => cancelRequest(r.id)}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      {t("staff.persona.leave.cancel")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {ConfirmDialog}
    </>
  );
}

function StatusBadge({ status }: { status: ResignationStatus }) {
  const { t } = useLang();
  const cls: Record<ResignationStatus, string> = {
    pending: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    rejected: "bg-rose-100 text-rose-700",
    cancelled: "bg-slate-100 text-slate-500",
    revision_requested: "bg-orange-100 text-orange-700"
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls[status]}`}>
      {t(`leave.status.${status}` as any)}
    </span>
  );
}
