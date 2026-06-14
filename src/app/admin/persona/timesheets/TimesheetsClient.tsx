"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { useConfirm } from "@/app/components/useConfirm";
import { nameWithPrefix } from "@/lib/name";
import PinPromptModal from "@/app/components/PinPromptModal";

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
  audit,
  certEntryIds = []
}: {
  lang: Lang;
  from: string;
  to: string;
  userIdFilter: number | null;
  users: UserOption[];
  dayRows: TimesheetDayRow[];
  audit: AuditRow[];
  /** time_entries.id of punches that came from an approved time
   *  certification — rendered with a "รับรองเวลา" tag so the source is
   *  obvious (owner 2026-06-10). */
  certEntryIds?: number[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refresh = () => startTransition(() => router.refresh());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);
  // Admin add-missing-punch inline editor: addKey = `${user_id}|${date}|${type}`.
  const [addKey, setAddKey] = useState<string | null>(null);
  const [addTime, setAddTime] = useState("");
  const [addingKey, setAddingKey] = useState<string | null>(null);
  // Edit-punch inline editor: editId = the time_entries.id being edited.
  const [editId, setEditId] = useState<number | null>(null);
  const [editTime, setEditTime] = useState("");
  const [savingEditId, setSavingEditId] = useState<number | null>(null);
  // Standalone "ลงเวลาแทนพนักงาน" panel (owner 2026-06-11) — lets an admin
  // record a clock in/out for any employee + day, even when no row exists
  // yet (the inline "+ เพิ่มเวลา" only appears on days that already have a row).
  const [helpUserId, setHelpUserId] = useState("");
  const [helpDate, setHelpDate] = useState(to);
  const [helpType, setHelpType] = useState<"in" | "out">("in");
  const [helpTime, setHelpTime] = useState("");
  const [helpBusy, setHelpBusy] = useState(false);
  const certSet = new Set(certEntryIds);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  async function submitHelpPunch(): Promise<void> {
    if (!helpUserId || !/^\d{4}-\d{2}-\d{2}$/.test(helpDate) || !/^\d{2}:\d{2}$/.test(helpTime)) return;
    setHelpBusy(true);
    try {
      const ts = new Date(`${helpDate}T${helpTime}:00+07:00`).toISOString();
      const res = await fetch("/api/admin/persona/timesheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: Number(helpUserId), type: helpType, ts })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setHelpTime("");
        alert({
          title: "สำเร็จ",
          body: <p>ลงเวลา{helpType === "in" ? "เข้า" : "ออก"}ให้พนักงานเรียบร้อยแล้ว</p>,
          okLabel: t(lang, "common.confirm")
        });
        startTransition(() => router.refresh());
      } else {
        alert({
          title: t(lang, "common.error"),
          body: <p>{j?.message ?? j?.error ?? "ลงเวลาไม่สำเร็จ"}</p>,
          variant: "danger",
          okLabel: t(lang, "common.confirm")
        });
      }
    } catch {
      alert({
        title: t(lang, "common.error"),
        body: <p>{t(lang, "common.error")}</p>,
        variant: "danger",
        okLabel: t(lang, "common.confirm")
      });
    } finally {
      setHelpBusy(false);
    }
  }

  // Add a punch the staff never recorded (or that vanished). Creates the
  // time_entries row + recomputes draft payroll — the reliable admin path
  // when a certification didn't make it through.
  async function submitAdd(r: TimesheetDayRow, type: "in" | "out"): Promise<void> {
    if (!/^\d{2}:\d{2}$/.test(addTime)) return;
    const key = `${r.user_id}|${r.work_date}|${type}`;
    setAddingKey(key);
    try {
      const ts = new Date(`${r.work_date}T${addTime}:00+07:00`).toISOString();
      const res = await fetch("/api/admin/persona/timesheets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: r.user_id, type, ts })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setAddKey(null);
        setAddTime("");
        startTransition(() => router.refresh());
      } else {
        alert({
          title: t(lang, "common.error"),
          body: <p>{j?.message ?? j?.error ?? "เพิ่มเวลาไม่สำเร็จ"}</p>,
          variant: "danger",
          okLabel: t(lang, "common.confirm")
        });
      }
    } catch {
      alert({
        title: t(lang, "common.error"),
        body: <p>{t(lang, "common.error")}</p>,
        variant: "danger",
        okLabel: t(lang, "common.confirm")
      });
    } finally {
      setAddingKey(null);
    }
  }

  // Edit an existing punch's time (owner 2026-06-14). PATCHes the entry's ts
  // (built from the punch's own Bangkok date + the new HH:MM) → audited +
  // payroll refreshed server-side.
  async function submitEdit(p: { id: number; ts: string }): Promise<void> {
    if (!/^\d{2}:\d{2}$/.test(editTime)) return;
    setSavingEditId(p.id);
    try {
      const dateBkk = new Date(new Date(p.ts).getTime() + 7 * 3600_000).toISOString().slice(0, 10);
      const ts = new Date(`${dateBkk}T${editTime}:00+07:00`).toISOString();
      const res = await fetch(`/api/admin/persona/timesheets/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) {
        setEditId(null);
        setEditTime("");
        startTransition(() => router.refresh());
      } else {
        alert({
          title: t(lang, "common.error"),
          body: <p>{j?.message ?? j?.error ?? "แก้ไขเวลาไม่สำเร็จ"}</p>,
          variant: "danger",
          okLabel: t(lang, "common.confirm")
        });
      }
    } catch {
      alert({ title: t(lang, "common.error"), body: <p>{t(lang, "common.error")}</p>, variant: "danger", okLabel: t(lang, "common.confirm") });
    } finally {
      setSavingEditId(null);
    }
  }

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

  // Inline "+ เพิ่มเวลา" control shown in an empty in/out cell.
  function addPunchUI(r: TimesheetDayRow, type: "in" | "out") {
    const key = `${r.user_id}|${r.work_date}|${type}`;
    if (addKey === key) {
      return (
        <div className="flex items-center gap-1">
          <input type="time" autoFocus value={addTime}
            onChange={(e) => setAddTime(e.target.value)}
            className="input !w-[92px] !py-0.5 text-xs" />
          <button type="button"
            disabled={addingKey === key || !/^\d{2}:\d{2}$/.test(addTime)}
            onClick={() => submitAdd(r, type)}
            className="text-[11px] text-emerald-700 font-bold hover:underline disabled:opacity-50">
            {addingKey === key ? "…" : "บันทึก"}
          </button>
          <button type="button" onClick={() => { setAddKey(null); setAddTime(""); }}
            className="text-[11px] text-slate-400 hover:text-slate-600">✕</button>
        </div>
      );
    }
    return (
      <button type="button" disabled={addingKey !== null}
        onClick={() => { setAddKey(key); setAddTime(""); }}
        className="text-[11px] text-brand hover:underline disabled:opacity-50">
        + เพิ่มเติม
      </button>
    );
  }

  // Render one punch: time (or inline edit box) + แก้ไข / ลบออก actions.
  // For clock-in we also keep the resend-notification action.
  function renderPunch(p: { id: number; ts: string }, type: "in" | "out", name: string) {
    if (editId === p.id) {
      return (
        <div className="flex items-center gap-1">
          <input type="time" autoFocus value={editTime}
            onChange={(e) => setEditTime(e.target.value)}
            className="input !w-[92px] !py-0.5 text-xs" />
          <button type="button"
            disabled={savingEditId === p.id || !/^\d{2}:\d{2}$/.test(editTime)}
            onClick={() => submitEdit(p)}
            className="text-[11px] text-emerald-700 font-bold hover:underline disabled:opacity-50">
            {savingEditId === p.id ? "…" : "บันทึก"}
          </button>
          <button type="button" onClick={() => { setEditId(null); setEditTime(""); }}
            className="text-[11px] text-slate-400 hover:text-slate-600">✕</button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <span className={`font-mono font-medium ${type === "in" ? "text-emerald-700" : "text-rose-700"}`}>{timeBkk(p.ts)}</span>
        {certSet.has(p.id) && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 text-violet-700 font-bold">รับรองเวลา</span>
        )}
        {type === "in" && (
          <button type="button" disabled={isLoading} onClick={() => resendNotification(p)}
            className="text-[11px] text-brand hover:underline disabled:opacity-50">
            {resendingId === p.id ? t(lang, "admin.persona.timesheets.resend.sending") : t(lang, "admin.persona.timesheets.resend.btn")}
          </button>
        )}
        <button type="button" disabled={isLoading}
          onClick={() => { setEditId(p.id); setEditTime(timeBkk(p.ts)); }}
          className="text-[11px] text-amber-700 hover:underline disabled:opacity-50">
          แก้ไข
        </button>
        <button type="button" disabled={isLoading} onClick={() => deleteEntry(p, type, name)}
          className="text-[11px] text-rose-600 hover:underline disabled:opacity-50">
          {deletingId === p.id ? t(lang, "admin.persona.timesheets.deleting") : "ลบออก"}
        </button>
      </div>
    );
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

      {/* ลงเวลาแทนพนักงาน — admin records a clock in/out for any employee +
          day (owner 2026-06-11). Works even when no row exists yet. Records
          on the admin's active branch, audited, + recomputes draft payroll. */}
      <div className="card space-y-2">
        <div>
          <h2 className="font-bold text-slate-800 text-sm">ลงเวลาแทนพนักงาน</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            ช่วยลงเวลาเข้า/ออกให้พนักงานที่ลืมลงเวลา — บันทึกในสาขาที่กำลังใช้งาน และคำนวณค่าตอบแทนรอบที่ยังเปิดอยู่ให้อัตโนมัติ
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end gap-2">
          <div className="min-w-0 lg:flex-1">
            <label className="block text-xs text-slate-500 mb-1">พนักงาน</label>
            <select className="input" value={helpUserId}
              onChange={(e) => setHelpUserId(e.target.value)}>
              <option value="">— เลือกพนักงาน —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {nameWithPrefix(u.title_prefix, u.display_name)} ({u.username})
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-xs text-slate-500 mb-1">วันที่</label>
            <input type="date" className="input" value={helpDate}
              onChange={(e) => setHelpDate(e.target.value)} />
          </div>
          <div className="min-w-0">
            <label className="block text-xs text-slate-500 mb-1">ประเภท</label>
            <select className="input" value={helpType}
              onChange={(e) => setHelpType(e.target.value as "in" | "out")}>
              <option value="in">เวลาเข้า</option>
              <option value="out">เวลาออก</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-xs text-slate-500 mb-1">เวลา</label>
            <input type="time" className="input" value={helpTime}
              onChange={(e) => setHelpTime(e.target.value)} />
          </div>
          <button type="button"
            disabled={helpBusy || !helpUserId || !/^\d{2}:\d{2}$/.test(helpTime)}
            onClick={submitHelpPunch}
            className="btn-primary disabled:opacity-50">
            {helpBusy ? "กำลังบันทึก…" : "ลงเวลาให้"}
          </button>
        </div>
      </div>

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
                        addPunchUI(r, "in")
                      ) : (
                        <div className="space-y-1">
                          {r.ins.map((p) => (
                            <div key={p.id}>{renderPunch(p, "in", name)}</div>
                          ))}
                        </div>
                      )}
                    </td>
                    {/* Clock-out cell */}
                    <td className="py-2 pr-3">
                      {r.outs.length === 0 ? (
                        addPunchUI(r, "out")
                      ) : (
                        <div className="space-y-1">
                          {r.outs.map((p) => (
                            <div key={p.id}>{renderPunch(p, "out", name)}</div>
                          ))}
                        </div>
                      )}
                    </td>
                    {/* OT cell — approved OT until-time + admin add/edit */}
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <OtCell row={r} onSaved={refresh} />
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

// OT cell on the timesheet — shows the approved OT until-time and lets an
// admin add/edit it directly (owner 2026-06-14). Saving posts an
// already-approved ot_request; requires the admin PIN (pay change).
function OtCell({ row, onSaved }: { row: TimesheetDayRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [until, setUntil] = useState(row.ot_until ?? row.shift?.end_time ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [delPinOpen, setDelPinOpen] = useState(false);
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(until);

  async function save(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/persona/ot-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: row.user_id, work_date: row.work_date, requested_until: until, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { setEditing(false); onSaved(); return { ok: true }; }
      const m = j?.error === "wrong_pin" ? "PIN ไม่ถูกต้อง"
        : j?.error === "no_pin" ? "ยังไม่ได้ตั้ง PIN"
        : j?.error === "not_eligible_for_ot" ? "ไม่มีประเภทการจ้าง (PT/FT)"
        : j?.error === "user_not_in_branch" ? "ไม่พบพนักงานในสาขานี้"
        : j?.error ?? "ไม่สำเร็จ";
      setErr(m);
      return { ok: false, message: m };
    } finally { setBusy(false); }
  }

  async function del(pin: string): Promise<{ ok: true } | { ok: false; message: string }> {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/persona/ot-requests", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: row.user_id, work_date: row.work_date, pin })
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j?.ok) { onSaved(); return { ok: true }; }
      const m = j?.error === "wrong_pin" ? "PIN ไม่ถูกต้อง" : j?.error === "no_pin" ? "ยังไม่ได้ตั้ง PIN" : j?.error ?? "ไม่สำเร็จ";
      setErr(m);
      return { ok: false, message: m };
    } finally { setBusy(false); }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        {row.ot_until
          ? <span className="font-mono text-amber-700 font-medium">{row.ot_until}</span>
          : <span className="text-slate-300">—</span>}
        <button type="button"
          onClick={() => { setUntil(row.ot_until ?? row.shift?.end_time ?? ""); setEditing(true); setErr(null); }}
          className="text-[11px] text-amber-700 hover:underline">
          {row.ot_until ? "แก้ไข" : "เพิ่มเติม"}
        </button>
        {row.ot_until && (
          <button type="button" onClick={() => { setDelPinOpen(true); setErr(null); }}
            className="text-[11px] text-rose-600 hover:underline">ลบออก</button>
        )}
        {err && <span className="text-[10px] text-rose-600">{err}</span>}
        {delPinOpen && (
          <PinPromptModal
            title="ยืนยันลบ OT"
            description={<>ลบ OT วันที่ {row.work_date} — กระทบเงินเดือน ต้องใส่ PIN</>}
            submitLabel="ลบออก"
            onSubmit={del}
            onClose={() => setDelPinOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input type="time" className="input !w-auto !py-0.5 text-xs" value={until}
        onChange={(e) => setUntil(e.target.value)} />
      <button type="button" disabled={busy || !valid} onClick={() => setPinOpen(true)}
        className="text-[11px] px-2 py-0.5 rounded bg-brand text-white font-bold disabled:opacity-50">
        บันทึก
      </button>
      <button type="button" onClick={() => { setEditing(false); setErr(null); }}
        className="text-[11px] text-slate-500 hover:underline">ยกเลิก</button>
      {err && <span className="text-[10px] text-rose-600">{err}</span>}
      {pinOpen && (
        <PinPromptModal
          title="ยืนยันเพิ่ม OT"
          description={<>เพิ่ม OT ถึง <b>{until}</b> น. วันที่ {row.work_date} — กระทบเงินเดือน ต้องใส่ PIN</>}
          submitLabel="บันทึก"
          onSubmit={save}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
