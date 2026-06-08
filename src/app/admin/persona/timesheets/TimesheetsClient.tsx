"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useConfirm } from "@/app/components/useConfirm";
import { nameWithPrefix } from "@/lib/name";

export type Punch = { id: number; ts: string };

export type TimesheetDayRow = {
  user_id: number;
  display_name: string;
  title_prefix: string | null;
  username: string;
  work_date: string; // YYYY-MM-DD (Bangkok)
  ins: Punch[];
  outs: Punch[];
  ot_until: string | null; // "HH:MM" approved OT end-time, or null
  shift: { code: string; start_time: string; end_time: string; kind: string } | null;
};

export type UserOption = {
  id: number;
  username: string;
  display_name: string;
  title_prefix: string | null;
};

export type AuditRow = {
  id: number;
  entry_id: number | null;
  entry_user_id: number;
  entry_type: "in" | "out";
  entry_ts: string;
  action: "delete" | "edit" | "create";
  admin_id: number;
  reason: string | null;
  created_at: string;
  entry_user_name: string | null;
  admin_name: string | null;
};

function formatBkk(ts: string, lang: Lang): string {
  const d = new Date(ts);
  const bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const date = bkk.toISOString().slice(0, 10);
  const time = bkk.toISOString().slice(11, 16);
  if (lang === "th") {
    const [y, m, dd] = date.split("-");
    const yBE = String(Number(y) + 543);
    return `${dd}/${m}/${yBE.slice(2)} ${time}`;
  }
  return `${date} ${time}`;
}

