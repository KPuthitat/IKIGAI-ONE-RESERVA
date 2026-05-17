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
  // Drives the Quick Actions section in the edit modal: pending_invite
  // shows "ดูลิงก์เชิญ" (re-display original onboard link), active shows
  // password-reset + LINE-rebind affordances. Disabled rows are filtered
  // out at the page-server query level so they never reach this client.
  status: "active" | "pending_invite" | "disabled";
  title_prefix: string | null;
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
    // Admins are employees too — show their pay rate like staff
    // (falls through to "—" if employment_type/rate isn't set yet).
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

  const [titlePrefix, setTitlePrefix] = useState<string>(employee.title_prefix ?? "");
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

  // ── Invite Actions state ────────────────────────────────────────
  // Three buttons surface from the API at /api/admin/persona/employees/[id]/invite-link:
  //   • "ดูลิงก์เชิญ" (pending_invite users) — GET, reuses existing valid invite
  //     or issues a fresh `onboard` one. Lets admin re-show a link they
  //     closed before sending to staff.
  //   • "ออกลิงก์รีเซ็ตรหัสผ่าน" (active users) — POST kind=reset.
  //   • "ออกลิงก์ผูก LINE ใหม่" (active users) — POST kind=rebind_line.
  //     Used when staff changes LINE account or admin needs to fix a
  //     misplaced binding (e.g. bound to the wrong user during testing).
  type InviteLinkResp = {
    invite_id: number;
    kind: "onboard" | "reset" | "rebind_line";
    token: string;
    expires_at: string;
    url: string;
    liff_url: string | null;
    direct_url: string;
    reused: boolean;
  };
  const [inviteLinkResp, setInviteLinkResp] = useState<InviteLinkResp | null>(null);
  const [inviteLinkBusy, setInviteLinkBusy] = useState<"show" | "reset" | "rebind" | null>(null);

  // ── Danger Zone state ───────────────────────────────────────────
  // Two-step confirm to keep accidental clicks from disabling a staff
  // (and dropping their LINE binding). First click sets confirmDelete;
  // second click actually runs the DELETE.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function copyToClipboard(text: string | null): Promise<void> {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // best-effort — older browsers / insecure contexts will simply fail silently
    }
  }

  async function loadInviteLink(): Promise<void> {
    setErr(null);
    setInviteLinkBusy("show");
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/employees/${employee.id}/invite-link`)
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setErr(j?.error ?? t("common.error"));
        return;
      }
      setInviteLinkResp(j as InviteLinkResp);
    } finally {
      setInviteLinkBusy(null);
    }
  }

  async function regenerateInvite(kind: "reset" | "rebind_line"): Promise<void> {
    setErr(null);
    setInviteLinkBusy(kind === "reset" ? "reset" : "rebind");
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/employees/${employee.id}/invite-link?kind=${kind}`),
        { method: "POST" }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setErr(j?.error ?? t("common.error"));
        return;
      }
      setInviteLinkResp(j as InviteLinkResp);
    } finally {
      setInviteLinkBusy(null);
    }
  }

  async function disableUser(): Promise<void> {
    setErr(null);
    setDeleteBusy(true);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/employees/${employee.id}`),
        { method: "DELETE" }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        setErr(j?.error ?? t("common.error"));
        setConfirmDelete(false);
        return;
      }
      onSaved();
    } finally {
      setDeleteBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string | number | number[] | null> = {
        title_prefix: titlePrefix || null,
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
            {employee.status === "pending_invite" && (
              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                ยังไม่ได้ลงทะเบียน
              </span>
            )}
          </p>
        </div>

        {/* ── Quick Actions — invite link management ─────────────────
            Surfaces whichever invite-issuing affordances make sense for
            the user's current lifecycle state. Hidden for disabled rows
            (they don't reach this client anyway, but guard for safety). */}
        {employee.status !== "disabled" && (
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
            <div className="text-xs font-bold text-slate-700">บัญชี + ลิงก์เชิญ</div>
            <div className="flex flex-wrap gap-2">
              {employee.status === "pending_invite" && (
                <button type="button"
                  onClick={loadInviteLink}
                  disabled={inviteLinkBusy !== null}
                  className="text-xs px-3 py-1.5 rounded-lg bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50">
                  {inviteLinkBusy === "show" ? "กำลังโหลด..." : "ดูลิงก์เชิญ"}
                </button>
              )}
              {employee.status === "active" && (
                <>
                  <button type="button"
                    onClick={() => regenerateInvite("reset")}
                    disabled={inviteLinkBusy !== null}
                    className="text-xs px-3 py-1.5 rounded-lg border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 font-medium disabled:opacity-50">
                    {inviteLinkBusy === "reset" ? "กำลังออก..." : "ออกลิงก์รีเซ็ตรหัสผ่าน"}
                  </button>
                  <button type="button"
                    onClick={() => regenerateInvite("rebind_line")}
                    disabled={inviteLinkBusy !== null}
                    className="text-xs px-3 py-1.5 rounded-lg border border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 font-medium disabled:opacity-50">
                    {inviteLinkBusy === "rebind" ? "กำลังออก..." : "ออกลิงก์ผูก LINE ใหม่"}
                  </button>
                </>
              )}
            </div>
            <p className="text-[10px] text-slate-500 leading-snug">
              {employee.status === "pending_invite"
                ? "พนักงานยังไม่ได้ตั้งรหัสผ่าน — กดเพื่อดู/ออกลิงก์เชิญส่งทาง LINE"
                : "ใช้เมื่อพนักงานลืมรหัสผ่าน หรือเปลี่ยน LINE account ใหม่"}
            </p>
          </div>
        )}

        <div>
          <label className="label">คำนำหน้าชื่อ</label>
          <select className="input" value={titlePrefix}
            onChange={(e) => setTitlePrefix(e.target.value)}>
            <option value="">— ไม่ระบุ —</option>
            <option value="นาย">นาย</option>
            <option value="นาง">นาง</option>
            <option value="นางสาว">นางสาว</option>
          </select>
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
        {/* Admins are employees too — they get the same Schedule /
            Payroll / identity fields as regular staff. */}
        {(employee.role === "staff" || employee.role === "admin") && (
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
                  className="input"
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
        {/* Admins are employees too — they get the same Schedule /
            Payroll / identity fields as regular staff. */}
        {(employee.role === "staff" || employee.role === "admin") && (
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
            className="input text-xs"
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

        {/* ── Danger Zone — soft-delete (status='disabled') ──────────
            Doesn't hard-delete the users row because too many tables
            (bookings, payroll, audit) reference users(id). The backend
            DELETE just flips status + clears LINE binding + kills
            sessions + revokes invites — see route.ts comment for the
            full rationale. Two-step confirm via local state to avoid
            accidental clicks. */}
        <div className="border-t border-rose-200 pt-4">
          <h4 className="text-sm font-semibold text-rose-700 mb-2">
            ลบบัญชีพนักงาน
          </h4>
          <p className="text-xs text-slate-600 mb-2 leading-snug">
            บัญชีจะถูกระงับ (status=disabled), ลบการผูก LINE, ปิด session
            ที่ใช้งานอยู่ และยกเลิกลิงก์เชิญที่ยังไม่ได้ใช้
            <br />
            <span className="text-slate-500">
              ข้อมูล payroll / ประวัติการจอง / audit log ยังคงอยู่
              เพื่อรักษาประวัติ
            </span>
          </p>
          {!confirmDelete ? (
            <button type="button"
              onClick={() => setConfirmDelete(true)}
              disabled={busy || deleteBusy}
              className="w-full py-2 rounded-lg border border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100 text-sm font-medium disabled:opacity-50">
              ลบบัญชี {employee.display_name}
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-rose-700 font-bold">
                ยืนยันลบ {employee.display_name} (@{employee.username}) ใช่ไหม?
              </p>
              <div className="flex gap-2">
                <button type="button"
                  onClick={() => setConfirmDelete(false)}
                  disabled={deleteBusy}
                  className="flex-1 py-2 rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50 text-xs">
                  ยกเลิก
                </button>
                <button type="button"
                  onClick={disableUser}
                  disabled={deleteBusy}
                  className="flex-1 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold disabled:opacity-50">
                  {deleteBusy ? "กำลังลบ..." : "ยืนยันลบ"}
                </button>
              </div>
            </div>
          )}
        </div>

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

      {/* ── Invite link overlay ─────────────────────────────────────
          Stacked on top of the EditModal (z-60) when admin clicks one
          of the invite-action buttons. Shows the LIFF + direct URLs +
          copy buttons. Closing returns to the form. Note we don't
          router.refresh() here — the user's lifecycle state doesn't
          change just because we issued a new invite. */}
      {inviteLinkResp && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setInviteLinkResp(null)}>
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-5 space-y-3 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-4xl">✓</div>
              <h3 className="font-bold text-slate-800 text-lg mt-2">
                {inviteLinkResp.reused
                  ? "ลิงก์เชิญที่มีอยู่"
                  : "ออกลิงก์เชิญใหม่เรียบร้อย"}
              </h3>
              <p className="text-xs text-slate-500 mt-1">
                ประเภท: <span className="font-medium">
                  {inviteLinkResp.kind === "onboard" && "ลงทะเบียนครั้งแรก"}
                  {inviteLinkResp.kind === "reset" && "รีเซ็ตรหัสผ่าน"}
                  {inviteLinkResp.kind === "rebind_line" && "ผูก LINE ใหม่"}
                </span>
                <br />
                หมดอายุ {new Date(inviteLinkResp.expires_at).toISOString().slice(0, 10)}
              </p>
            </div>

            {/* Plain direct link only — the LIFF-wrapped link blank-paged
                on some devices. Workflow: staff redeems via this link,
                then admin binds LINE userId manually from the portal
                not_bound screen. */}
            <div>
              <div className="text-[11px] text-slate-500 mb-1 font-bold">
                ลิงก์เชิญ — ส่งให้พนักงานเปิดในเบราว์เซอร์
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs break-all select-all">
                {inviteLinkResp.direct_url}
              </div>
              <button type="button"
                onClick={() => copyToClipboard(inviteLinkResp.direct_url)}
                className="w-full mt-2 py-2 rounded-lg border border-brand text-brand text-xs font-bold hover:bg-rose-50">
                📋 คัดลอกลิงก์
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[11px] text-amber-800 leading-snug">
              หลังพนักงานลงทะเบียนเสร็จ → ให้กดปุ่มริชเมนู → หน้าจอแสดง
              LINE ID → ส่งให้แอดมินวางในช่อง "LINE binding" ของพนักงาน
              เพื่อเปิดล็อกอินอัตโนมัติผ่านริชเมนู
            </div>

            <button type="button"
              onClick={() => setInviteLinkResp(null)}
              className="w-full py-2.5 rounded-lg bg-brand text-white text-sm font-bold">
              ปิด
            </button>
            <p className="text-[10px] text-slate-400 text-center">
              หมายเหตุ: ลิงก์ใช้ได้ครั้งเดียว — ส่งให้เฉพาะคนที่ต้องการเท่านั้น
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
