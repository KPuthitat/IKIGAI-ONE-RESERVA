"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Branch } from "@/lib/db";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

const DAY_LABELS_TH = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

function parseWeekdays(json: string | null): number[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  } catch {}
  return [];
}
function parseDates(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (Array.isArray(arr)) return arr.filter((s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s));
  } catch {}
  return [];
}

export default function SettingsClient({ branch }: { branch: Branch }) {
  const router = useRouter();
  const { t } = useLang();
  const [form, setForm] = useState({
    open_time: branch.open_time,
    close_time: branch.close_time,
    slot_minutes: branch.slot_minutes,
    default_duration_minutes: branch.default_duration_minutes,
    reminder_minutes_before: branch.reminder_minutes_before,
    line_channel_secret: branch.line_channel_secret ?? "",
    line_channel_token: branch.line_channel_token ?? "",
    staff_line_user_ids: branch.staff_line_user_ids ?? "[]",
    status: branch.status ?? "open",
    opens_on: branch.opens_on ?? "",
    closed_weekdays: parseWeekdays(branch.closed_weekdays),
    // Lunch break
    lunch_break_start: branch.lunch_break_start ?? "",
    lunch_break_end: branch.lunch_break_end ?? "",
    lunch_break_weekdays: parseWeekdays(branch.lunch_break_weekdays),
    no_lunch_break_dates: parseDates(branch.no_lunch_break_dates),
    // Customer Flex 'Menu' CTA — admin only sets the URL; the label is
    // hardcoded per language in the Flex builder.
    extra_button_url: branch.extra_button_url ?? "",
    // Fallback phone for the pending-confirmation LINE message.
    contact_phone: branch.contact_phone ?? ""
  });
  const [newSpecialDate, setNewSpecialDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(false);
    try {
      JSON.parse(form.staff_line_user_ids);
    } catch {
      setErr(t("admin.settings.invalidJson"));
      return;
    }
    setBusy(true);
    const hasLunch = Boolean(form.lunch_break_start && form.lunch_break_end);
    const payload = {
      ...form,
      opens_on: form.status === "coming_soon" && form.opens_on ? form.opens_on : null,
      closed_weekdays: form.closed_weekdays.length > 0 ? JSON.stringify(form.closed_weekdays) : null,
      lunch_break_start: hasLunch ? form.lunch_break_start : null,
      lunch_break_end: hasLunch ? form.lunch_break_end : null,
      lunch_break_weekdays: hasLunch && form.lunch_break_weekdays.length > 0
        ? JSON.stringify(form.lunch_break_weekdays) : null,
      no_lunch_break_dates: form.no_lunch_break_dates.length > 0
        ? JSON.stringify(form.no_lunch_break_dates) : null,
      extra_button_url: form.extra_button_url.trim() || null,
      contact_phone: form.contact_phone.trim() || null
    };
    const res = await fetch(apiUrl(`/api/admin/branch/${branch.id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || t("admin.settings.saveFailed"));
      return;
    }
    setOk(true);
    router.refresh();
  }

  function toggleClosedDay(d: number) {
    setForm((f) => ({
      ...f,
      closed_weekdays: f.closed_weekdays.includes(d)
        ? f.closed_weekdays.filter((x) => x !== d)
        : [...f.closed_weekdays, d].sort((a, b) => a - b)
    }));
  }
  function toggleLunchDay(d: number) {
    setForm((f) => ({
      ...f,
      lunch_break_weekdays: f.lunch_break_weekdays.includes(d)
        ? f.lunch_break_weekdays.filter((x) => x !== d)
        : [...f.lunch_break_weekdays, d].sort((a, b) => a - b)
    }));
  }
  function addSpecialDate() {
    if (!newSpecialDate || !/^\d{4}-\d{2}-\d{2}$/.test(newSpecialDate)) return;
    if (form.no_lunch_break_dates.includes(newSpecialDate)) return;
    setForm((f) => ({
      ...f,
      no_lunch_break_dates: [...f.no_lunch_break_dates, newSpecialDate].sort()
    }));
    setNewSpecialDate("");
  }
  function removeSpecialDate(d: string) {
    setForm((f) => ({
      ...f,
      no_lunch_break_dates: f.no_lunch_break_dates.filter((x) => x !== d)
    }));
  }

  return (
    <form onSubmit={save} className="card space-y-4 max-w-2xl">
      <h2 className="font-semibold">{t("admin.settings.statusSection")}</h2>
      <div>
        <label className="label">{t("admin.settings.field.status")}</label>
        <select className="input" value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as "open" | "coming_soon" })}>
          <option value="open">{t("admin.settings.status.open")}</option>
          <option value="coming_soon">{t("admin.settings.status.comingSoon")}</option>
        </select>
      </div>
      {form.status === "coming_soon" && (
        <div>
          <label className="label">{t("admin.settings.field.opensOn")}</label>
          <input type="date" className="input" value={form.opens_on}
            onChange={(e) => setForm({ ...form, opens_on: e.target.value })} />
          <p className="text-xs text-slate-500 mt-1">{t("admin.settings.opensOnHint")}</p>
        </div>
      )}
      <div>
        <label className="label">{t("admin.settings.field.closedWeekdays")}</label>
        <div className="flex gap-1.5 flex-wrap">
          {DAY_LABELS_TH.map((label, i) => {
            const active = form.closed_weekdays.includes(i);
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleClosedDay(i)}
                className={`w-10 h-10 rounded-lg border-2 text-sm font-medium transition ${
                  active
                    ? "bg-rose-500 border-rose-500 text-white"
                    : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-500 mt-1">{t("admin.settings.closedWeekdaysHint")}</p>
      </div>

      <h2 className="font-semibold pt-3 border-t border-slate-100">{t("admin.settings.openCloseSection")}</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="min-w-0">
          <label className="label">{t("admin.settings.field.openTime")}</label>
          <input type="time" className="input" value={form.open_time}
            onChange={(e) => setForm({ ...form, open_time: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label className="label">{t("admin.settings.field.closeTime")}</label>
          <input type="time" className="input" value={form.close_time}
            onChange={(e) => setForm({ ...form, close_time: e.target.value })} />
        </div>
      </div>

      {/* Lunch break section */}
      <h2 className="font-semibold pt-3 border-t border-slate-100">{t("admin.settings.lunchBreakSection")}</h2>
      <p className="text-sm text-slate-500">{t("admin.settings.lunchBreakDesc")}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="min-w-0">
          <label className="label">{t("admin.settings.field.lunchBreakStart")}</label>
          <input type="time" className="input" value={form.lunch_break_start}
            onChange={(e) => setForm({ ...form, lunch_break_start: e.target.value })} />
        </div>
        <div className="min-w-0">
          <label className="label">{t("admin.settings.field.lunchBreakEnd")}</label>
          <input type="time" className="input" value={form.lunch_break_end}
            onChange={(e) => setForm({ ...form, lunch_break_end: e.target.value })} />
        </div>
      </div>
      <div>
        <label className="label">{t("admin.settings.field.lunchBreakWeekdays")}</label>
        <div className="flex gap-1.5 flex-wrap">
          {DAY_LABELS_TH.map((label, i) => {
            const active = form.lunch_break_weekdays.includes(i);
            return (
              <button key={i} type="button" onClick={() => toggleLunchDay(i)}
                className={`w-10 h-10 rounded-lg border-2 text-sm font-medium transition ${
                  active ? "bg-amber-500 border-amber-500 text-white"
                         : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                }`}>
                {label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-slate-500 mt-1">{t("admin.settings.lunchBreakWeekdaysHint")}</p>
      </div>
      <div>
        <label className="label">{t("admin.settings.field.specialOpenDates")}</label>
        <div className="flex gap-2 flex-wrap items-center mb-2">
          <input type="date" className="input flex-1 min-w-0"
            value={newSpecialDate}
            onChange={(e) => setNewSpecialDate(e.target.value)} />
          <button type="button" onClick={addSpecialDate}
            disabled={!newSpecialDate}
            className="px-3 py-2 rounded-lg bg-brand text-white text-sm font-medium disabled:opacity-50">
            + {t("admin.settings.addSpecialDate")}
          </button>
        </div>
        {form.no_lunch_break_dates.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {form.no_lunch_break_dates.map((d) => (
              <li key={d} className="text-xs px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 flex items-center gap-1">
                {d}
                <button type="button" onClick={() => removeSpecialDate(d)}
                  className="text-emerald-700 hover:text-emerald-900 font-bold">×</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-400">{t("admin.settings.noSpecialDates")}</p>
        )}
        <p className="text-xs text-slate-500 mt-1">{t("admin.settings.specialOpenDatesHint")}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">{t("admin.settings.field.slotMinutes")}</label>
          <input type="number" min={15} max={120} step={15} className="input"
            value={form.slot_minutes}
            onChange={(e) => setForm({ ...form, slot_minutes: Number(e.target.value) })} />
        </div>
        <div>
          <label className="label">{t("admin.settings.field.duration")}</label>
          <input type="number" min={30} max={240} step={15} className="input"
            value={form.default_duration_minutes}
            onChange={(e) => setForm({ ...form, default_duration_minutes: Number(e.target.value) })} />
        </div>
      </div>

      <h2 className="font-semibold pt-3 border-t border-slate-100">{t("admin.settings.notifSection")}</h2>
      <div>
        <label className="label">{t("admin.settings.field.reminderBefore")}</label>
        <input type="number" min={15} max={240} step={15} className="input"
          value={form.reminder_minutes_before}
          onChange={(e) => setForm({ ...form, reminder_minutes_before: Number(e.target.value) })} />
      </div>

      {/* Staff LINE user IDs — list of staff who receive the new-booking
          Flex card. Channel token/secret are managed at the dedicated
          /admin/reserva/messaging page. */}
      <h2 className="font-semibold pt-3 border-t border-slate-100">
        {t("admin.settings.staffLineSection")}
      </h2>
      <p className="text-sm text-slate-500">
        {t("admin.settings.staffLineDesc")}
      </p>
      <div>
        <label className="label">{t("admin.settings.field.staffLineIds")}</label>
        <textarea className="input text-xs" rows={3}
          value={form.staff_line_user_ids}
          onChange={(e) => setForm({ ...form, staff_line_user_ids: e.target.value })}
          placeholder='["U1234abcd...","U5678efgh..."]' />
        <p className="text-xs text-slate-500 mt-1">{t("admin.settings.staffLineIdsHint")}</p>
      </div>

      {/* Fallback phone for the customer's pending-confirmation LINE
          message. Shown so the customer can call the restaurant if their
          booking doesn't get confirmed in a reasonable timeframe. The
          message omits the line entirely when this is blank. */}
      <h2 className="font-semibold pt-3 border-t border-slate-100">
        {t("admin.settings.contactPhoneSection")}
      </h2>
      <p className="text-sm text-slate-500">
        {t("admin.settings.contactPhoneDesc")}
      </p>
      <div>
        <label className="label">{t("admin.settings.field.contactPhone")}</label>
        <input className="input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={form.contact_phone} maxLength={40}
          onChange={(e) => setForm({ ...form, contact_phone: e.target.value })}
          placeholder="038-xxx-xxxx" />
        <p className="text-xs text-slate-500 mt-1">
          {t("admin.settings.contactPhoneHint")}
        </p>
      </div>

      {/* Optional 'เมนูอาหาร / Menu' button on the customer's LINE Flex
          card. Label is fixed per language so it changes when customers
          flip the language toggle; admin only configures the URL.
          Leave blank to hide the button entirely. */}
      <h2 className="font-semibold pt-3 border-t border-slate-100">
        {t("admin.settings.menuBtnSection")}
      </h2>
      <p className="text-sm text-slate-500">
        {t("admin.settings.menuBtnDesc")}
      </p>
      <div>
        <label className="label">{t("admin.settings.field.menuBtnUrl")}</label>
        <input className="input"
          type="url"
          value={form.extra_button_url} maxLength={500}
          onChange={(e) => setForm({ ...form, extra_button_url: e.target.value })}
          placeholder="https://drive.google.com/..." />
        <p className="text-xs text-slate-500 mt-1">
          {t("admin.settings.menuBtnHint")}
        </p>
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}
      {ok && <div className="text-emerald-600 text-sm">{t("admin.settings.saved")}</div>}
      <button className="btn-primary" disabled={busy}>
        {busy ? t("admin.settings.saving") : t("admin.settings.save")}
      </button>
    </form>
  );
}
