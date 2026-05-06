"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import type { LeaveType, QuotaInfo, PublicHoliday } from "@/lib/leave-types";

export type { LeaveType };
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

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
  is_special_request?: number;
};

// Map: which leave types require attached evidence?
// (mirror ของ leave_types.requires_evidence — keep in sync กับ db.ts seed)
const TYPES_REQUIRE_EVIDENCE = new Set<LeaveType>([
  "sick", "pt_emergency", "maternity", "sterilization", "ordination", "military"
]);

// Format ชั่วโมงเป็น "X วัน Y ชม." หรือ "X วัน" หรือ "Y ชม." (ไม่ใช้ทศนิยม)
function fmtRemaining(remainingDaysDecimal: number, t: (k: any) => string): string {
  const totalH = Math.round(remainingDaysDecimal * 8 * 2) / 2;
  const fullDays = Math.floor(totalH / 8);
  const restH = Math.round(totalH - fullDays * 8);
  if (fullDays > 0 && restH > 0) {
    return t("staff.persona.leave.daysAndHours")
      .replace("{d}", String(fullDays))
      .replace("{h}", String(restH));
  }
  if (fullDays > 0) return t("staff.persona.leave.daysOnly").replace("{d}", String(fullDays));
  return t("staff.persona.leave.hoursOnly").replace("{h}", String(restH));
}

