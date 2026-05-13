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
  weekly_off_days: string | null;     // CSV of digits, e.g. "1,2"
  employee_code: string | null;
  national_id: string | null;
  bank_name: string | null;
  bank_account: string | null;
  tax_id: string | null;
  sso_id: string | null;
  hourly_rate: number | null;
  monthly_salary: number | null;
  pay_cycle: "weekly" | "monthly" | null;
  salary_tax_mode: "sso" | "wht" | null;
  line_user_id: string | null;
  shift_start_time: string | null;
  has_pin: number;
  resign_unlocked: number;
};

const DAY_NAMES_TH = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const DAY_NAMES_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT_TH = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const DAY_SHORT_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseWeeklyOffCsv(csv: string | null): number[] {
  if (!csv || !csv.trim()) return [];
  return csv.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .sort((a, b) => a - b);
}

export default function EmployeesClient({ employees }: { employees: EmployeeRow[] }) {
  const router = useRouter();
  const { t, formatDate, lang } = useLang();
  const [pending, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<EmployeeRow | null>(null);

  function formatGender(g: string | null): string {
    if (!g) return "—";
    return g === "male" ? t("admin.persona.employees.gender.male") : t("admin.persona.employees.gender.female");
  }
  function formatEmployment(e: string | null): string {
    if (!e) return "—";
    return e === "ft" ? t("admin.persona.employees.employment.ft") : t("admin.persona.employees.employment.pt");
  }
  function formatWeeklyOff(csv: string | null): string {
    const days = parseWeeklyOffCsv(csv);
    if (days.length === 0) return "—";
    const shorts = lang === "en" ? DAY_SHORT_EN : DAY_SHORT_TH;
    return days.map((d) => shorts[d]).join(", ");
  }
  function formatPayRate(u: EmployeeRow) {
    if (u.role === "admin") return <span className="text-slate-300">—</span>;
    const taxBadge = u.salary_tax_mode === "wht" ? (
      <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700"
        title={t("admin.persona.employees.taxMode.whtShort")}>
        {t("admin.persona.employees.taxMode.whtTag")}
      </span>
    ) : null;
    if (u.employment_type === "pt") {
      const r = u.hourly_rate;
      if (r == null) return <span className="text-amber-600 text-xs">{t("admin.persona.employees.payRateUnset")}{taxBadge}</span>;
      return (
        <span>
          <span className="font-medium">{r.toFixed(0)}</span>{" "}
          <span className="text-xs text-slate-500">{t("admin.persona.employees.bahtPerHour")}</span>
          {taxBadge}
        </span>
      );
    }
    if (u.employment_type === "ft") {
      const s = u.monthly_salary;
      if (s == null) return <span className="text-amber-600 text-xs">{t("admin.persona.employees.payRateUnset")}{taxBadge}</span>;
      const cycleLabel = u.pay_cycle === "weekly"
        ? t("admin.persona.employees.cycleWeekly")
        : t("admin.persona.employees.cycleMonthly");
      return (
        <span>
          <span className="font-medium">{s.toLocaleString()}</span>
          <span className="text-xs text-slate-500"> /{cycleLabel}</span>
          {taxBadge}
        </span>
      );
    }
    return <span className="text-slate-300">—</span>;
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
              <th className="py-2 pr-3">{t("admin.persona.employees.col.payRate")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.pin")}</th>
              <th className="py-2 pr-3 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((u) => {
              const incomplete = u.role === "staff" && (!u.gender || !u.employment_type || !u.hire_date || parseWeeklyOffCsv(u.weekly_off_days).length === 0);
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
                  <td className="py-2 pr-3 text-slate-700">{formatWeeklyOff(u.weekly_off_days)}</td>
                  <td className="py-2 pr-3 text-slate-700">
                    {u.hire_date ? formatDate(u.hire_date) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{formatPayRate(u)}</td>
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
  const [weeklyOffDays, setWeeklyOffDays] = useState<number[]>(
    parseWeeklyOffCsv(employee.weekly_off_days)
  );
  function toggleOffDay(day: number): void {
    setWeeklyOffDays((prev) => prev.includes(day)
      ? prev.filter((d) => d !== day)
      : [...prev, day].sort((a, b) => a - b)
    );
  }
  // Phase 1D — Payroll fields
  const [employeeCode, setEmployeeCode] = useState<string>(employee.employee_code ?? "");
  const [nationalId, setNationalId] = useState<string>(employee.national_id ?? "");
  const [taxId, setTaxId] = useState<string>(employee.tax_id ?? "");
  const [ssoId, setSsoId] = useState<string>(employee.sso_id ?? "");
  const [bankName, setBankName] = useState<string>(employee.bank_name ?? "");
  const [bankAccount, setBankAccount] = useState<string>(employee.bank_account ?? "");
  const [hourlyRate, setHourlyRate] = useState<string>(
    employee.hourly_rate == null ? "" : String(employee.hourly_rate)
  );
  const [monthlySalary, setMonthlySalary] = useState<string>(
    employee.monthly_salary == null ? "" : String(employee.monthly_salary)
  );
  const [payCycle, setPayCycle] = useState<"weekly" | "monthly" | "">(employee.pay_cycle ?? "");
  const [taxMode, setTaxMode] = useState<"sso" | "wht">(employee.salary_tax_mode ?? "sso");
  const [lineUserId, setLineUserId] = useState<string>(employee.line_user_id ?? "");
  // Expected shift start "HH:MM" — drives late-detection. Empty = unset (no
  // lateness computed for this staff member). Admin can set per-employee
  // since shifts vary (kitchen 09:00, FOH 10:30, etc.).
  const [shiftStartTime, setShiftStartTime] = useState<string>(employee.shift_start_time ?? "");
  // PIN — 4 digits. Empty = leave unchanged. "clear" toggles → send "" to API.
  const [pin, setPin] = useState("");
  const [clearPin, setClearPin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string | number | number[] | null> = {
        gender: gender || null,
        employment_type: employmentType || null,
        hire_date: hireDate || null,
        weekly_off_days: weeklyOffDays.length === 0 ? null : weeklyOffDays,
        employee_code: employeeCode.trim() || null,
        national_id: nationalId.trim() || null,
        tax_id: taxId.trim() || null,
        sso_id: ssoId.trim() || null,
        bank_name: bankName.trim() || null,
        bank_account: bankAccount.trim() || null,
        hourly_rate: hourlyRate.trim() === "" ? null : Number(hourlyRate),
        monthly_salary: monthlySalary.trim() === "" ? null : Number(monthlySalary),
        pay_cycle: payCycle || null,
        salary_tax_mode: taxMode,
        line_user_id: lineUserId.trim() || null,
        shift_start_time: shiftStartTime.trim() === "" ? null : shiftStartTime.trim()
      };
      // PIN — only include if admin is setting/clearing it
      if (clearPin) {
        body.pin = "";
      } else if (pin.length === 4) {
        body.pin = pin;
      }
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
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
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
          <div className="grid grid-cols-7 gap-1">
            {dayNames.map((d, i) => {
              const checked = weeklyOffDays.includes(i);
              return (
                <label
                  key={i}
                  className={`flex flex-col items-center gap-1 border rounded-lg px-2 py-2 cursor-pointer transition text-xs ${
                    checked
                      ? "border-brand bg-rose-50/40 ring-1 ring-brand/30 text-slate-800"
                      : "border-slate-200 hover:bg-slate-50 text-slate-600"
                  }`}
                  title={d}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => toggleOffDay(i)}
                  />
                  <span className={`w-5 h-5 rounded flex items-center justify-center text-[11px] font-medium ${
                    checked ? "bg-brand text-white" : "bg-slate-100 text-slate-400"
                  }`}>
                    {checked ? "✓" : ""}
                  </span>
                  <span>{lang === "en" ? DAY_SHORT_EN[i] : DAY_SHORT_TH[i]}</span>
                </label>
              );
            })}
          </div>
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

        {/* ── Schedule / Time Clock — only relevant for staff who clock in.
            shift_start_time feeds the late-detection engine (5-min grace,
            >20% monthly minutes-late = no service charge). Leaving it
            unset disables late computation for this user, which is the
            right default for admins or staff without a fixed start time. */}
        {employee.role === "staff" && (
          <div className="border-t border-slate-200 pt-4">
            <h4 className="text-sm font-semibold text-slate-700 mb-2">
              {t("admin.persona.employees.section.schedule")}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">
                  {t("admin.persona.employees.field.shiftStartTime")}
                </label>
                <input
                  type="time"
                  className="input font-mono"
                  value={shiftStartTime}
                  onChange={(e) => setShiftStartTime(e.target.value)}
                  step={60}
                />
                <p className="text-xs text-slate-500 mt-1">
                  {t("admin.persona.employees.shiftStartTimeHint")}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Payroll section (Phase 1D) ───────────────────────────── */}
        {employee.role === "staff" && (
          <>
            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-2">
                {t("admin.persona.employees.section.identity")}
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t("admin.persona.employees.field.employeeCode")}</label>
                  <input className="input" type="text" value={employeeCode}
                    onChange={(e) => setEmployeeCode(e.target.value)}
                    placeholder="e.g. NM001" />
                </div>
                <div>
                  <label className="label">{t("admin.persona.employees.field.nationalId")}</label>
                  <input className="input" type="text" value={nationalId}
                    onChange={(e) => setNationalId(e.target.value)}
                    inputMode="numeric" maxLength={13} placeholder="13 digits" />
                </div>
                <div>
                  <label className="label">{t("admin.persona.employees.field.taxId")}</label>
                  <input className="input" type="text" value={taxId}
                    onChange={(e) => setTaxId(e.target.value)} />
                </div>
                <div>
                  <label className="label">{t("admin.persona.employees.field.ssoId")}</label>
                  <input className="input" type="text" value={ssoId}
                    onChange={(e) => setSsoId(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-2">
                {t("admin.persona.employees.section.bank")}
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">{t("admin.persona.employees.field.bankName")}</label>
                  <input className="input" type="text" value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                    placeholder="KTB / SCB / BBL ..." />
                </div>
                <div>
                  <label className="label">{t("admin.persona.employees.field.bankAccount")}</label>
                  <input className="input" type="text" value={bankAccount}
                    onChange={(e) => setBankAccount(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-2">
                {t("admin.persona.employees.section.payRate")}
              </h4>
              {employmentType === "pt" && (
                <div>
                  <label className="label">{t("admin.persona.employees.field.hourlyRate")}</label>
                  <div className="flex items-center gap-2">
                    <input className="input" type="number" step="1" min="0"
                      value={hourlyRate}
                      onChange={(e) => setHourlyRate(e.target.value)}
                      placeholder="50" />
                    <span className="text-sm text-slate-500 whitespace-nowrap">
                      {t("admin.persona.employees.bahtPerHour")}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {t("admin.persona.employees.hourlyRateHint")}
                  </p>
                </div>
              )}
              {employmentType === "ft" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">{t("admin.persona.employees.field.monthlySalary")}</label>
                    <div className="flex items-center gap-2">
                      <input className="input" type="number" step="1" min="0"
                        value={monthlySalary}
                        onChange={(e) => setMonthlySalary(e.target.value)} />
                      <span className="text-sm text-slate-500">บาท</span>
                    </div>
                  </div>
                  <div>
                    <label className="label">{t("admin.persona.employees.field.payCycle")}</label>
                    <select className="input" value={payCycle}
                      onChange={(e) => setPayCycle(e.target.value as "weekly" | "monthly" | "")}>
                      <option value="">— {t("admin.persona.employees.unset")} —</option>
                      <option value="weekly">{t("admin.persona.employees.cycleWeekly")}</option>
                      <option value="monthly">{t("admin.persona.employees.cycleMonthly")}</option>
                    </select>
                    <p className="text-xs text-slate-500 mt-1">
                      {t("admin.persona.employees.payCycleHint")}
                    </p>
                  </div>
                </div>
              )}
              {employmentType === "" && (
                <p className="text-xs text-amber-700">
                  {t("admin.persona.employees.payRateNeedsType")}
                </p>
              )}
            </div>

            {/* Tax mode (in-system SSO vs out-of-system WHT) */}
            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-2">
                {t("admin.persona.employees.section.taxMode")}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <label className={`border rounded-lg p-3 cursor-pointer transition ${
                  taxMode === "sso"
                    ? "border-emerald-400 bg-emerald-50/40 ring-1 ring-emerald-300/50"
                    : "border-slate-200 hover:bg-slate-50"
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <input type="radio" checked={taxMode === "sso"}
                      onChange={() => setTaxMode("sso")} />
                    <span className="font-medium text-slate-800 text-sm">
                      {t("admin.persona.employees.taxMode.sso")}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {t("admin.persona.employees.taxMode.ssoDesc")}
                  </p>
                </label>
                <label className={`border rounded-lg p-3 cursor-pointer transition ${
                  taxMode === "wht"
                    ? "border-amber-400 bg-amber-50/40 ring-1 ring-amber-300/50"
                    : "border-slate-200 hover:bg-slate-50"
                }`}>
                  <div className="flex items-center gap-2 mb-1">
                    <input type="radio" checked={taxMode === "wht"}
                      onChange={() => setTaxMode("wht")} />
                    <span className="font-medium text-slate-800 text-sm">
                      {t("admin.persona.employees.taxMode.wht")}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {t("admin.persona.employees.taxMode.whtDesc")}
                  </p>
                </label>
              </div>
            </div>
          </>
        )}

        {/* LINE binding — staff's userId, used to push the clock-in confirmation card */}
        <div className="border-t border-slate-200 pt-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-2">
            {t("admin.persona.employees.section.line")}
          </h4>
          <p className="text-xs text-slate-500 mb-2">
            {t("admin.persona.employees.lineHint")}
          </p>
          <input
            type="text"
            className="input font-mono text-xs"
            value={lineUserId}
            maxLength={64}
            onChange={(e) => setLineUserId(e.target.value)}
            placeholder="U1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7"
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {/* PIN — 4-digit numeric, used by time clock (staff) + payroll force-open (admin).
            Available for any role so admins can set their own PIN. */}
        <div className="border-t border-slate-200 pt-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-2">
            {t("admin.persona.employees.section.pin")}
          </h4>
          <p className="text-xs text-slate-500 mb-2">
            {t("admin.persona.employees.pinHint")}
            {employee.has_pin === 1 && (
              <span className="ml-1 text-emerald-700 font-medium">
                · {t("admin.persona.employees.pinAlreadySet")}
              </span>
            )}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{t("admin.persona.employees.field.newPin")}</label>
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                className="input tracking-widest text-center text-lg"
                value={pin}
                maxLength={4}
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                  setClearPin(false);
                }}
                placeholder="••••"
                disabled={clearPin}
              />
            </div>
            <div className="flex items-end">
              {employee.has_pin === 1 && (
                <label className="flex items-center gap-2 text-sm text-slate-600 pb-2">
                  <input
                    type="checkbox"
                    checked={clearPin}
                    onChange={(e) => {
                      setClearPin(e.target.checked);
                      if (e.target.checked) setPin("");
                    }}
                  />
                  {t("admin.persona.employees.clearPin")}
                </label>
              )}
            </div>
          </div>
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
