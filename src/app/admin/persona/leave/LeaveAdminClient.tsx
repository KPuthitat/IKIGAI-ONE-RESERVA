"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { ALL_LEAVE_TYPES, type LeaveType } from "@/lib/leave";
import type { LeaveStatus } from "@/app/staff/persona/leave/LeaveClient";

export type StaffOption = {
  id: number;
  username: string;
  display_name: string;
  role: string;
};

export type LeaveAdminRow = {
  id: number;
  user_id: number;
  type: LeaveType;
  date_from: string;
  date_to: string;
  days: number;
  hours: number | null;
  reason: string | null;
  evidence_filename: string | null;
  status: LeaveStatus;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  created_by: number | null;
  created_at: string;
  username: string;
  display_name: string;
  decided_by_name: string | null;
  created_by_name: string | null;
  // stretch info (เฉพาะ personal/annual)
  stretchTotal: number | null;
  stretchHolidayCount: number | null;
  advanceDays: number | null;
};

type StatusFilter = "pending" | "approved" | "rejected" | "cancelled" | "all";
const FILTERS: StatusFilter[] = ["pending", "approved", "rejected", "cancelled", "all"];

export default function LeaveAdminClient({
  currentStatus,
  countMap,
  requests,
  staffList
}: {
  currentStatus: StatusFilter;
  countMap: Record<string, number>;
  requests: LeaveAdminRow[];
  staffList: StaffOption[];
}) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  function decide(id: number, decision: "approved" | "rejected") {
    const promptMsg = decision === "approved"
      ? t("admin.persona.leave.notePromptApprove")
      : t("admin.persona.leave.notePromptReject");
    const note = prompt(promptMsg);
    if (note === null) return;
    setBusyId(id);
    fetch(apiUrl(`/api/admin/persona/leave/${id}/decide`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, note: note || undefined })
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) startTransition(() => router.refresh());
        else alert(j?.error ?? t("common.error"));
      })
      .catch(() => alert(t("common.error")))
      .finally(() => setBusyId(null));
  }

  return (
    <>
      {/* Filter pills + Create button */}
      <div className="card flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = currentStatus === f;
          const n = f === "all"
            ? Object.values(countMap).reduce((a, b) => a + b, 0)
            : (countMap[f] ?? 0);
          return (
            <Link
              key={f}
              href={`/admin/persona/leave?status=${f}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                active
                  ? "bg-brand text-white border-brand"
                  : "bg-white text-slate-700 border-slate-200 hover:border-brand"
              }`}
            >
              {t(`admin.persona.leave.filter.${f}` as any)}
              <span className={`ml-1.5 text-xs ${active ? "text-white/80" : "text-slate-400"}`}>
                {n}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setCreateOpen((o) => !o)}
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium bg-brand text-white hover:opacity-90"
        >
          {createOpen ? t("common.cancel") : `+ ${t("admin.persona.leave.createForStaff")}`}
        </button>
      </div>

      {/* Create-on-behalf form (collapsible) */}
      {createOpen && (
        <CreateForm staffList={staffList} onDone={() => {
          setCreateOpen(false);
          startTransition(() => router.refresh());
        }} />
      )}

      {/* Requests list */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("admin.persona.leave.listTitle")} ({requests.length})
        </h2>
        {requests.length === 0 ? (
          <p className="text-slate-500 text-sm py-6 text-center">
            {t("admin.persona.leave.empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => (
              <li key={r.id} className="border border-slate-200 rounded-lg p-3 hover:bg-slate-50 transition">
                <div className="flex flex-wrap justify-between items-start gap-2 mb-1">
                  <div className="flex-1 min-w-[200px]">
                    <div className="font-medium text-slate-800">
                      {r.display_name}
                      <span className="text-xs text-slate-400 ml-1.5">@{r.username}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="font-medium text-slate-700">
                        {t(`leave.type.${r.type}` as any)}
                      </span>
                      <StatusBadge status={r.status} />
                      <span className="text-xs text-slate-400">
                        {r.hours
                          ? t("admin.persona.leave.hoursShort", { h: r.hours })
                          : t("admin.persona.leave.daysShort", { n: r.days })}
                      </span>
                      {r.stretchTotal != null && r.stretchHolidayCount != null && r.stretchHolidayCount > 0 && (
                        <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                          r.stretchTotal > 5
                            ? "bg-rose-100 text-rose-700"
                            : r.stretchTotal > 3
                              ? "bg-amber-100 text-amber-700"
                              : "bg-emerald-50 text-emerald-700"
                        }`}>
                          {t("admin.persona.leave.stretchBadge", { n: r.stretchTotal })}
                        </span>
                      )}
                      {r.advanceDays != null && r.advanceDays < 7 && r.advanceDays >= 0 && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-100 text-amber-700">
                          {t("admin.persona.leave.shortNotice", { n: r.advanceDays })}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-slate-600 mt-1">
                      {r.date_from === r.date_to
                        ? formatDate(r.date_from)
                        : `${formatDate(r.date_from)} → ${formatDate(r.date_to)}`}
                    </div>
                    {r.reason && (
                      <div className="text-xs text-slate-500 mt-1.5 italic">"{r.reason}"</div>
                    )}
                    {r.evidence_filename && (
                      <a
                        href={apiUrl(`/api/persona/leave/${r.id}/attachment`)}
                        target="_blank" rel="noopener"
                        className="inline-block text-xs text-brand hover:underline mt-1.5"
                      >
                        {t("admin.persona.leave.viewEvidence")}
                      </a>
                    )}
                    {r.created_by && r.created_by !== r.user_id && r.created_by_name && (
                      <div className="text-xs text-slate-500 mt-1">
                        {t("admin.persona.leave.recordedBy", { name: r.created_by_name })}
                      </div>
                    )}
                    {r.decision_note && r.decided_by_name && (
                      <div className="text-xs text-slate-600 mt-1.5 bg-slate-100 px-2 py-1 rounded">
                        <span className="font-medium">{r.decided_by_name}:</span> {r.decision_note}
                      </div>
                    )}
                  </div>
                  {r.status === "pending" && (
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        disabled={pending || busyId === r.id}
                        onClick={() => decide(r.id, "approved")}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-emerald-500 hover:bg-emerald-600 text-white disabled:opacity-50"
                      >
                        {t("admin.persona.leave.approve")}
                      </button>
                      <button
                        type="button"
                        disabled={pending || busyId === r.id}
                        onClick={() => decide(r.id, "rejected")}
                        className="px-3 py-1.5 rounded text-xs font-medium bg-rose-500 hover:bg-rose-600 text-white disabled:opacity-50"
                      >
                        {t("admin.persona.leave.reject")}
                      </button>
                    </div>
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

function CreateForm({ staffList, onDone }: { staffList: StaffOption[]; onDone: () => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const today = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [userId, setUserId] = useState<number | "">(staffList[0]?.id ?? "");
  const [type, setType] = useState<LeaveType>("sick");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [usePartial, setUsePartial] = useState(false);
  const [hours, setHours] = useState(3);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const fullDays = Math.max(1, Math.floor(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000
  ) + 1);
  const computedDays = usePartial && from === to ? +(hours / 8).toFixed(2) : fullDays;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!userId) { setErr(t("admin.persona.leave.err.selectUser")); return; }
    if (from > to) { setErr(t("staff.persona.leave.err.dateRange")); return; }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("user_id", String(userId));
      fd.append("type", type);
      fd.append("date_from", from);
      fd.append("date_to", to);
      fd.append("days", String(computedDays));
      if (usePartial && from === to) fd.append("hours", String(hours));
      fd.append("reason", reason);
      fd.append("note", note);
      if (file) fd.append("file", file);

      const res = await fetch(apiUrl("/api/admin/persona/leave/create"), { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || t("common.error"));
        return;
      }
      onDone();
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card space-y-3">
      <h2 className="font-semibold text-slate-800">
        {t("admin.persona.leave.createForStaff")}
      </h2>
      <p className="text-sm text-slate-500">
        {t("admin.persona.leave.createSubtitle")}
      </p>

      <div>
        <label className="label">{t("admin.persona.leave.staff")}</label>
        <select className="input" value={userId} onChange={(e) => setUserId(Number(e.target.value))}>
          {staffList.map((u) => (
            <option key={u.id} value={u.id}>{u.display_name} (@{u.username})</option>
          ))}
        </select>
      </div>

      <div>
        <label className="label">{t("staff.persona.leave.type")}</label>
        <select className="input" value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
          {ALL_LEAVE_TYPES.map((tp) => (
            <option key={tp} value={tp}>{t(`leave.type.${tp}` as any)}</option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("staff.persona.leave.from")}</label>
          <input type="date" className="input" value={from}
            onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }}
            required />
        </div>
        <div>
          <label className="label">{t("staff.persona.leave.to")}</label>
          <input type="date" className="input" value={to} min={from}
            onChange={(e) => setTo(e.target.value)} required />
        </div>
      </div>

      {from === to && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={usePartial} onChange={(e) => setUsePartial(e.target.checked)} />
            {t("staff.persona.leave.partialDay")}
          </label>
          {usePartial && (
            <div>
              <label className="label">{t("staff.persona.leave.hoursLabel")}</label>
              <input type="number" min={1} max={8} step={0.5} className="input" value={hours}
                onChange={(e) => setHours(Number(e.target.value))} />
            </div>
          )}
        </div>
      )}

      <div className="text-sm text-slate-500">
        {usePartial && from === to
          ? t("staff.persona.leave.totalHours", { h: hours })
          : t("staff.persona.leave.totalDays", { n: computedDays })}
      </div>

      <div>
        <label className="label">{t("staff.persona.leave.reason")}</label>
        <textarea className="input min-h-[60px]" value={reason}
          onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>

      <div>
        <label className="label">{t("admin.persona.leave.adminNoteLabel")}</label>
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
          placeholder={t("admin.persona.leave.adminNotePlaceholder")} />
      </div>

      <div>
        <label className="label">{t("admin.persona.leave.evidenceOptional")}</label>
        <input
          type="file" accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="input file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-slate-200 file:text-slate-700"
        />
      </div>

      {err && <div className="text-rose-600 text-sm">{err}</div>}

      <button className="btn-primary w-full" disabled={busy}>
        {busy ? t("common.submitting") : t("admin.persona.leave.recordApprove")}
      </button>
    </form>
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
