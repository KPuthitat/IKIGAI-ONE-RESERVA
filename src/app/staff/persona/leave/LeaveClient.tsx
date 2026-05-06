"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { LeaveType, QuotaInfo, PublicHoliday } from "@/lib/leave";

export type { LeaveType };
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

// Client-side stretch calculation (mirror ของ computeStretch ใน lib/leave.ts)
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function clientComputeStretch(from: string, to: string, holidayMap: Map<string, PublicHoliday>) {
  const fMs = new Date(`${from}T00:00:00Z`).getTime();
  const tMs = new Date(`${to}T00:00:00Z`).getTime();
  const leaveDays = Math.max(1, Math.floor((tMs - fMs) / 86400000) + 1);

  const prepended: PublicHoliday[] = [];
  let cur = addDays(from, -1);
  while (holidayMap.has(cur)) {
    prepended.unshift(holidayMap.get(cur)!);
    cur = addDays(cur, -1);
  }
  const appended: PublicHoliday[] = [];
  cur = addDays(to, 1);
  while (holidayMap.has(cur)) {
    appended.push(holidayMap.get(cur)!);
    cur = addDays(cur, 1);
  }
  return { leaveDays, prepended, appended, totalConsecutive: leaveDays + prepended.length + appended.length };
}

export type LeaveRow = {
  id: number;
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
};