function clientComputeStretch(from: string, to: string, holidayMap: Map<string, PublicHoliday>) {
  const fMs = new Date(`${from}T00:00:00Z`).getTime();
  const tMs = new Date(`${to}T00:00:00Z`).getTime();
  const leaveDays = Math.max(1, Math.floor((tMs - fMs) / 86400000) + 1);
  const addDays = (d: string, n: number) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const prepended: PublicHoliday[] = [];
  let cur = addDays(from, -1);
  while (holidayMap.has(cur)) { prepended.unshift(holidayMap.get(cur)!); cur = addDays(cur, -1); }
  const appended: PublicHoliday[] = [];
  cur = addDays(to, 1);
  while (holidayMap.has(cur)) { appended.push(holidayMap.get(cur)!); cur = addDays(cur, 1); }
  return { leaveDays, prepended, appended, totalConsecutive: leaveDays + prepended.length + appended.length };
}

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
  weeklyOffDay,
  userGenderSet,
  userEmploymentSet
}: {
  eligibleTypes: LeaveType[];
  quotas: QuotaInfo[];
  requests: LeaveRow[];
  holidays: PublicHoliday[];
  yearsOfService: number | null;
  longLeaveCount: number;
  weeklyOffDay: number | null;
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
  const [isSpecial, setIsSpecial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const fullDays = daysBetween(from, to);
  const computedDays = usePartial && from === to ? +(hours / 8).toFixed(2) : fullDays;
  const evidenceRequired = TYPES_REQUIRE_EVIDENCE.has(type);

  // Quota check — ถ้าเหลือไม่เต็มวัน ห้ามขอเต็มวัน (Phase 1C v4 #7)
  const matchedQuota = quotas.find((q) => q.type === type);
  const isFullDayRequest = !(usePartial && from === to);
  const remainingHoursInQuota = matchedQuota?.remaining != null ? matchedQuota.remaining * 8 : null;
  const remainingHasFraction =
    remainingHoursInQuota != null && remainingHoursInQuota > 0 && remainingHoursInQuota < 8;
  const fullDayBlockedByFraction = isFullDayRequest && remainingHasFraction;

  // Stretch analysis (เฉพาะ personal/annual)
  const isLongLeaveType = type === "personal" || type === "annual";
  const stretch = useMemo(
    () => isLongLeaveType ? clientComputeStretch(from, to, holidayMap) : null,
    [isLongLeaveType, from, to, holidayMap]
  );
  const advanceDays = Math.floor(
    (new Date(`${from}T00:00:00Z`).getTime() - new Date(`${todayBkkStr()}T00:00:00Z`).getTime()) / 86400000
  );
  const annualNeedsYos = type === "annual" && (yearsOfService == null || yearsOfService < 1);

  // Phase 1C v6: weekend / weekly_off_day / public holiday detection
  const weekendDates: string[] = useMemo(() => {
    if (!isLongLeaveType) return [];
    const out: string[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const dow = d.getUTCDay();
      if (dow === 0 || dow === 6) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [isLongLeaveType, from, to]);
  const onUserOffDay: string[] = useMemo(() => {
    if (!isLongLeaveType || weeklyOffDay == null) return [];
    const out: string[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === weeklyOffDay) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [isLongLeaveType, from, to, weeklyOffDay]);
  const onPublicHoliday: string[] = useMemo(() => {
    if (!isLongLeaveType) return [];
    const out: string[] = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      if (holidayMap.has(ds)) out.push(ds);
    }
    return out;
  }, [isLongLeaveType, from, to, holidayMap]);

  // HARD BLOCK — ลาตรงวันหยุดประจำสัปดาห์ของตัวเอง (ติ๊ก special-track ก็ไม่ผ่าน)
  const hardBlockedByOffDay = isLongLeaveType && onUserOffDay.length > 0;

  // Special-track required (override ได้)
  const specialTrackRequired: boolean = Boolean(!hardBlockedByOffDay && isLongLeaveType && stretch && (
    stretch.totalConsecutive > 3 ||
    longLeaveCount >= 2 ||
    advanceDays < 7 ||
    annualNeedsYos ||
    weekendDates.length > 0 ||           // เสาร์/อาทิตย์
    onPublicHoliday.length > 0           // วันหยุดนักขัตฤกษ์
  ));

  function reset() {
    setType(eligibleTypes[0] ?? "sick");
    setFrom(tomorrow);
    setTo(tomorrow);
    setUsePartial(false);
    setHours(3);
    setReason("");
    setFile(null);
    setIsSpecial(false);
    setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!reason.trim()) { setErr(t("staff.persona.leave.err.reason_required")); return; }
    if (from > to) { setErr(t("staff.persona.leave.err.dateRange")); return; }
    if (from < todayBkkStr()) { setErr(t("staff.persona.leave.err.past_date_not_allowed")); return; }
    if (evidenceRequired && !file) { setErr(t("staff.persona.leave.err.evidenceRequired")); return; }
    if (fullDayBlockedByFraction) { setErr(t("staff.persona.leave.err.fractionalQuota")); return; }
    if (hardBlockedByOffDay) { setErr(t("staff.persona.leave.err.leave_on_weekly_off_day_not_allowed")); return; }
    if (specialTrackRequired && !isSpecial) {
      setErr(t("staff.persona.leave.err.exceeds_rules_use_special_track"));
      return;
    }

    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("type", type);
      fd.append("date_from", from);
      fd.append("date_to", to);
      fd.append("days", String(computedDays));
      if (usePartial && from === to) fd.append("hours", String(hours));
      fd.append("reason", reason);
      if (file) fd.append("file", file);
      if (isSpecial) fd.append("is_special_request", "1");

      const res = await fetch(apiUrl("/api/persona/leave"), { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errKey = `staff.persona.leave.err.${data.error}`;
        const translated = t(errKey as any);
        setErr(translated === errKey ? (data.error || t("common.error")) : translated);
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
    if (res.ok) startTransition(() => router.refresh());
    else {
      const j = await res.json().catch(() => ({}));
      alert(j.error || t("common.error"));
    }
  }

  return (
    <>
      {(!userGenderSet || !userEmploymentSet) && (
        <div className="card border-l-4 border-amber-400 bg-amber-50">
          <p className="text-sm text-amber-900">{t("staff.persona.leave.profileIncomplete")}</p>
        </div>
      )}

      {/* Quota overview — แสดง "X วัน Y ชม." */}
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
                    : t("staff.persona.leave.remainingOf", {
                        remaining: fmtRemaining(q.remaining ?? 0, t),
                        quota: q.quota
                      })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Form — collapsible */}
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
              <select className="input" value={type} onChange={(e) => setType(e.target.value as LeaveType)}>
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
                  <input type="checkbox" checked={usePartial} onChange={(e) => setUsePartial(e.target.checked)} />
                  {t("staff.persona.leave.partialDay")}
                </label>
                {usePartial && (
                  <div>
                    <label className="label">{t("staff.persona.leave.hoursLabel")}</label>
                    <input
                      type="number" min={1} max={8} step={1}
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

            {fullDayBlockedByFraction && (
              <div className="text-rose-600 text-sm border border-rose-200 bg-rose-50 rounded p-2">
                {t("staff.persona.leave.err.fractionalQuota")}
              </div>
            )}

            {/* Stretch preview (เฉพาะ personal/annual) — แสดงเสมอเพื่อแจ้งเตือน */}
            {isLongLeaveType && stretch && (
              <div className={`rounded-lg border p-3 text-sm space-y-1.5 ${
                hardBlockedByOffDay || annualNeedsYos
                  ? "border-rose-300 bg-rose-50"
                  : specialTrackRequired
                    ? "border-amber-300 bg-amber-50"
                    : "border-emerald-300 bg-emerald-50"
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
                  <li className={stretch.totalConsecutive <= 3 ? "text-emerald-700" : "text-amber-700"}>
                    {stretch.totalConsecutive <= 3 ? "✓" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.consecutiveCheck", { n: stretch.totalConsecutive })}
                  </li>
                  <li className={longLeaveCount < 2 ? "text-emerald-700" : "text-amber-700"}>
                    {longLeaveCount < 2 ? "✓" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.usageCheck", { used: longLeaveCount })}
                  </li>
                  {/* Phase 1C v5 #12 — ลากิจ < 7 วัน แสดงเตือนเสมอ (ไม่ silent) */}
                  <li className={advanceDays >= 7 ? "text-emerald-700" : "text-amber-700"}>
                    {advanceDays >= 7 ? "✓" : "⚠"}{" "}
                    {t("staff.persona.leave.stretch.advanceCheck", { n: advanceDays })}
                  </li>
                  {/* Phase 1C v6 — เสาร์/อาทิตย์ + วันหยุดนักขัตฤกษ์ (special track) */}
                  {weekendDates.length > 0 && (
                    <li className="text-amber-700">
                      ⚠ {t("staff.persona.leave.stretch.weekendWarning", { n: weekendDates.length })}
                    </li>
                  )}
                  {onPublicHoliday.length > 0 && (
                    <li className="text-amber-700">
                      ⚠ {t("staff.persona.leave.stretch.publicHolidayWarning", { n: onPublicHoliday.length })}
                    </li>
                  )}
                  {/* HARD BLOCK — ตรงกับวันหยุดประจำสัปดาห์ของ user (ติ๊ก special ก็ไม่ผ่าน) */}
                  {onUserOffDay.length > 0 && (
                    <li className="text-rose-700 font-medium">
                      ✗ {t("staff.persona.leave.stretch.weeklyOffDayBlocked", { n: onUserOffDay.length })}
                    </li>
                  )}
                  {annualNeedsYos && (
                    <li className="text-rose-700 font-medium">
                      ✗ {t("staff.persona.leave.stretch.annualYosFail", {
                        yos: yearsOfService != null ? yearsOfService.toFixed(1) : "—"
                      })}
                    </li>
                  )}
                </ul>
                <div className="pt-1.5 text-xs font-medium border-t border-slate-200/50 mt-2">
                  {hardBlockedByOffDay
                    ? <span className="text-rose-700">{t("staff.persona.leave.stretch.statusBlockedOffDay")}</span>
                    : annualNeedsYos
                      ? <span className="text-rose-700">{t("staff.persona.leave.stretch.statusBlocked")}</span>
                      : specialTrackRequired
                        ? <span className="text-amber-700">{t("staff.persona.leave.stretch.statusSpecialApproval")}</span>
                        : <span className="text-emerald-700">{t("staff.persona.leave.stretch.statusSelfService")}</span>}
                </div>
              </div>
            )}

            {/* Reason mandatory (Phase 1C v4 #5) */}
            <div>
              <label className="label">
                {t("staff.persona.leave.reason")}
                <span className="text-rose-500 ml-1">*</span>
              </label>
              <textarea
                className="input min-h-[80px]"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t(`staff.persona.leave.reasonPlaceholder.${type}` as any) === `staff.persona.leave.reasonPlaceholder.${type}`
                  ? t("staff.persona.leave.reasonPlaceholder")
                  : t(`staff.persona.leave.reasonPlaceholder.${type}` as any)}
                maxLength={500}
                required
              />
            </div>

            {/* Evidence — required ตามประเภท */}
            <div>
              <label className="label">
                {t("staff.persona.leave.evidence")}
                {evidenceRequired
                  ? <span className="text-rose-500 ml-1">*</span>
                  : <span className="text-slate-400 ml-1 text-xs">{t("staff.persona.leave.optional")}</span>}
              </label>
              <input
                type="file" accept="image/*,application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="input file:mr-2 file:px-2 file:py-1 file:rounded file:border-0 file:bg-slate-200 file:text-slate-700"
                required={evidenceRequired}
              />
              <p className="text-xs text-slate-500 mt-1">
                {t(`staff.persona.leave.evidence.hint.${type}` as any)}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                {t("staff.persona.leave.evidenceFormat")}
              </p>
            </div>

            {/* Special track checkbox — แสดงเฉพาะกรณีต้องใช้ */}
            {specialTrackRequired && (
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
                      {t("staff.persona.leave.specialTrack.title")}
                    </div>
                    <div className="text-xs text-amber-800 mt-1">
                      {t("staff.persona.leave.specialTrack.description")}
                    </div>
                  </div>
                </label>
              </div>
            )}

            {err && <div className="text-rose-600 text-sm">{err}</div>}

            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => { setFormOpen(false); reset(); }}
                className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
                {t("common.cancel")}
              </button>
              <button
                className="btn-primary flex-1"
                disabled={busy || hardBlockedByOffDay || annualNeedsYos || fullDayBlockedByFraction || (specialTrackRequired && !isSpecial)}
              >
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
                      {r.is_special_request === 1 && (
                        <span className="text-xs px-2 py-0.5 rounded font-medium bg-violet-100 text-violet-700">
                          {t("staff.persona.leave.specialBadge")}
                        </span>
                      )}
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