// HH:MM (Bangkok) from an ISO instant — for the in/out time cells.
function timeBkk(ts: string): string {
  const bkk = new Date(new Date(ts).getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(11, 16);
}

// DD/MM/YY for a YYYY-MM-DD Bangkok calendar date (BE year in Thai).
function formatDate(ymd: string, lang: Lang): string {
  const [y, m, dd] = ymd.split("-");
  if (lang === "th") return `${dd}/${m}/${String(Number(y) + 543).slice(2)}`;
  return `${dd}/${m}/${y.slice(2)}`;
}

export default function TimesheetsClient({
  lang,
  from,
  to,
  userIdFilter,
  users,
  dayRows,
  audit
}: {
  lang: Lang;
  from: string;
  to: string;
  userIdFilter: number | null;
  users: UserOption[];
  dayRows: TimesheetDayRow[];
  audit: AuditRow[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  // Manual re-push of the clock-in LINE card. Available only for
  // 'in' rows (clock-out doesn't produce a card). Used when the
  // auto-push at clock-in time was skipped — staff hadn't bound
  // LINE yet, platform OA was misconfigured, transient LINE
  // outage, etc.
  async function resendNotification(punch: Punch): Promise<void> {
    setResendingId(punch.id);
    try {
      const res = await fetch(
        `/api/admin/persona/timesheets/${punch.id}/resend-notification`,
        { method: "POST" }
      );
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        alert({
          title: t(lang, "admin.persona.timesheets.resend.successTitle"),
          body: <p>{t(lang, "admin.persona.timesheets.resend.successBody")}</p>,
          okLabel: t(lang, "common.confirm")
        });
      } else {
        // Map known error codes to user-friendly copy so admin
        // knows what to fix instead of seeing raw error strings.
        // Special case: the LINE 429 monthly-cap error gets its own
        // copy with the OA Manager URL, because "push_failed" alone
        // looks like a transient blip when it's really a billing /
        // wait-until-next-month situation.
        const isQuotaError =
          j?.message === "monthly_quota_exceeded"
          || /reached your monthly limit/i.test(j?.message ?? "");
        const codeMap: Record<string, string> = {
          no_line_user_id: t(lang, "admin.persona.timesheets.resend.errNoLine"),
          platform_not_configured: t(lang, "admin.persona.timesheets.resend.errNoChannel"),
          not_resendable: t(lang, "admin.persona.timesheets.resend.errNotIn"),
          branch_forbidden: t(lang, "admin.persona.timesheets.resend.errBranch"),
          push_failed: t(lang, "admin.persona.timesheets.resend.errPushFailed")
        };
        const msg = isQuotaError
          ? t(lang, "admin.persona.shiftReports.resendFailQuota")
          : codeMap[j?.error] || t(lang, "common.error");
        alert({
          title: t(lang, "admin.persona.timesheets.resend.failTitle"),
          body: <p>{msg}</p>,
          variant: "danger",
          okLabel: t(lang, "common.confirm")
        });
      }
    } catch {
      alert({
        title: t(lang, "common.error"),
        body: <p>{t(lang, "admin.persona.timesheets.resend.errPushFailed")}</p>,
        variant: "danger",
        okLabel: t(lang, "common.confirm")
      });
    } finally {
      setResendingId(null);
    }
  }

  async function deleteEntry(
    punch: Punch,
    type: "in" | "out",
    displayName: string
  ): Promise<void> {
    const body = t(lang, "admin.persona.timesheets.confirmDelete")
      .replace("{user}", displayName)
      .replace("{ts}", formatBkk(punch.ts, lang))
      .replace("{type}", t(lang, `clock.short.${type}` as any));

    const reason = await confirm({
      title: t(lang, "admin.persona.timesheets.confirmDeleteTitle"),
      body: <p>{body}</p>,
      confirmLabel: t(lang, "common.delete"),
      cancelLabel: t(lang, "common.cancel"),
      variant: "danger",
      withInput: true,
      inputLabel: t(lang, "admin.persona.timesheets.reasonPrompt"),
      inputPlaceholder: t(lang, "common.optional")
    });
    if (reason === null) return;

    setDeletingId(punch.id);
    fetch(`/api/admin/persona/timesheets/${punch.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: reason.slice(0, 200) })
    })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) {
          startTransition(() => router.refresh());
        } else {
          alert({
            title: t(lang, "common.error"),
            body: <p>{`${t(lang, "admin.persona.timesheets.deleteFailed")}: ${j?.error ?? "unknown"}`}</p>,
            variant: "danger",
            okLabel: t(lang, "common.confirm")
          });
        }
      })
      .catch(() => alert({
        title: t(lang, "common.error"),
        body: <p>{t(lang, "admin.persona.timesheets.deleteFailed")}</p>,
        variant: "danger",
        okLabel: t(lang, "common.confirm")
      }))
      .finally(() => setDeletingId(null));
  }

  const isLoading = pending || deletingId !== null || resendingId !== null;

  return (
    <>
      {/* Filters */}
      <form className="card grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-3" method="get">
        <div className="min-w-0">
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "admin.persona.timesheets.fromDate")}
          </label>
          <input type="date" name="from" defaultValue={from} className="input" />
        </div>
        <div className="min-w-0">
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "admin.persona.timesheets.toDate")}
          </label>
          <input type="date" name="to" defaultValue={to} className="input" />
        </div>
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <label className="block text-xs text-slate-500 mb-1">
            {t(lang, "admin.persona.timesheets.user")}
          </label>
          <select
            name="user_id"
            defaultValue={userIdFilter ? String(userIdFilter) : ""}
            className="input"
          >
            <option value="">
              {t(lang, "admin.persona.timesheets.allUsers")}
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {nameWithPrefix(u.title_prefix, u.display_name)} ({u.username})
              </option>
            ))}
          </select>
        </div>
        <button className="btn-primary sm:col-span-2 lg:col-span-1" type="submit">
          {t(lang, "admin.persona.timesheets.applyFilter")}
        </button>
      </form>

      {/* Entries table — one row per employee per day. Each day shows
          its clock-in(s), clock-out(s), approved OT until-time, and the
          rostered shift so admin can sanity-check the punches against
          the schedule at a glance (owner 2026-06-08). */}
      <div className="card overflow-x-auto">
        <h2 className="font-semibold text-slate-700 mb-3">
          {t(lang, "admin.persona.timesheets.entriesTitle")} ({dayRows.length})
        </h2>
        {dayRows.length === 0 ? (
          <p className="text-slate-500 text-sm py-4 text-center">
            {t(lang, "admin.persona.timesheets.empty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="py-2 pr-3">{t(lang, "admin.persona.timesheets.col.user")}</th>
                <th className="py-2 pr-3 whitespace-nowrap">{t(lang, "admin.persona.timesheets.col.date")}</th>
                <th className="py-2 pr-3 whitespace-nowrap">{t(lang, "admin.persona.timesheets.col.shift")}</th>
                <th className="py-2 pr-3">{t(lang, "admin.persona.timesheets.col.clockIn")}</th>
                <th className="py-2 pr-3">{t(lang, "admin.persona.timesheets.col.clockOut")}</th>
                <th className="py-2 pr-3 whitespace-nowrap">{t(lang, "admin.persona.timesheets.col.ot")}</th>
              </tr>
            </thead>
            <tbody>
              {dayRows.map((r) => {
                const name = nameWithPrefix(r.title_prefix, r.display_name);
                const isDayOff = r.shift?.kind === "day_off";
                return (
                  <tr key={`${r.user_id}|${r.work_date}`} className="border-b last:border-0 hover:bg-slate-50 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-slate-800">{name}</div>
                      <div className="text-xs text-slate-500">@{r.username}</div>
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap text-slate-700">
                      {formatDate(r.work_date, lang)}
                    </td>
                    <td className="py-2 pr-3 text-xs whitespace-nowrap">
                      {r.shift ? (
                        isDayOff ? (
                          <span className="text-slate-400">{t(lang, "admin.persona.timesheets.dayOff")}</span>
                        ) : (
                          <span className="text-slate-600">
                            <span className="font-medium text-slate-800">{r.shift.code}</span>
                            {" · "}
                            <span className="font-mono">{r.shift.start_time}–{r.shift.end_time}</span>
                          </span>
                        )
                      ) : (
                        <span className="text-slate-300">{t(lang, "admin.persona.timesheets.noShift")}</span>
                      )}
                    </td>
                    {/* Clock-in cell */}
                    <td className="py-2 pr-3">
                      {r.ins.length === 0 ? (
                        <span className="text-slate-300">{t(lang, "admin.persona.timesheets.noShift")}</span>
                      ) : (
                        <div className="space-y-1">
                          {r.ins.map((p) => (
                            <div key={p.id} className="flex items-center gap-2">
                              <span className="font-mono text-emerald-700 font-medium">{timeBkk(p.ts)}</span>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => resendNotification(p)}
                                className="text-[11px] text-brand hover:underline disabled:opacity-50"
                              >
                                {resendingId === p.id
                                  ? t(lang, "admin.persona.timesheets.resend.sending")
                                  : t(lang, "admin.persona.timesheets.resend.btn")}
                              </button>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => deleteEntry(p, "in", name)}
                                className="text-[11px] text-rose-600 hover:underline disabled:opacity-50"
                              >
                                {deletingId === p.id
                                  ? t(lang, "admin.persona.timesheets.deleting")
                                  : t(lang, "admin.persona.timesheets.delete")}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    {/* Clock-out cell */}
                    <td className="py-2 pr-3">
                      {r.outs.length === 0 ? (
                        <span className="text-slate-300">{t(lang, "admin.persona.timesheets.noShift")}</span>
                      ) : (
                        <div className="space-y-1">
                          {r.outs.map((p) => (
                            <div key={p.id} className="flex items-center gap-2">
                              <span className="font-mono text-rose-700 font-medium">{timeBkk(p.ts)}</span>
                              <button
                                type="button"
                                disabled={isLoading}
                                onClick={() => deleteEntry(p, "out", name)}
                                className="text-[11px] text-rose-600 hover:underline disabled:opacity-50"
                              >
                                {deletingId === p.id
                                  ? t(lang, "admin.persona.timesheets.deleting")
                                  : t(lang, "admin.persona.timesheets.delete")}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    {/* OT cell — approved OT until-time */}
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {r.ot_until ? (
                        <span className="font-mono text-amber-700 font-medium">{r.ot_until}</span>
                      ) : (
                        <span className="text-slate-300">{t(lang, "admin.persona.timesheets.noShift")}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Audit log */}
      {audit.length > 0 && (
        <div className="card">
          <h2 className="font-semibold text-slate-700 mb-3">
            {t(lang, "admin.persona.timesheets.auditTitle")}
          </h2>
          <ul className="space-y-2 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-2 gap-y-0.5 text-slate-600">
                <span className="text-xs text-slate-400 font-mono">
                  {formatBkk(a.created_at, lang)}
                </span>
                <span className="font-medium text-slate-800">{a.admin_name ?? `#${a.admin_id}`}</span>
                <span className="text-rose-600">
                  {t(lang, `admin.persona.timesheets.audit.${a.action}` as any)}
                </span>
                <span>
                  {t(lang, `clock.short.${a.entry_type}` as any)} →{" "}
                  <span className="text-slate-800">{a.entry_user_name ?? `#${a.entry_user_id}`}</span>
                </span>
                <span className="text-xs text-slate-400">@ {formatBkk(a.entry_ts, lang)}</span>
                {a.reason && (
                  <span className="basis-full text-xs italic text-slate-500 pl-6">
                    “{a.reason}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {ConfirmDialog}
    </>
  );
}