function todayBkkStr(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function daysBetween(from: string, to: string): number {
  const f = new Date(`${from}T00:00:00Z`).getTime();
  const t = new Date(`${to}T00:00:00Z`).getTime();
  return Math.max(1, Math.floor((t - f) / 86400000) + 1);
}

export default function LeaveClient({
  eligibleTypes,
  quotas,
  requests,
  holidays,
  yearsOfService,
  longLeaveCount,
  userGenderSet,
  userEmploymentSet
}: {
  eligibleTypes: LeaveType[];
  quotas: QuotaInfo[];
  requests: LeaveRow[];
  holidays: PublicHoliday[];
  yearsOfService: number | null;
  longLeaveCount: number;
  userGenderSet: boolean;
  userEmploymentSet: boolean;
}) {
  const router = useRouter();
  const { t, formatDate, lang } = useLang();
  const [pending, startTransition] = useTransition();

  const holidayMap = useMemo(
    () => new Map(holidays.map((h) => [h.date, h])),
    [holidays]
  );

  const [formOpen, setFormOpen] = useState(false);
  const tomorrow = new Date(Date.now() + 86400_000 + 7 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const [type, setType] = useState<LeaveType>(eligibleTypes[0] ?? "sick");
  const [from, setFrom] = useState(tomorrow);
  const [to, setTo] = useState(tomorrow);
  const [usePartial, setUsePartial] = useState(false);
  const [hours, setHours] = useState<number>(3);
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // คำนวณ days: ถ้า partial-day → days = hours/8, else วันเต็มจำนวน
  const fullDays = daysBetween(from, to);
  const computedDays = usePartial && from === to ? +(hours / 8).toFixed(2) : fullDays;

  // Real-time stretch analysis (เฉพาะลากิจ/ลาพักร้อน)
  const isLongLeaveType = type === "personal" || type === "annual";
  const stretch = useMemo(
    () => isLongLeaveType ? clientComputeStretch(from, to, holidayMap) : null,
    [isLongLeaveType, from, to, holidayMap]
  );
  const todayBkk = todayBkkStr();
  const advanceDays = Math.floor(
    (new Date(`${from}T00:00:00Z`).getTime() - new Date(`${todayBkk}T00:00:00Z`).getTime()) / 86400000
  );
  const annualNeedsYos = type === "annual" && (yearsOfService == null || yearsOfService < 1);
  const exceedsMax = stretch ? stretch.totalConsecutive > 5 : false;
  const withinAll = stretch
    ? stretch.totalConsecutive <= 3 && longLeaveCount < 2 && advanceDays >= 7
    : false;

  function reset() {
    setType(eligibleTypes[0] ?? "sick");
    setFrom(tomorrow);
    setTo(tomorrow);
    setUsePartial(false);
    setHours(3);
    setReason("");
    setFile(null);
    setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (from > to) { setErr(t("staff.persona.leave.err.dateRange")); return; }
    if (!file) { setErr(t("staff.persona.leave.err.evidenceRequired")); return; }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("type", type);
      fd.append("date_from", from);
      fd.append("date_to", to);
      fd.append("days", String(computedDays));
      if (usePartial && from === to) fd.append("hours", String(hours));
      fd.append("reason", reason);
      fd.append("file", file);

      const res = await fetch(apiUrl("/api/persona/leave"), { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errKey = `staff.persona.leave.err.${data.error}`;
        setErr(t(errKey as any) === errKey ? (data.error || t("common.error")) : t(errKey as any));
        return;
      }
      reset();
      setFormOpen(false);
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
      {/* Profile-not-set warning */}
      {(!userGenderSet || !userEmploymentSet) && (
        <div className="card border-l-4 border-amber-400 bg-amber-50">
          <p className="text-sm text-amber-900">
            {t("staff.persona.leave.profileIncomplete")}
          </p>
        </div>
      )}

      {/* Quota overview */}
      <div className="card">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("staff.persona.leave.quotaTitle")}
        </h2>
        {quotas.length === 0 ? (
          <p className="text-slate-500 text-sm">{t("staff.persona.leave.noEligibleTypes")}</p>
        ) : (
          <ul className="space-y-1.5">
            {quotas.map((q) => (
              <li key={q.type} className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{t(`leave.type.${q.type}` as any)}</span>
                <span className="text-slate-500">
                  {q.quota == null
                    ? t("staff.persona.leave.unlimited")
                    : t("staff.persona.leave.remainingQuota", {
                        remaining: q.remaining ?? 0,
                        quota: q.quota
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* New request — collapsible */}
      <div className="card">
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          disabled={eligibleTypes.length === 0}
          className="w-full flex items-center justify-between text-left disabled:opacity-50"
        >
          <span className="font-semibold text-slate-800">
            {formOpen ? t("staff.persona.leave.formTitle") : t("staff.persona.leave.newRequest")}
          </span>
          <span className="text-slate-400 text-lg">{formOpen ? "▲" : "▼"}</span>
        </button>

        {formOpen && (
          <form onSubmit={submit} className="space-y-3 mt-4">
            <div>
              <label className="label">{t("staff.persona.leave.type")}</label>
              <select
                className="input"
                value={type}
                onChange={(e) => setType(e.target.value as LeaveType)}
              >
                {eligibleTypes.map((tp) => (
                  <option key={tp} value={tp}>{t(`leave.type.${tp}` as any)}</option>
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
                  }} required
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
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox" checked={usePartial}
                    onChange={(e) => setUsePartial(e.target.checked)}
                  />
                  {t("staff.persona.leave.partialDay")}
                </label>
                {usePartial && (
                  <div>
                    <label className="label">{t("staff.persona.leave.hoursLabel")}</label>
                    <input
                      type="number" min={1} max={8} step={0.5}
                      className="input"
                      value={hours}
                      onChange={(e) => setHours(Number(e.target.value))}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="text-sm text-slate-500">
              {usePartial && from === to
                ? t("staff.persona.leave.totalHours", { h: hours })
                : t("staff.persona.leave.totalDays", { n: computedDays })}
            </div>

            {/* Long-leave stretch preview (personal/annual เท่านั้น) */}
            {isLongLeaveType && stretch && (stretch.prepended.length > 0 || stretch.appended.length > 0 || stretch.totalConsecutive > 1) && (
              <div className={`rounded-lg border p-3 text-sm space-y-1.5 ${
                exceedsMax || annualNeedsYos
                  ? "border-rose-300 bg-rose-50"
                  : withinAll
                    ? "border-emerald-300 bg-emerald-50"
                    : "border-amber-300 bg-amber-50"
              }`}>
                <div className="font-medium text-slate-800">
                  {t("staff.persona.leave.stretch.title", { n: stretch.totalConsecutive })}
                </div>
                {stretch.prepended.length + stretch.appended.length > 0 && (
                  <div className="text-xs text-slate-600">
                    {t("staff.persona.leave.stretch.includesHolidays")}:
                    <ul className="list-disc list-inside mt-0.5">
                      {[...stretch.prepended, ...stretch.appended].map((h) => (
                        <li key={h.date}>
                          {formatDate(h.date)} — {lang === "en" ? h.name_en : h.name_th}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <ul className="text-xs space-y-0.5 pt-1">
                  <li className={exceedsMax ? "text-rose-700 font-medium" : stretch.totalConsecutive <= 3 ? "text-emerald-700" : "text-amber-700"}>
                    {stretch.totalConsecutive <= 3 ? "✓" : exceedsMax ? "✗" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.consecutiveCheck", { n: stretch.totalConsecutive })}
                  </li>
                  <li className={longLeaveCount < 2 ? "text-emerald-700" : "text-amber-700"}>
                    {longLeaveCount < 2 ? "✓" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.usageCheck", { used: longLeaveCount })}
                  </li>
                  <li className={advanceDays >= 7 ? "text-emerald-700" : "text-amber-700"}>
                    {advanceDays >= 7 ? "✓" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.advanceCheck", { n: advanceDays })}
                  </li>
                  {annualNeedsYos && (
                    <li className="text-rose-700 font-medium">
                      ✗ {t("staff.persona.leave.stretch.annualYosFail", {
                        yos: yearsOfService != null ? yearsOfService.toFixed(1) : "—"
                      })}
                    </li>
                  )}
                </ul>
                <div className="pt-1.5 text-xs font-medium">
                  {exceedsMax || annualNeedsYos
                    ? <span className="text-rose-700">{t("staff.persona.leave.stretch.statusBlocked")}</span>
                    : withinAll
                      ? <span className="text-emerald-700">{t("staff.persona.leave.stretch.statusSelfService")}</span>
                      : <span className="text-amber-700">{t("staff.persona.leave.stretch.statusSpecialApproval")}</span>}
                </div>
              </div>
            )}

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

            <div>
              <label className="label">
                {t("staff.persona.leave.evidence")}
                <span className="text-rose-500 ml-1">*</span>
              </label>
              <input
                type="file" accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="input file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-slate-200 file:text-slate-700"
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                {t("staff.persona.leave.evidenceHint")}
              </p>
            </div>

            {err && <div className="text-rose-600 text-sm">{err}</div>}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => { setFormOpen(false); reset(); }}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
                {t("common.cancel")}
              </button>
              <button className="btn-primary flex-1" disabled={busy || (isLongLeaveType && (exceedsMax || annualNeedsYos))}>
                {busy ? t("common.submitting") : t("staff.persona.leave.submit")}
              </button>
            </div>
          </form>
        )}
      </div>

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
                        ({r.hours
                          ? t("staff.persona.leave.hoursShort", { h: r.hours })
                          : t("staff.persona.leave.daysShort", { n: r.days })})
                      </span>
                    </div>
                    {r.reason && (
                      <div className="text-xs text-slate-500 mt-1 italic">"{r.reason}"</div>
                    )}
                    {r.evidence_filename && (
                      <a
                        href={apiUrl(`/api/persona/leave/${r.id}/attachment`)}
                        target="_blank" rel="noopener"
                        className="inline-block text-xs text-brand hover:underline mt-1"
                      >
                        {t("staff.persona.leave.viewEvidence")}
                      </a>
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
