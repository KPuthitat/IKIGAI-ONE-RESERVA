"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export type LeaveType =
  | "sick" | "personal" | "annual" | "maternity"
  | "ordination" | "sterilization" | "pilgrimage" | "military";

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export type LeaveRow = {
  id: number;
  type: LeaveType;
  date_from: string;
  date_to: string;
  days: number;
  reason: string | null;
  status: LeaveStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

const LEAVE_TYPES: LeaveType[] = [
  "sick", "personal", "annual", "maternity",
  "ordination", "sterilization", "pilgrimage", "military"
];

function todayBkkStr(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00Z`).getTime();
  const t = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((t - f) / 86400000) + 1);
}

export default function LeaveClient({ requests }: { requests: LeaveRow[] }) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();

  // form state
  const tomorrow = new Date(Date.now() + 86400_000 + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const [type, setType] = useState<LeaveType>("sick");
  const [from, setFrom] = useState(tomorrow);
  const [to, setTo] = useState(tomorrow);
  const [halfDay, setHalfDay] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const computedDays = halfDay && from === to ? 0.5 : daysBetween(from, to);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOkMsg(null);
    if (from > to) {
      setErr(t("staff.persona.leave.err.dateRange"));
      return;
    }
    if (from < todayBkkStr()) {
      setErr(t("staff.persona.leave.err.pastDate"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/persona/leave"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type, date_from: from, date_to: to, days: computedDays, reason: reason || undefined
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || t("common.error"));
        return;
      }
      setOkMsg(t("staff.persona.leave.submitOk"));
      setReason("");
      startTransition(() => router.refresh());
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest(id: number) {
    if (!confirm(t("staff.persona.leave.confirmCancel"))) return;
    const res = await fetch(apiUrl(`/api/persona/leave/${id}`), { method: "DELETE" });
    if (res.ok) {
      startTransition(() => router.refresh());
    } else {
      const j = await res.json().catch(() => ({}));
      alert(j.error || t("common.error"));
    }
  }

  return (
    <>
      {/* Submit form */}
      <form onSubmit={submit} className="card space-y-3">
        <h2 className="font-semibold text-slate-800">
          {t("staff.persona.leave.formTitle")}
        </h2>

        <div>
          <label className="label">{t("staff.persona.leave.type")}</label>
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as LeaveType)}
          >
            {LEAVE_TYPES.map((tp) => (
              <option key={tp} value={tp}>
                {t(`leave.type.${tp}` as any)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("staff.persona.leave.from")}</label>
            <input
              type="date" className="input" value={from} min={todayBkkStr()}
              onChange={(e) => {
                setFrom(e.target.value);
                if (e.target.value > to) setTo(e.target.value);
              }}
              required
            />
          </div>
          <div>
            <label className="label">{t("staff.persona.leave.to")}</label>
            <input
              type="date" className="input" value={to} min={from}
              onChange={(e) => setTo(e.target.value)} required
            />
          </div>
        </div>

        {from === to && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox" checked={halfDay}
              onChange={(e) => setHalfDay(e.target.checked)}
            />
            {t("staff.persona.leave.halfDay")}
          </label>
        )}

        <div className="text-sm text-slate-500">
          {t("staff.persona.leave.totalDays", { n: computedDays })}
        </div>

        <div>
          <label className="label">{t("staff.persona.leave.reason")}</label>
          <textarea
            className="input min-h-[80px]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("staff.persona.leave.reasonPlaceholder")}
            maxLength={500}
          />
        </div>

        {err && <div className="text-rose-600 text-sm">{err}</div>}
        {okMsg && <div className="text-emerald-600 text-sm">{okMsg}</div>}

        <button className="btn-primary w-full" disabled={busy}>
          {busy ? t("common.submitting") : t("staff.persona.leave.submit")}
        </button>
      </form>

      {/* My requests */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("staff.persona.leave.historyTitle")}
        </h2>
        {requests.length === 0 ? (
          <p className="text-slate-500 text-sm py-4 text-center">
            {t("staff.persona.leave.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="border-b last:border-0 border-slate-100 pb-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-800">
                        {t(`leave.type.${r.type}` as any)}
                      </span>
                      <StatusBadge status={r.status} />
                    </div>
                    <div className="text-sm text-slate-600 mt-0.5">
                      {r.date_from === r.date_to
                        ? formatDate(r.date_from)
                        : `${formatDate(r.date_from)} → ${formatDate(r.date_to)}`}
                      <span className="ml-2 text-slate-400">
                        ({t("staff.persona.leave.daysShort", { n: r.days })})
                      </span>
                    </div>
                    {r.reason && (
                      <div className="text-xs text-slate-500 mt-1 italic">"{r.reason}"</div>
                    )}
                    {r.decision_note && (
                      <div className="text-xs text-slate-600 mt-1 bg-slate-50 px-2 py-1 rounded">
                        <span className="font-medium">
                          {t("staff.persona.leave.adminNote")}:
                        </span> {r.decision_note}
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
        )}
      </div>
    </>
  );
}

function StatusBadge({ status }: { status: LeaveStatus }) {
  const { t } = useLang();
  const cls: Record<LeaveStatus, string> = {
    pending: "bg-amber-100 text-amber-700",
    approved: "bg-emerald-100 text-emerald-700",
    rejected: "bg-rose-100 text-rose-700",
    cancelled: "bg-slate-100 text-slate-500"
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${cls[status]}`}>
      {t(`leave.status.${status}` as any)}
    </span>
  );
}
