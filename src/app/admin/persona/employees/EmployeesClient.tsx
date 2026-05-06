"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";

export type EmployeeRow = {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "staff";
  gender: "male" | "female" | null;
  employment_type: "pt" | "ft" | null;
  hire_date: string | null;
  weekly_off_day: number | null;
  has_pin: number;
  resign_unlocked: number;
};

const DAY_NAMES_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default function EmployeesClient({ employees }: { employees: EmployeeRow[] }) {
  const router = useRouter();
  const { t, formatDate, lang } = useLang();
  const [pending, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<EmployeeRow | null>(null);

  const dayNames = lang === "en" ? DAY_NAMES_EN : DAY_NAMES_TH;

  function formatGender(g: string | null): string {
    if (!g) return "—";
    return g === "male" ? t("admin.persona.employees.gender.male") : t("admin.persona.employees.gender.female");
  }
  function formatEmployment(e: string | null): string {
    if (!e) return "—";
    return e === "ft" ? t("admin.persona.employees.employment.ft") : t("admin.persona.employees.employment.pt");
  }
  function formatWeeklyOff(d: number | null): string {
    if (d == null) return "—";
    return dayNames[d];
  }

  return (
    <>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3">{t("admin.persona.employees.col.user")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.role")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.gender")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.employment")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.weeklyOff")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.hireDate")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.pin")}</th>
              <th className="py-2 pr-3 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((u) => {
              const incomplete = u.role === "staff" && (!u.gender || !u.employment_type || !u.hire_date || u.weekly_off_day == null);
              return (
                <tr key={u.id} className={`border-b last:border-0 ${incomplete ? "bg-amber-50/50" : "hover:bg-slate-50"}`}>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{u.display_name}</div>
                    <div className="text-xs text-slate-400">@{u.username}</div>
                    {incomplete && (
                      <div className="text-xs text-amber-700 mt-0.5">
                        ⚠ {t("admin.persona.employees.profileIncomplete")}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                      u.role === "admin" ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"
                    }`}>
                      {t(`admin.persona.employees.role.${u.role}` as any)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{formatGender(u.gender)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatEmployment(u.employment_type)}</td>
                  <td className="py-2 pr-3 text-slate-700">{formatWeeklyOff(u.weekly_off_day)}</td>
                  <td className="py-2 pr-3 text-slate-700">
                    {u.hire_date ? formatDate(u.hire_date) : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {u.has_pin
                      ? <span className="text-emerald-600">✓</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <button
                      type="button"
                      onClick={() => setEditTarget(u)}
                      className="text-xs text-brand hover:underline"
                    >
                      {t("admin.persona.employees.edit")}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editTarget && (
        <EditModal
          employee={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </>
  );
}

function EditModal({
  employee, onClose, onSaved
}: {
  employee: EmployeeRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, lang } = useLang();
  const dayNames = lang === "en" ? DAY_NAMES_EN : DAY_NAMES_TH;

  const [gender, setGender] = useState<"male" | "female" | "">(employee.gender ?? "");
  const [employmentType, setEmploymentType] = useState<"pt" | "ft" | "">(employee.employment_type ?? "");
  const [hireDate, setHireDate] = useState<string>(employee.hire_date ?? "");
  const [weeklyOffDay, setWeeklyOffDay] = useState<string>(
    employee.weekly_off_day == null ? "" : String(employee.weekly_off_day)
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string | number | null> = {
        gender: gender || null,
        employment_type: employmentType || null,
        hire_date: hireDate || null,
        weekly_off_day: weeklyOffDay === "" ? null : Number(weeklyOffDay)
      };
      const res = await fetch(apiUrl(`/api/admin/persona/employees/${employee.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        onSaved();
      } else {
        setErr(j?.error ?? t("common.error"));
      }
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="font-semibold text-slate-800">
            {t("admin.persona.employees.editTitle")}
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {employee.display_name} <span className="text-slate-400">@{employee.username}</span>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t("admin.persona.employees.field.gender")}</label>
            <select className="input" value={gender} onChange={(e) => setGender(e.target.value as any)}>
              <option value="">— {t("admin.persona.employees.unset")} —</option>
              <option value="male">{t("admin.persona.employees.gender.male")}</option>
              <option value="female">{t("admin.persona.employees.gender.female")}</option>
            </select>
          </div>
          <div>
            <label className="label">{t("admin.persona.employees.field.employment")}</label>
            <select className="input" value={employmentType} onChange={(e) => setEmploymentType(e.target.value as any)}>
              <option value="">— {t("admin.persona.employees.unset")} —</option>
              <option value="ft">{t("admin.persona.employees.employment.ft")}</option>
              <option value="pt">{t("admin.persona.employees.employment.pt")}</option>
            </select>
          </div>
        </div>

        <div>
          <label className="label">{t("admin.persona.employees.field.weeklyOff")}</label>
          <select className="input" value={weeklyOffDay} onChange={(e) => setWeeklyOffDay(e.target.value)}>
            <option value="">— {t("admin.persona.employees.unset")} —</option>
            {dayNames.map((d, i) => (
              <option key={i} value={String(i)}>{d}</option>
            ))}
          </select>
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.employees.weeklyOffHint")}
          </p>
        </div>

        <div>
          <label className="label">{t("admin.persona.employees.field.hireDate")}</label>
          <input
            type="date" className="input"
            value={hireDate}
            onChange={(e) => setHireDate(e.target.value)}
          />
          <p className="text-xs text-slate-500 mt-1">
            {t("admin.persona.employees.hireDateHint")}
          </p>
        </div>

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
