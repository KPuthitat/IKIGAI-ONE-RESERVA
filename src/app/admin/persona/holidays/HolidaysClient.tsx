"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { useConfirm } from "@/app/components/useConfirm";
import Switch from "@/app/components/Switch";

export type HolidayRow = {
  date: string;
  name_th: string;
  double_pay: number;
  name_en: string;
  is_workday: number;
  pt_special: number;
};

export default function HolidaysClient({
  holidays,
  currentYear,
  yearList
}: {
  holidays: HolidayRow[];
  currentYear: string;
  yearList: string[];
}) {
  const router = useRouter();
  const { t, formatDate, lang } = useLang();
  const [pending, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<HolidayRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const { confirm, alert, ConfirmDialog } = useConfirm();

  async function deleteHoliday(date: string) {
    const ok = await confirm({
      title: t("admin.persona.holidays.confirmDeleteTitle"),
      body: <p>{t("admin.persona.holidays.confirmDelete")}</p>,
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
      variant: "danger"
    });
    if (ok === null) return;
    const res = await fetch(apiUrl(`/api/admin/persona/holidays/${date}`), { method: "DELETE" });
    if (res.ok) startTransition(() => router.refresh());
    else {
      const j = await res.json().catch(() => ({}));
      alert({
        title: t("common.error"),
        body: <p>{j.error ?? t("common.error")}</p>,
        variant: "danger",
        okLabel: t("common.confirm")
      });
    }
  }

  return (
    <>
      <div className="card flex flex-wrap items-center gap-2">
        <span className="text-sm text-slate-600">{t("admin.persona.holidays.year")}:</span>
        {yearList.map((y) => {
          const active = y === currentYear;
          return (
            <Link
              key={y}
              href={`/admin/persona/holidays?year=${y}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                active ? "bg-brand text-white border-brand" : "bg-white text-slate-700 border-slate-200 hover:border-brand"
              }`}
            >
              {y}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="ml-auto px-3 py-1.5 rounded-md text-sm font-medium bg-brand text-white hover:opacity-90"
        >
          + {t("admin.persona.holidays.add")}
        </button>
      </div>

      <div className="card overflow-x-auto">
        <h2 className="font-semibold text-slate-800 mb-3">
          {t("admin.persona.holidays.listTitle", { year: currentYear })} ({holidays.length})
        </h2>
        {holidays.length === 0 ? (
          <p className="text-slate-500 text-sm py-4 text-center">
            {t("admin.persona.holidays.empty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b">
                <th className="py-2 pr-3">{t("admin.persona.holidays.col.date")}</th>
                <th className="py-2 pr-3">{t("admin.persona.holidays.col.nameTh")}</th>
                <th className="py-2 pr-3">{t("admin.persona.holidays.col.nameEn")}</th>
                <th className="py-2 pr-3">{t("admin.persona.holidays.col.workday")}</th>
                <th className="py-2 pr-3">วันพิเศษ PT</th>
                <th className="py-2 pr-3">จ่าย 2 เท่า</th>
                <th className="py-2 pr-3 w-32"></th>
              </tr>
            </thead>
            <tbody>
              {holidays.map((h) => (
                <tr key={h.date} className="border-b last:border-0 hover:bg-slate-50">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {h.date}
                    <div className="text-xs text-slate-400 mt-0.5">{formatDate(h.date)}</div>
                  </td>
                  <td className="py-2 pr-3">{h.name_th}</td>
                  <td className="py-2 pr-3">{h.name_en}</td>
                  <td className="py-2 pr-3">
                    {h.is_workday
                      ? <span className="text-xs px-2 py-0.5 rounded font-medium bg-sky-100 text-sky-700">
                          {t("admin.persona.holidays.isWorkday")}
                        </span>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {h.pt_special
                      ? <span className="text-xs px-2 py-0.5 rounded font-medium bg-violet-100 text-violet-700">
                          ×1.5
                        </span>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {h.double_pay
                      ? <span className="text-xs px-2 py-0.5 rounded font-medium bg-rose-100 text-rose-700">
                          ×2 ทุกคน
                        </span>
                      : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditTarget(h)}
                      className="text-xs text-brand hover:underline mr-3"
                    >
                      {t("admin.persona.holidays.edit")}
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => deleteHoliday(h.date)}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      {t("admin.persona.holidays.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {(editTarget || showAdd) && (
        <HolidayModal
          existing={editTarget}
          onClose={() => { setEditTarget(null); setShowAdd(false); }}
          onSaved={() => {
            setEditTarget(null);
            setShowAdd(false);
            startTransition(() => router.refresh());
          }}
        />
      )}
      {ConfirmDialog}
    </>
  );
}

function HolidayModal({
  existing, onClose, onSaved
}: {
  existing: HolidayRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLang();
  const [date, setDate] = useState(existing?.date ?? "");
  const [nameTh, setNameTh] = useState(existing?.name_th ?? "");
  const [nameEn, setNameEn] = useState(existing?.name_en ?? "");
  const [isWorkday, setIsWorkday] = useState(Boolean(existing?.is_workday));
  const [ptSpecial, setPtSpecial] = useState(Boolean(existing?.pt_special));
  const [doublePay, setDoublePay] = useState(Boolean(existing?.double_pay));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setErr(t("admin.persona.holidays.err.invalidDate")); return; }
    if (!nameTh.trim() || !nameEn.trim()) { setErr(t("admin.persona.holidays.err.nameRequired")); return; }
    setBusy(true);
    try {
      const res = await fetch(apiUrl("/api/admin/persona/holidays"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, name_th: nameTh, name_en: nameEn, is_workday: isWorkday, pt_special: ptSpecial, double_pay: doublePay })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) onSaved();
      else setErr(j?.error ?? t("common.error"));
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-semibold text-slate-800">
          {existing ? t("admin.persona.holidays.editTitle") : t("admin.persona.holidays.addTitle")}
        </h3>

        <div>
          <label className="label">{t("admin.persona.holidays.col.date")}</label>
          <input
            type="date" className="input" value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={Boolean(existing)}
          />
          {existing && <p className="text-xs text-slate-500 mt-1">{t("admin.persona.holidays.dateImmutable")}</p>}
        </div>
        <div>
          <label className="label">{t("admin.persona.holidays.col.nameTh")}</label>
          <input className="input" value={nameTh} onChange={(e) => setNameTh(e.target.value)} maxLength={200} />
        </div>
        <div>
          <label className="label">{t("admin.persona.holidays.col.nameEn")}</label>
          <input className="input" value={nameEn} onChange={(e) => setNameEn(e.target.value)} maxLength={200} />
        </div>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <span className="mt-0.5">
            <Switch checked={isWorkday} onChange={setIsWorkday} />
          </span>
          <span className="text-slate-700">
            {t("admin.persona.holidays.isWorkdayLabel")}
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <span className="mt-0.5">
            <Switch checked={ptSpecial} onChange={setPtSpecial} />
          </span>
          <span className="text-slate-700">
            วันพิเศษพนักงานพาร์ทไทม์ (จ่ายค่าตอบแทน 1.5 เท่า)
            <span className="block text-[11px] text-slate-400">
              แยกจากวันหยุดราชการ — บริษัทกำหนด ~13 วัน/ปี · วันหยุดราชการทั่วไปไม่ได้เรทพิเศษ
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <span className="mt-0.5">
            <Switch checked={doublePay} onChange={setDoublePay} />
          </span>
          <span className="text-slate-700">
            วันจ่ายสองเท่า (พนักงานทุกคน จ่าย 2 เท่า)
            <span className="block text-[11px] text-slate-400">
              พนักงานทุกคนที่ทำงานวันนี้ได้ทั้งค่าตอบแทนฐานและค่าล่วงเวลา ×2 · มีผลเฉพาะวันที่ตั้งไว้
            </span>
          </span>
        </label>

        {err && <div className="text-rose-600 text-sm">{err}</div>}

        <div className="flex gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-sm font-medium">
            {t("common.cancel")}
          </button>
          <button type="button" onClick={save} disabled={busy}
            className="flex-1 py-2.5 rounded-lg bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
            {busy ? t("common.submitting") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
