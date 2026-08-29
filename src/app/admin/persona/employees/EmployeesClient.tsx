"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import { nameWithPrefix } from "@/lib/name";
import { bkkDateIso } from "@/lib/time";
import { fmtMoney } from "@/lib/format";
import Switch from "@/app/components/Switch";
import { RBAC_PERMISSIONS } from "@/lib/rbac";

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
  nickname_th: string | null;
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
  // วันที่เริ่มเป็นประจำ (PT→FT transition date). Drives which payroll table the
  // transition month lands in. NULL on legacy FT converted before this existed.
  ft_started_at: string | null;
  // จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบถึงวันที่ (owner 2026-08-18). NULL = คิดปกติ.
  ft_salary_paid_through?: string | null;
  // 0 = ผู้บริหาร/ไม่ลงเวลา → เงินเดือน fix ไม่มี OT (owner 2026-07-12).
  track_attendance?: number;
  // 0 = ไม่รับส่วนแบ่งเซอร์วิสชาร์จ (แยกจาก track_attendance, owner 2026-07-21).
  receives_service_charge?: number;
  // YYYY-MM ที่เริ่มหักประกันกลุ่มจาก SVC (owner 2026-08-02). null = ยังไม่หัก.
  group_insurance_start_month?: string | null;
  line_user_id: string | null;
  shift_start_time: string | null;
  has_pin: number;
  resign_unlocked: number;
  // Chain-of-command (added 2026-05). Direct manager for approval
  // routing + per-user override for the escalation window. NULL on
  // both = "top of chain" / "use system default".
  reports_to_user_id: number | null;
  escalation_hours: number | null;
  // 2026-05-27 — flag to hide from every operational list (employees
  // table by default, roster picker, payroll run, approval-chain
  // candidates, etc.). Admin can flip via checkbox in edit modal.
  is_test_account: number;
  // 2026-05-30 — PDPA payroll-access grant. 0/1. super_admin sees
  // this as a toggle in the edit modal for admin-role employees;
  // when 1, that admin gains access to the payroll pages + salary
  // columns. Always 0 for staff (they don't see admin pages anyway).
  can_view_payroll?: number;
  // 2026-06-04 — Mounjaro clinical access (super_admin sets in the edit
  // modal). clinical_role 'doctor'|'nurse' + license_no (the doctor's
  // unlock key); is_hr_analytics = sees the program's aggregate stats.
  clinical_role?: "doctor" | "nurse" | null;
  license_no?: string | null;
  is_hr_analytics?: number;
};

export type BranchLite = { id: number; name: string };

/** Turn an API error (esp. zod invalid_body) into a message that names the
 *  offending field(s), so a failed save is diagnosable instead of opaque. */
function apiErrText(j: unknown, fallback: string): string {
  const o = (j ?? {}) as { error?: string; detail?: { fieldErrors?: Record<string, unknown> } };
  if (o.error === "invalid_body" && o.detail?.fieldErrors) {
    const fields = Object.keys(o.detail.fieldErrors);
    if (fields.length) return `ข้อมูลไม่ถูกต้อง: ${fields.join(", ")}`;
  }
  return o.error ?? fallback;
}
export type RoleLite = { id: number; name: string; permissions: string[] };

export default function EmployeesClient({
  employees, allBranches, grants, editableBranchIds,
  currentUserRole, canViewPayroll,
  allRoles = [], roleIdsByUser = {}
}: {
  employees: EmployeeRow[];
  allBranches: BranchLite[];
  grants: Array<{ user_id: number; branch_id: number; is_primary?: number; hourly_rate?: number | null; daily_rate?: number | null }>;
  editableBranchIds: number[];
  currentUserRole: "super_admin" | "admin" | "staff";
  /** PDPA (2026-05-30) — when false, hide salary inputs in the edit
   *  modal and the salary blob in row summaries. Server has already
   *  blanked hourly_rate / monthly_salary / pay_cycle / salary_tax_mode
   *  on every row before we receive them. */
  canViewPayroll: boolean;
  /** RBAC (2026-06-04) — full role catalog + each employee's current
   *  role ids. Only populated for super_admin (the assignment section
   *  in the edit modal is super_admin-only). */
  allRoles?: RoleLite[];
  roleIdsByUser?: Record<number, number[]>;
}) {
  const router = useRouter();
  const { t, formatDate } = useLang();
  const [pending, startTransition] = useTransition();
  const [editTarget, setEditTarget] = useState<EmployeeRow | null>(null);

  // Inline "ไม่ต้องลงเวลา" toggle from the list (owner 2026-08-21): flip
  // track_attendance in one click without opening the edit modal. Optimistic
  // override keyed by user id; reconciled by router.refresh() on success.
  const [attnOverride, setAttnOverride] = useState<Record<number, number>>({});
  const [attnBusy, setAttnBusy] = useState<number | null>(null);
  const trackAttn = (u: EmployeeRow) => attnOverride[u.id] ?? (u.track_attendance ?? 1);
  async function toggleTrackAttn(u: EmployeeRow) {
    if (attnBusy !== null) return;
    const next = trackAttn(u) === 0 ? 1 : 0;
    // FT: track_attendance also drives payroll (0 = fixed salary, no OT).
    // Confirm before changing salary semantics from a one-click toggle.
    if (u.employment_type === "ft") {
      const msg = next === 0
        ? `ตั้ง "${u.display_name}" เป็นไม่ต้องลงเวลา?\n\nพนักงานประจำ: จะคิดเงินเดือนแบบ fix เต็มจำนวน ไม่มีค่าล่วงเวลา (OT) และปิดแจ้งเตือนเข้ากะ`
        : `ให้ "${u.display_name}" กลับมาลงเวลาปกติ?\n\nพนักงานประจำ: จะกลับมาคิดค่าล่วงเวลา (OT) ตามการลงเวลา และเปิดแจ้งเตือนเข้ากะ`;
      if (!window.confirm(msg)) return;
    }
    setAttnBusy(u.id);
    setAttnOverride((m) => ({ ...m, [u.id]: next }));
    try {
      const res = await fetch(apiUrl(`/api/admin/persona/employees/${u.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_attendance: next === 1 })
      });
      const j = await res.json().catch(() => ({}));
      if (j?.ok) {
        // Refresh pulls the authoritative track_attendance back into props;
        // drop the optimistic override so a later change (edit modal, another
        // admin) isn't masked by a stale entry.
        startTransition(() => {
          router.refresh();
          setAttnOverride((m) => { const n = { ...m }; delete n[u.id]; return n; });
        });
      } else {
        setAttnOverride((m) => { const n = { ...m }; delete n[u.id]; return n; });
        alert(apiErrText(j, t("common.error")));
      }
    } catch {
      setAttnOverride((m) => { const n = { ...m }; delete n[u.id]; return n; });
      alert(t("common.error"));
    } finally {
      setAttnBusy(null);
    }
  }

  // ── Filter + sort toolbar ──────────────────────────────────────
  // Search matches across display_name / employee_code / username.
  // Sort defaults to "code" — matches the server's default ORDER BY,
  // so the table looks identical on first render. Role filter is a
  // small chip group above the table.
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"code" | "name" | "role" | "hireDate">("code");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "staff">("all");

  const visibleEmployees = useMemo(() => {
    const term = search.trim().toLowerCase();
    const filtered = employees.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (!term) return true;
      const hay = [
        u.display_name,
        u.employee_code ?? "",
        u.username,
        u.title_prefix ?? ""
      ].join(" ").toLowerCase();
      return hay.includes(term);
    });
    // Stable sort — empty-code rows sink to the bottom for "code"
    // sort so newly-hired staff without codes don't shuffle the list.
    const cmp = (a: EmployeeRow, b: EmployeeRow): number => {
      switch (sortBy) {
        case "code": {
          const ac = (a.employee_code ?? "").trim();
          const bc = (b.employee_code ?? "").trim();
          if (!ac && !bc) return a.display_name.localeCompare(b.display_name);
          if (!ac) return 1;
          if (!bc) return -1;
          return ac.localeCompare(bc, undefined, { numeric: true, sensitivity: "base" });
        }
        case "name":
          return a.display_name.localeCompare(b.display_name);
        case "hireDate": {
          const ad = a.hire_date ?? "";
          const bd = b.hire_date ?? "";
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          return ad.localeCompare(bd);
        }
        case "role":
        default: {
          // admin → staff, then ft → pt → unset, then name.
          const roleRank = (r: string) => (r === "admin" ? 0 : 1);
          const empRank = (e: string | null) =>
            e === "ft" ? 0 : e === "pt" ? 1 : 2;
          const rd = roleRank(a.role) - roleRank(b.role);
          if (rd !== 0) return rd;
          const ed = empRank(a.employment_type) - empRank(b.employment_type);
          if (ed !== 0) return ed;
          return a.display_name.localeCompare(b.display_name);
        }
      }
    };
    return [...filtered].sort(cmp);
  }, [employees, search, sortBy, roleFilter]);

  // userId → branchIds the employee currently belongs to.
  const branchIdsByUser = new Map<number, number[]>();
  // userId → the branch flagged as their home/primary (FT salary lands there).
  const primaryByUser = new Map<number, number>();
  // userId → (branchId → per-branch PT rate). Only branches with a rate set
  // appear; absent = the employee's default hourly_rate is used (owner 2026-08-04).
  const branchRatesByUser = new Map<number, Map<number, number>>();
  // userId → (branchId → cross-company/branch helper day rate) (owner 2026-08-17).
  const branchDailyRatesByUser = new Map<number, Map<number, number>>();
  for (const g of grants) {
    const arr = branchIdsByUser.get(g.user_id) ?? [];
    arr.push(g.branch_id);
    branchIdsByUser.set(g.user_id, arr);
    if (g.is_primary === 1) primaryByUser.set(g.user_id, g.branch_id);
    if (g.hourly_rate != null) {
      const m = branchRatesByUser.get(g.user_id) ?? new Map<number, number>();
      m.set(g.branch_id, g.hourly_rate);
      branchRatesByUser.set(g.user_id, m);
    }
    if (g.daily_rate != null) {
      const m = branchDailyRatesByUser.get(g.user_id) ?? new Map<number, number>();
      m.set(g.branch_id, g.daily_rate);
      branchDailyRatesByUser.set(g.user_id, m);
    }
  }
  const editableSet = new Set(editableBranchIds);

  function formatGender(g: string | null): string {
    if (!g) return "—";
    return g === "male" ? t("admin.persona.employees.gender.male") : t("admin.persona.employees.gender.female");
  }
  function formatEmployment(e: string | null): string {
    if (!e) return "—";
    return e === "ft" ? t("admin.persona.employees.employment.ft") : t("admin.persona.employees.employment.pt");
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
          <span className="font-medium">{fmtMoney(r)}</span>{" "}
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
          <span className="font-medium">{fmtMoney(s)}</span>
          <span className="text-xs text-slate-500"> /{cycleLabel}</span>
          {taxBadge}
        </span>
      );
    }
    return <span className="text-slate-300">—</span>;
  }

  return (
    <>
      {/* Toolbar — search box + role chips + sort dropdown */}
      <div className="card flex flex-wrap items-center gap-3">
        <input
          type="search"
          className="input flex-1 min-w-[220px]"
          placeholder={t("admin.persona.employees.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500 mr-1">
            {t("admin.persona.employees.filterRole")}:
          </span>
          {(["all", "admin", "staff"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRoleFilter(r)}
              className={`text-xs px-2.5 py-1 rounded-full border transition ${
                roleFilter === r
                  ? "bg-brand text-white border-brand"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {r === "all"
                ? t("admin.persona.employees.filterRole.all")
                : t(`admin.persona.employees.role.${r}` as any)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <label htmlFor="emp-sort" className="text-xs text-slate-500 mr-1">
            {t("admin.persona.employees.sortBy")}:
          </label>
          <select
            id="emp-sort"
            className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          >
            <option value="code">{t("admin.persona.employees.sort.code")}</option>
            <option value="name">{t("admin.persona.employees.sort.name")}</option>
            <option value="role">{t("admin.persona.employees.sort.role")}</option>
            <option value="hireDate">{t("admin.persona.employees.sort.hireDate")}</option>
          </select>
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b">
              <th className="py-2 pr-3 w-24">{t("admin.persona.employees.col.code")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.user")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.role")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.gender")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.employment")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.hireDate")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.payRate")}</th>
              <th className="py-2 pr-3">{t("admin.persona.employees.col.pin")}</th>
              <th className="py-2 pr-3">พร้อมแจ้งเตือน</th>
              <th className="py-2 pr-3 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {visibleEmployees.length === 0 && (
              <tr>
                <td colSpan={10} className="py-8 text-center text-sm text-slate-400">
                  {t("admin.persona.employees.noMatch")}
                </td>
              </tr>
            )}
            {visibleEmployees.map((u) => {
              const incomplete = u.role === "staff" && (!u.gender || !u.employment_type || !u.hire_date);
              return (
                <tr key={u.id} className={`border-b last:border-0 ${incomplete ? "bg-amber-50/50" : "hover:bg-slate-50"}`}>
                  <td className="py-2 pr-3 align-top">
                    {u.employee_code?.trim() ? (
                      <span className="font-mono text-xs text-slate-700">{u.employee_code}</span>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="font-medium text-slate-800">{nameWithPrefix(u.title_prefix, u.display_name)}</div>
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
                  <td className="py-2 pr-3 text-slate-700">
                    {u.hire_date ? formatDate(u.hire_date) : "—"}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{formatPayRate(u)}</td>
                  <td className="py-2 pr-3">
                    {u.has_pin
                      ? <span className="text-emerald-600">✓</span>
                      : <span className="text-slate-300">—</span>}
                  </td>
                  {/* Notify-readiness chip — green when LINE bound +
                      nickname set (greeting works), amber when LINE
                      bound but no nickname, red when no LINE (can't
                      DM at all). Saves admin from opening every row
                      to find who still needs to bind LINE. */}
                  <td className="py-2 pr-3">
                    <div className="flex flex-col items-start gap-1.5">
                      {(() => {
                        const exempt = trackAttn(u) === 0;
                        const hasLine = !!u.line_user_id?.trim();
                        const hasNick = !!u.nickname_th?.trim();
                        // Non-clocking staff don't get clock-in reminders at all,
                        // so the LINE-readiness chip is moot — show a neutral tag.
                        if (exempt) {
                          return (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold whitespace-nowrap">
                              ไม่แจ้งเตือน
                            </span>
                          );
                        }
                        if (hasLine && hasNick) {
                          return (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-bold whitespace-nowrap">
                              ✓ ครบ
                            </span>
                          );
                        }
                        if (hasLine && !hasNick) {
                          return (
                            <span
                              className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold whitespace-nowrap"
                              title="เชื่อมต่อ LINE แล้ว แต่ยังไม่มีชื่อเล่น — น้องฮูกจะทักด้วยชื่อจริง"
                            >
                              ⚠ ขาดชื่อเล่น
                            </span>
                          );
                        }
                        return (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700 font-bold whitespace-nowrap"
                            title="ยังไม่เชื่อมต่อ LINE — ไม่ได้รับการแจ้งเตือนทาง LINE"
                          >
                            ✗ ยังไม่เชื่อมต่อ LINE
                          </span>
                        );
                      })()}
                      {/* One-click "ไม่ต้องลงเวลา" toggle (owner 2026-08-21) —
                          ON = exempt: no clock-in DM + not in HR roll-call. */}
                      <label
                        className={`flex items-center gap-1 ${attnBusy === u.id ? "" : "cursor-pointer"}`}
                        title="เปิด = ไม่ต้องลงเวลา → ไม่รับแจ้งเตือนเข้ากะ และไม่ขึ้นในสรุป HR"
                      >
                        <Switch
                          size="sm"
                          accent="rose"
                          checked={trackAttn(u) === 0}
                          disabled={attnBusy === u.id}
                          onChange={() => toggleTrackAttn(u)}
                          aria-label="ไม่ต้องลงเวลา"
                        />
                        <span className="text-[10px] text-slate-500 whitespace-nowrap">ไม่ต้องลงเวลา</span>
                      </label>
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <div className="flex flex-col items-end gap-1">
                      <Link
                        href={`/admin/persona/employees/${u.id}`}
                        className="text-xs text-brand font-medium hover:underline"
                        title={t("admin.persona.employees.fullProfileHint")}
                      >
                        {t("admin.persona.employees.fullProfile")}
                      </Link>
                      <button
                        type="button"
                        onClick={() => setEditTarget(u)}
                        className="text-xs text-slate-500 hover:underline"
                      >
                        {t("admin.persona.employees.edit")}
                      </button>
                    </div>
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
          allEmployees={employees}
          allBranches={allBranches}
          currentBranchIds={branchIdsByUser.get(editTarget.id) ?? []}
          currentPrimary={primaryByUser.get(editTarget.id) ?? null}
          currentBranchRates={branchRatesByUser.get(editTarget.id) ?? new Map()}
          currentBranchDailyRates={branchDailyRatesByUser.get(editTarget.id) ?? new Map()}
          editableSet={editableSet}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            startTransition(() => router.refresh());
          }}
          onRefresh={() => startTransition(() => router.refresh())}
          canViewPayroll={canViewPayroll}
          currentUserRole={currentUserRole}
          allRoles={allRoles}
          assignedRoleIds={roleIdsByUser[editTarget.id] ?? []}
        />
      )}
    </>
  );
}

function EditModal({
  employee, allEmployees, allBranches, currentBranchIds, currentPrimary, currentBranchRates,
  currentBranchDailyRates, editableSet,
  onClose, onSaved, onRefresh, canViewPayroll, currentUserRole,
  allRoles, assignedRoleIds
}: {
  employee: EmployeeRow;
  /** Full employee list — drives the "Reports to" dropdown in the
   *  chain-of-command section. Passed in from the outer component
   *  so the modal doesn't need its own fetch. */
  allEmployees: EmployeeRow[];
  allBranches: BranchLite[];
  currentBranchIds: number[];
  /** The employee's current home/primary branch (FT salary lands there), or
   *  null if unset. Only editable by super_admin. */
  currentPrimary: number | null;
  /** branchId → per-branch PT hourly rate override (owner 2026-08-04). Absent
   *  branch = uses the employee's default hourly_rate. super_admin edits it. */
  currentBranchRates: Map<number, number>;
  /** branchId → cross-company/branch helper day rate (owner 2026-08-17). Set on a
   *  branch of another company the person goes to help; absent = not a helper there. */
  currentBranchDailyRates: Map<number, number>;
  editableSet: Set<number>;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
  /** PDPA — when false, hide the pay-rate + tax-mode sections.
   *  Server has already blanked these fields in `employee`. */
  canViewPayroll: boolean;
  /** Whether the current user is super_admin — they get the extra
   *  "grant payroll access to this admin" toggle, regular admins
   *  cannot grant the permission. */
  currentUserRole: "super_admin" | "admin" | "staff";
  /** RBAC (2026-06-04) — role catalog + this employee's current role
   *  ids. The assignment section renders for super_admin only. */
  allRoles: RoleLite[];
  assignedRoleIds: number[];
}) {
  const { t } = useLang();

  // ── Branch access (สิทธิ์เข้าสาขา) ───────────────────────────────
  // Independent of the main profile save: its own selection + save
  // button, hitting the dedicated endpoint that preserves is_admin.
  const [branchSel, setBranchSel] = useState<Set<number>>(
    new Set(currentBranchIds)
  );
  // Home/primary branch (super_admin only) — FT salary is paid here.
  const [primaryBranch, setPrimaryBranch] = useState<number | null>(currentPrimary);
  // Per-branch PT rate override (super_admin) — branchId → rate string ("" = use
  // default). Seeded from the current overrides (owner 2026-08-04).
  const [branchRates, setBranchRates] = useState<Map<number, string>>(
    new Map([...currentBranchRates].map(([b, r]) => [b, String(r)]))
  );
  const setBranchRate = (bid: number, val: string) =>
    setBranchRates((prev) => { const n = new Map(prev); n.set(bid, val); return n; });
  // Per-branch cross-company/branch HELPER pay (super_admin) — branchId → { mode,
  // value } where mode is 'daily' (บาท/วัน) or 'hourly' (บาท/ชม.). Seeded from the
  // current daily_rate (→ daily) or per-branch hourly_rate (→ hourly). "" value =
  // not a helper at this branch (owner 2026-08-18).
  type HelperRow = { mode: "daily" | "hourly"; value: string };
  const [helperRows, setHelperRows] = useState<Map<number, HelperRow>>(() => {
    const m = new Map<number, HelperRow>();
    for (const [b, r] of currentBranchDailyRates) m.set(b, { mode: "daily", value: String(r) });
    for (const [b, r] of currentBranchRates) if (!m.has(b)) m.set(b, { mode: "hourly", value: String(r) });
    return m;
  });
  const getHelperRow = (bid: number): HelperRow => helperRows.get(bid) ?? { mode: "daily", value: "" };
  const setHelperRow = (bid: number, patch: Partial<HelperRow>) =>
    setHelperRows((prev) => { const n = new Map(prev); n.set(bid, { ...getHelperRow(bid), ...patch }); return n; });
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchMsg, setBranchMsg] = useState<string | null>(null);
  function toggleBranch(bid: number) {
    if (!editableSet.has(bid)) return;
    setBranchSel((prev) => {
      const next = new Set(prev);
      if (next.has(bid)) next.delete(bid); else next.add(bid);
      return next;
    });
  }
  async function saveBranches() {
    setBranchBusy(true);
    setBranchMsg(null);
    try {
      const res = await fetch(
        apiUrl(`/api/admin/persona/employees/${employee.id}/branches`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Guard against a stray null/NaN slipping in from grants data — the
          // server rejects a non-positive-int and the whole save fails.
          body: JSON.stringify({
            branch_ids: [...branchSel].filter((n) => Number.isInteger(n) && n > 0),
            // Home branch — only meaningful/allowed for super_admin (server
            // re-gates). Only send when it's still a selected branch.
            primary_branch_id:
              currentUserRole === "super_admin" && primaryBranch != null && branchSel.has(primaryBranch)
                ? primaryBranch
                : undefined,
            // Per-branch rate overrides — for super_admin + payroll access. The
            // server writes only the fields present, so we send exactly what each
            // employment type controls (owner 2026-08-18):
            //   PT  → per-branch hourly_rate (the existing รายชั่วโมง section).
            //   FT  → the helper box: each non-home branch is รายวัน (daily_rate) or
            //         รายชั่วโมง (hourly_rate); the OTHER field is cleared so switching
            //         mode never leaves a stale rate. blank/0/invalid → not a helper.
            rates: currentUserRole === "super_admin" && canViewPayroll
              ? [...branchSel].map((bid) => {
                  const entry: { branch_id: number; hourly_rate?: number | null; daily_rate?: number | null } = { branch_id: bid };
                  if (employmentType === "pt") {
                    const raw = (branchRates.get(bid) ?? "").trim();
                    if (raw === "") entry.hourly_rate = null;
                    else { const n = Number(raw); if (Number.isFinite(n) && n >= 0) entry.hourly_rate = n; }
                  } else if (employmentType === "ft" && bid !== primaryBranch) {
                    const row = getHelperRow(bid);
                    const n = Number(row.value.trim());
                    const val = (row.value.trim() !== "" && Number.isFinite(n) && n > 0) ? n : null;
                    if (row.mode === "daily") { entry.daily_rate = val; entry.hourly_rate = null; }
                    else { entry.hourly_rate = val; entry.daily_rate = null; }
                  }
                  return entry;
                })
              : undefined
          })
        }
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setBranchMsg(apiErrText(j, t("common.error")));
        return;
      }
      setBranchMsg("saved");
      onRefresh();
    } catch {
      setBranchMsg(t("common.error"));
    } finally {
      setBranchBusy(false);
    }
  }

  const [titlePrefix, setTitlePrefix] = useState<string>(employee.title_prefix ?? "");
  // ชื่อเล่น (Thai nickname) — drives the warm "สวัสดีครับพี่ <ชื่อเล่น>"
  // greeting on the owl shift-reminder Flex. Optional but recommended.
  const [nicknameTh, setNicknameTh] = useState<string>(employee.nickname_th ?? "");
  const [gender, setGender] = useState<"male" | "female" | "">(employee.gender ?? "");
  const [employmentType, setEmploymentType] = useState<"pt" | "ft" | "">(employee.employment_type ?? "");
  // ผู้บริหาร/หัวหน้าที่ไม่ลงเวลา (owner 2026-07-12) — เงินเดือน fix ไม่มี OT.
  const [noClock, setNoClock] = useState<boolean>((employee.track_attendance ?? 1) === 0);
  // ไม่รับส่วนแบ่งเซอร์วิสชาร์จ (owner 2026-07-21) — แยกจาก noClock. ค่าเริ่มต้นรับ (=1).
  const [noSvc, setNoSvc] = useState<boolean>((employee.receives_service_charge ?? 1) === 0);
  // วันที่มีผลของการเปลี่ยน PT→FT (owner 2026-07-13) — ถามทุกครั้งก่อนบันทึก.
  // สำหรับคนที่เป็น FT อยู่แล้ว prefill ด้วย ft_started_at ปัจจุบัน (แก้ย้อนหลังได้ —
  // owner 2026-07-19: ธนะรัตน์ ย้ายก่อนระบบมีฟิลด์นี้ ค่าเลยเป็น NULL คิดเงินผิดตาราง).
  const [ftEffectiveDate, setFtEffectiveDate] = useState<string>(
    employee.ft_started_at ?? new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)
  );
  // จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบถึงวันที่ (owner 2026-08-18) — รอบรายสัปดาห์ที่คร่อม
  // เดือนจะไม่คิดฐานเงินเดือนของวันเปลี่ยนผ่านที่ ≤ วันนี้ (จ่ายด้วยวิธีเก่าแล้ว).
  const [ftSalaryPaidThrough, setFtSalaryPaidThrough] = useState<string>(employee.ft_salary_paid_through ?? "");
  // "วันเริ่มเป็นประจำ" is only meaningful for staff converted FROM part-time
  // (owner 2026-07-21). Born-FT staff (ft_started_at NULL) don't set it — the
  // field stays hidden unless the admin ticks this reveal toggle to backfill a
  // legacy convert that predates the field.
  const [wasPtReveal, setWasPtReveal] = useState<boolean>(false);
  // "เป็นประจำมาแต่แรก (ไม่เคยเป็น PT)" — correct a born-FT wrongly stamped with a
  // PT→FT weekly transition (owner 2026-07-30). Clears ft_started_at + forces
  // monthly on save so they compute as a plain monthly FT.
  const [clearFtTransition, setClearFtTransition] = useState<boolean>(false);
  const [hireDate, setHireDate] = useState<string>(employee.hire_date ?? "");
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
  // pay_cycle is no longer user-selectable: FT = monthly, PT = none
  // (owner 2026-06-09). Coerced at save by employment type.
  const [taxMode, setTaxMode] = useState<"sso" | "wht">(employee.salary_tax_mode ?? "sso");
  // Group-insurance enrolment month (owner 2026-08-02). "" = not enrolled → no
  // ฿350/mo SVC deduction. <input type="month"> value is YYYY-MM.
  const [giStartMonth, setGiStartMonth] = useState<string>(employee.group_insurance_start_month ?? "");
  const [lineUserId, setLineUserId] = useState<string>(employee.line_user_id ?? "");
  // shift_start_time + escalation_hours per-user fields removed
  // 2026-05 (UI deleted in this commit). API still accepts them,
  // and the save body sends null to clear stale rows.
  // Chain-of-command — direct manager only.
  const [reportsToUserId, setReportsToUserId] = useState<string>(
    employee.reports_to_user_id == null ? "" : String(employee.reports_to_user_id)
  );
  // Test-account flag — checkbox in the modal. When true, the row is
  // hidden from every operational list (employees table by default,
  // roster, payroll, approval-chain, etc.).
  const [isTestAccount, setIsTestAccount] = useState<boolean>(
    employee.is_test_account === 1
  );
  // PDPA (2026-05-30) — super_admin only: per-admin payroll access
  // grant. Toggles users.can_view_payroll. Hidden in the modal when
  // the current operator isn't super_admin, and gated again on the
  // server in the PATCH route as defense-in-depth.
  const [canViewPayrollFlag, setCanViewPayrollFlag] = useState<boolean>(
    (employee as EmployeeRow & { can_view_payroll?: number }).can_view_payroll === 1
  );
  // Account role (staff↔admin) — super_admin only. Lets account admin
  // happen here at the พนักงาน menu instead of /admin/reserva/staff
  // (owner 2026-07-13). super_admin targets never editable (see render guard).
  const [roleVal, setRoleVal] = useState<"admin" | "staff">(
    employee.role === "admin" ? "admin" : "staff"
  );
  // Employee-health-data access (super_admin only) — a consulting doctor
  // (license-gated) + an HR aggregate-dashboard viewer. Nurse role was
  // dropped (owner 2026-06-05); a stored 'nurse' shows as none.
  const [clinicalRole, setClinicalRole] = useState<"none" | "doctor">(
    employee.clinical_role === "doctor" ? "doctor" : "none"
  );
  const [licenseNo, setLicenseNo] = useState(employee.license_no ?? "");
  const [hrAnalytics, setHrAnalytics] = useState<boolean>(employee.is_hr_analytics === 1);
  // RBAC (2026-06-04) — module-access roles assigned to this employee
  // (super_admin only). Replaces the full set on save via role_ids.
  const [roleSel, setRoleSel] = useState<Set<number>>(new Set(assignedRoleIds));
  function toggleRole(rid: number) {
    setRoleSel((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid); else next.add(rid);
      return next;
    });
  }
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
  //   • "ออกลิงก์เชื่อมต่อ LINE ใหม่" (active users) — POST kind=rebind_line.
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
    // Two ways to become FT (owner 2026-07-30). A GENUINE PT→FT conversion (was
    // actually 'pt') runs the first-month weekly transition. A BORN-FT hire (from
    // NULL/unclassified) is a plain monthly FT whose first partial month prorates
    // daily by hire_date — no weekly transition, no ft_started_at.
    const isConvertingToFt = employmentType === "ft" && employee.employment_type === "pt";
    const isNewFt = employmentType === "ft" && employee.employment_type !== "ft" && employee.employment_type !== "pt";
    if (isConvertingToFt || isNewFt) {
      const sal = Number(monthlySalary);
      if (monthlySalary.trim() === "" || !Number.isFinite(sal) || sal <= 0) {
        setErr("กรุณากรอกเงินเดือน (บาท/เดือน) ก่อนย้ายเป็นพนักงานประจำ");
        return;
      }
    }
    if (isConvertingToFt && !/^\d{4}-\d{2}-\d{2}$/.test(ftEffectiveDate)) {
      setErr("กรุณาระบุวันที่มีผล (เริ่มเป็นประจำ) ก่อนบันทึก");
      return;
    }
    // A born-FT hire needs a hire date so the first partial month can prorate.
    if (isNewFt && !/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) {
      setErr("กรุณาระบุวันที่เริ่มงาน (เพื่อคำนวณเดือนแรกแบบรายวัน) ก่อนบันทึก");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const body: Record<string, string | number | boolean | number[] | null> = {
        title_prefix: titlePrefix || null,
        nickname_th: nicknameTh.trim() || null,
        gender: gender || null,
        employment_type: employmentType || null,
        hire_date: hireDate || null,
        employee_code: employeeCode.trim() || null,
        national_id: nationalId.trim() || null,
        tax_id: taxId.trim() || null,
        sso_id: ssoId.trim() || null,
        bank_name: bankName.trim() || null,
        bank_account: bankAccount.trim() || null,
        hourly_rate: hourlyRate.trim() === "" ? null : Number(hourlyRate),
        monthly_salary: monthlySalary.trim() === "" ? null : Number(monthlySalary),
        // FT is monthly-only (owner 2026-06-09); PT has no pay cycle.
        pay_cycle: employmentType === "ft" ? "monthly" : null,
        salary_tax_mode: taxMode,
        // ประกันกลุ่ม: เดือนเริ่มหัก (YYYY-MM) — "" = ยังไม่หัก (ส่ง "" ให้ API เคลียร์เป็น NULL).
        group_insurance_start_month: giStartMonth,
        // ผู้บริหาร/ไม่ลงเวลา — ตั้งได้ทุกประเภทงาน (owner 2026-08-20: PT นอกสถานที่ก็ปิดได้).
        // API รับเป็น boolean: true = ลงเวลาปกติ, false = ไม่ลงเวลา → ปิดแจ้งเตือนเข้ากะ + ไม่ขึ้นสรุป HR.
        track_attendance: !noClock,
        line_user_id: lineUserId.trim() || null,
        // shift_start_time + escalation_hours UI removed 2026-05;
        // the API still accepts them so older clients keep working,
        // but we explicitly clear to null here so any pre-set values
        // get cleaned up next time admin saves the row.
        shift_start_time: null,
        reports_to_user_id: reportsToUserId === "" ? null : Number(reportsToUserId),
        escalation_hours: null,
        is_test_account: isTestAccount ? 1 : 0,
        // ไม่รับส่วนแบ่งเซอร์วิสชาร์จ (แยกจาก track_attendance) — 1 = รับ (ดีฟอลต์), 0 = ตัดออก.
        receives_service_charge: noSvc ? 0 : 1
      };
      // PT→FT effective date. On a fresh conversion always send it. For someone
      // ALREADY FT, only send when the date field is actually SHOWN (a known
      // convert with ft_started_at, or the reveal toggle for a legacy backfill)
      // AND the admin actually changed it. This prevents the born-FT footgun
      // (owner 2026-07-21): the input prefills to today, so without the
      // field-shown guard, merely opening + saving a born-FT staffer would stamp
      // ft_started_at = today and wrongly bill them a weekly transition month.
      const isAlreadyFt = employmentType === "ft" && employee.employment_type === "ft";
      const ftDateFieldShown = Boolean(employee.ft_started_at) || wasPtReveal;
      if (clearFtTransition && isAlreadyFt) {
        // Born-FT correction (owner 2026-07-30): clear the wrongly-stamped
        // transition so they compute as a plain monthly FT. Suppresses any
        // ft_effective_date send below.
        body.clear_ft_transition = true;
      } else if (isConvertingToFt) {
        body.ft_effective_date = ftEffectiveDate;
      } else if (
        isAlreadyFt &&
        ftDateFieldShown &&
        /^\d{4}-\d{2}-\d{2}$/.test(ftEffectiveDate) &&
        ftEffectiveDate !== (employee.ft_started_at ?? "")
      ) {
        body.ft_effective_date = ftEffectiveDate;
      }
      // Account role (staff↔admin) — super_admin only, and never for a
      // super_admin target (the render guard hides the dropdown; the
      // server re-gates + strips). Sending the unchanged value is a
      // harmless no-op UPDATE.
      if (currentUserRole === "super_admin" && (employee.role as string) !== "super_admin") {
        body.role = roleVal;
      }
      // PDPA — only super_admin can grant payroll access. Server
      // ignores this field for non-super_admin operators (the PATCH
      // route gates it), but conditioning the include here keeps the
      // request body tidy.
      if (currentUserRole === "super_admin" && employee.role === "admin") {
        body.can_view_payroll = canViewPayrollFlag ? 1 : 0;
      }
      // Employee-health-data access — super_admin only (the consulting
      // doctor may be staff or admin). Server re-gates to super_admin.
      if (currentUserRole === "super_admin") {
        const licenseDigits = licenseNo.replace(/\D/g, ""); // store only the ว. number
        if (clinicalRole === "doctor" && licenseDigits === "") {
          setErr("แพทย์ที่ปรึกษาต้องระบุเลขใบประกอบวิชาชีพ (ว.)");
          setBusy(false);
          return;
        }
        body.clinical_role = clinicalRole === "none" ? null : clinicalRole;
        body.license_no = clinicalRole === "none" ? null : (licenseDigits || null);
        body.is_hr_analytics = hrAnalytics ? 1 : 0;
        // RBAC — replace the full set of module-access roles. Server
        // re-gates to super_admin and writes rbac_user_roles.
        body.role_ids = [...roleSel];
      }
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
        setErr(apiErrText(j, t("common.error")));
      }
    } catch {
      setErr(t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-2xl w-full p-5 space-y-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="font-semibold text-slate-800">
            {t("admin.persona.employees.editTitle")}
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {nameWithPrefix(employee.title_prefix, employee.display_name)} <span className="text-slate-400">@{employee.username}</span>
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
                  className="text-xs px-3 py-1.5 rounded-full bg-brand text-white font-bold hover:opacity-90 disabled:opacity-50">
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
                    {inviteLinkBusy === "rebind" ? "กำลังออก..." : "ออกลิงก์เชื่อมต่อ LINE ใหม่"}
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

        {/* Test-account flag — when checked, this row is excluded
            from every operational list (employees table by default,
            roster picker, payroll generation, approval-chain
            candidates, daily attendance summary). Pre-flagged on
            first migration for usernames "admin" / "test*" / display
            names containing "ทดสอบ". Admin can flip it any time. */}
        <label className="flex items-start gap-2 cursor-pointer bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={isTestAccount}
            onChange={(e) => setIsTestAccount(e.target.checked)}
          />
          <div className="text-xs">
            <div className="font-semibold text-amber-800">
              บัญชีทดสอบ — ซ่อนจากรายการพนักงานปกติ
            </div>
            <div className="text-amber-700 mt-0.5 text-[11px] leading-snug">
              ใช้สำหรับทดสอบระบบ + ตั้งค่า super admin เท่านั้น
              ไม่นับรวมในตารางเวร เงินเดือน อนุมัติคำขอลา ฯลฯ
            </div>
          </div>
        </label>

        {/* ชื่อเล่น (nickname) is filled by the staff themselves on
            /staff/persona/profile — admin form no longer duplicates
            that input. The value is still preserved (state + sent in
            save body unchanged) so older code paths that read
            employee.nickname_th keep working. Displayed read-only
            beside the title prefix for admin visibility. 2026-05. */}
        <div>
          <label className="label">คำนำหน้าชื่อ</label>
          <select className="input max-w-[200px]" value={titlePrefix}
            onChange={(e) => {
              const next = e.target.value;
              setTitlePrefix(next);
              // 2026-05: gender is derivable from the Thai title
              // prefix — admin no longer picks it separately. Only
              // sets when blank or matches the previous prefix's
              // implied gender (so admin can still override
              // intentionally).
              if (next === "นาย") setGender("male");
              else if (next === "นาง" || next === "นางสาว") setGender("female");
            }}>
            <option value="">— ไม่ระบุ —</option>
            <option value="นาย">นาย</option>
            <option value="นาง">นาง</option>
            <option value="นางสาว">นางสาว</option>
          </select>
        </div>
        <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
          <span className="font-semibold text-slate-600">ชื่อเล่น:</span>{" "}
          <span className="text-slate-700">{nicknameTh || "—"}</span>
          <span className="ml-2 text-slate-400">
            · พนักงานกรอกเองที่หน้าโปรไฟล์
          </span>
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
          <label className="label">{t("admin.persona.employees.field.hireDate")}</label>
          <input
            type="date" className="input"
            value={hireDate}
            style={{ textTransform: "uppercase" }}
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
            {/* shift_start_time field removed 2026-05 per owner
                direction — per-staff fixed time wasn't accurate
                anyway since the roster assigns different shifts on
                different days. Lateness now reads from roster
                directly via effectiveShiftStartByUserForDate(). */}

            {/* Chain-of-command moved to branch-level config (2026-05).
                The per-user "หัวหน้าโดยตรง" dropdown that used to live
                here has been replaced by /admin/persona/approval-chain
                where admin sets a tier 1 (supervisors) + tier 2
                (executives) roster for the whole branch. Removing the
                input here so no admin tries to set both — single source
                of truth. State + save body still send reports_to_user_id
                unchanged from what was loaded, so the API contract
                doesn't break for older clients (column stays in DB
                in case we need to roll back). */}
            <p className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2">
              <span className="font-semibold text-slate-600">สายบังคับบัญชา:</span>{" "}
              ตั้งระดับสาขาที่หน้า{" "}
              <Link href="/admin/persona/approval-chain"
                className="text-brand hover:underline font-medium">
                สายบังคับบัญชา
              </Link>{" "}
              — ไม่ต้องกำหนดรายบุคคลที่นี่
            </p>
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
              {/* Employee code is admin-controlled (assigned at hire);
                  the other three (national_id / tax_id / sso_id) are
                  filled by the staff themselves on /staff/persona/profile.
                  Admin used to duplicate those inputs here, which
                  caused two problems: (1) two sources of truth that
                  could drift, (2) admin had to retype information the
                  staff already provided. Removed 2026-05 in favour
                  of a read-only summary below + "ดู/แก้ที่หน้าโปรไฟล์
                  พนักงาน" link. State for those fields is preserved
                  so the save body keeps working unchanged. */}
              <div className="max-w-[280px]">
                <label className="label">{t("admin.persona.employees.field.employeeCode")}</label>
                <input className="input" type="text" value={employeeCode}
                  style={{ textTransform: "uppercase" }}
                  onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
                  placeholder="E.G. NM001" />
              </div>
              <div className="text-[11px] text-slate-500 bg-slate-50 rounded-lg px-3 py-2 mt-3 space-y-1">
                <div className="font-semibold text-slate-600 uppercase tracking-[0.5px] text-[10px]">
                  พนักงานกรอกเอง (โปรไฟล์ส่วนตัว)
                </div>
                <div>
                  <span className="font-semibold text-slate-600">เลขบัตรประชาชน:</span>{" "}
                  <span className="text-slate-700">{nationalId || "—"}</span>
                </div>
                <div>
                  <span className="font-semibold text-slate-600">เลขผู้เสียภาษี:</span>{" "}
                  <span className="text-slate-700">
                    {taxId || (nationalId ? `${nationalId} (ใช้เลขบัตร)` : "—")}
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-slate-600">เลขประกันสังคม:</span>{" "}
                  <span className="text-slate-700">
                    {ssoId || (nationalId ? `${nationalId} (ใช้เลขบัตร)` : "—")}
                  </span>
                </div>
                <Link
                  href={`/admin/persona/employees/${employee.id}`}
                  className="inline-block mt-1 text-brand hover:underline text-[10px]"
                >
                  → ดู / แก้ในหน้าโปรไฟล์เต็ม
                </Link>
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
                    style={{ textTransform: "uppercase" }}
                    onChange={(e) => setBankName(e.target.value.toUpperCase())}
                    placeholder="KTB / SCB / BBL ..." />
                </div>
                <div>
                  <label className="label">{t("admin.persona.employees.field.bankAccount")}</label>
                  <input className="input" type="text" value={bankAccount}
                    style={{ textTransform: "uppercase" }}
                    onChange={(e) => setBankAccount(e.target.value.toUpperCase())} />
                </div>
              </div>
            </div>

            {canViewPayroll && (
            <div className="border-t border-slate-200 pt-4">
              <h4 className="text-sm font-semibold text-slate-700 mb-2">
                {t("admin.persona.employees.section.payRate")}
              </h4>
              {employmentType === "pt" && (
                <div>
                  <label className="label">{t("admin.persona.employees.field.hourlyRate")}</label>
                  <div className="flex items-center gap-2">
                    <input className="input" type="number" step="0.01" min="0"
                      inputMode="decimal"
                      value={hourlyRate}
                      onChange={(e) => setHourlyRate(e.target.value)}
                      placeholder="50.00" />
                    <span className="text-sm text-slate-500 whitespace-nowrap">
                      {t("admin.persona.employees.bahtPerHour")}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    {t("admin.persona.employees.hourlyRateHint")}
                  </p>
                </div>
              )}
              {/* GENUINE PT→FT conversion (เดิมเป็นพาร์ทไทม์จริง) — เดือนแรกรายสัปดาห์ */}
              {employmentType === "ft" && employee.employment_type === "pt" && (
                <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 space-y-2">
                  <div>
                    กำลังย้าย <span className="font-semibold">{employee.display_name}</span> จาก<b>พาร์ทไทม์</b>เป็นพนักงานประจำ —
                    กรอกเงินเดือน (บาท/เดือน) ให้เรียบร้อยก่อนบันทึก
                  </div>
                  <div>
                    <label className="block font-semibold mb-1">วันที่มีผล (เริ่มเป็นประจำ) *</label>
                    <input
                      type="date"
                      className="input"
                      value={ftEffectiveDate}
                      max={new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}
                      onChange={(e) => setFtEffectiveDate(e.target.value)}
                    />
                  </div>
                  <div className="leading-relaxed">
                    เดือนแรก (เดือนของวันที่มีผล) จ่าย<b>รายสัปดาห์</b> = เงินเดือน ÷ จำนวนรอบจ่ายในเดือน
                    หักภาษี ณ ที่จ่าย 3% รวมกับรอบพาร์ทไทม์ · <b>เดือนถัดไป</b>ย้ายเป็นพนักงานประจำ
                    (รายเดือน จ่ายวันที่ 5 ของเดือนถัดไป)
                  </div>
                </div>
              )}
              {/* BORN-FT new hire (ไม่เคยเป็นพาร์ทไทม์) — เดือนแรกคิดรายวัน (owner 2026-07-30) */}
              {employmentType === "ft" && employee.employment_type !== "ft" && employee.employment_type !== "pt" && (
                <div className="mb-3 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 space-y-2">
                  <div>
                    รับ <span className="font-semibold">{employee.display_name}</span> เข้าเป็น<b>พนักงานประจำรายเดือน</b> —
                    กรอกเงินเดือน (บาท/เดือน) + <b>วันที่เริ่มงาน</b>ให้เรียบร้อยก่อนบันทึก
                  </div>
                  <div className="leading-relaxed">
                    ถ้าเริ่มงานไม่เต็มเดือน <b>เดือนแรกคิดรายวัน</b> = เงินเดือน ÷ 30 × จำนวนวันที่ทำจริง ·
                    จ่าย<b>วันที่ 5 ของเดือนถัดไป</b>พร้อมพนักงานประจำคนอื่น (ไม่ใช่รอบพาร์ทไทม์รายสัปดาห์)
                  </div>
                </div>
              )}
              {/* พนักงานประจำ (FT อยู่แล้ว) — จัดการรอบ "เดือนเปลี่ยนผ่าน" เชิงบวก
                  (owner 2026-07-31): ประจำ = รายเดือนปกติ. เดือนเปลี่ยนผ่าน (รายสัปดาห์
                  + หัก 3%) เป็นของที่ "ตั้ง" หรือ "ยกเลิก" ได้ตรงๆ ไม่ใช่ผลจากติ๊กผิด. */}
              {employmentType === "ft" && employee.employment_type === "ft" && (
                <div className="mb-3">
                  {clearFtTransition ? (
                    <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 flex items-start justify-between gap-2">
                      <span>
                        จะตั้งเป็น <b>พนักงานประจำรายเดือนปกติ</b> — ยกเลิกเดือนเปลี่ยนผ่าน
                        (เดือนแรกไม่เต็มคิดรายวัน) · บันทึกแล้วสั่งคำนวณรอบที่เกี่ยวข้องใหม่
                      </span>
                      <button type="button" onClick={() => setClearFtTransition(false)}
                        className="shrink-0 text-slate-500 hover:text-slate-700 underline">ยกเลิก</button>
                    </div>
                  ) : employee.ft_started_at || wasPtReveal ? (
                    <>
                      <label className="label">เดือนเปลี่ยนผ่าน (พาร์ทไทม์ → ประจำ)</label>
                      <input
                        type="date"
                        className="input"
                        value={ftEffectiveDate}
                        max={new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)}
                        onChange={(e) => setFtEffectiveDate(e.target.value)}
                      />
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                        เดือนของวันที่นี้ = เดือนเปลี่ยนผ่าน (จ่าย<b>รายสัปดาห์</b>รวมกับพาร์ทไทม์ + หัก ณ ที่จ่าย 3%),
                        เดือนถัดไปเป็นรายเดือนปกติ · ตั้งเฉพาะคนที่<b>แปลงจากพาร์ทไทม์จริง</b> แล้วสั่งคำนวณรอบนั้นใหม่
                      </p>
                      <button type="button" onClick={() => setClearFtTransition(true)}
                        className="mt-2 text-xs text-brand hover:underline">
                        ↺ ตั้งเป็นพนักงานประจำรายเดือนปกติ (ไม่มีเดือนเปลี่ยนผ่าน)
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span>พนักงานประจำ — จ่าย<b>รายเดือน</b> (เดือนแรกไม่เต็มคิดรายวัน)</span>
                      <button type="button" onClick={() => setWasPtReveal(true)}
                        className="shrink-0 text-brand hover:underline">
                        + ตั้งเดือนเปลี่ยนผ่าน (คนที่แปลงจากพาร์ทไทม์)
                      </button>
                    </div>
                  )}
                </div>
              )}
              {employmentType === "ft" && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">{t("admin.persona.employees.field.monthlySalary")}</label>
                    <div className="flex items-center gap-2">
                      <input className="input" type="number" step="0.01" min="0"
                        inputMode="decimal"
                        value={monthlySalary}
                        onChange={(e) => setMonthlySalary(e.target.value)} />
                      <span className="text-sm text-slate-500">บาท</span>
                    </div>
                  </div>
                  <div>
                    <label className="label">{t("admin.persona.employees.field.payCycle")}</label>
                    {/* FT weekly cancelled (owner 2026-06-09): full-time staff
                        are paid monthly only, per accounting policy. */}
                    <div className="input bg-slate-50 text-slate-600">
                      {t("admin.persona.employees.cycleMonthly")}
                    </div>
                    <p className="text-xs text-slate-500 mt-1">
                      รายเดือน — ยกเว้นเดือนแรกที่เพิ่งเปลี่ยนจากพาร์ทไทม์ จ่ายรายสัปดาห์ก่อน (ระบบสลับให้อัตโนมัติ)
                    </p>
                  </div>
                  {/* จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบถึงวันที่ (owner 2026-08-18) — เฉพาะคนที่
                      ย้าย PT→ประจำ (มี ft_started_at) และแอดมินที่ดูเงินเดือนได้. ใช้กรณีเดือน
                      เปลี่ยนผ่านจ่ายด้วยวิธีเก่า (÷สัปดาห์) ครบแล้ว → รอบคร่อมเดือนถัดไปจะไม่คิดฐานซ้ำ. */}
                  {canViewPayroll && employee.ft_started_at && (
                    <div className="col-span-2">
                      <label className="label">จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบถึงวันที่ (ถ้ามี)</label>
                      <input className="input" type="date"
                        value={ftSalaryPaidThrough}
                        onChange={(e) => setFtSalaryPaidThrough(e.target.value)} />
                      <p className="text-xs text-slate-500 mt-1">
                        กรอกเฉพาะถ้าเดือนเปลี่ยนผ่านจ่ายด้วยวิธีเก่า (เงินเดือน÷สัปดาห์) ครบแล้ว · รอบรายสัปดาห์จะ
                        ไม่คิดฐานเงินเดือนของวันเปลี่ยนผ่านที่ ≤ วันนี้ (OT + วันจ่ายสองเท่ายังจ่าย) · เว้นว่าง = คิดปกติ
                      </p>
                    </div>
                  )}
                </div>
              )}
              {/* ไม่ต้องลงเวลา (ผู้บริหาร/นอกสถานที่) — แสดงทุกประเภทงาน (owner 2026-08-20).
                  ปิด = ไม่รับ DM เตือนเข้ากะ + ไม่ขึ้นในสรุปการลงเวลาของ HR. สำหรับ FT ยังหมายถึง
                  คิดเงินเดือน fix เต็มจำนวน ไม่มี OT ด้วย. */}
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={noClock}
                  onChange={(e) => setNoClock(e.target.checked)} />
                <span className="text-sm text-slate-700">
                  ไม่ต้องลงเวลา (ผู้บริหาร/นอกสถานที่)
                  <span className="block text-xs text-slate-500">
                    ปิดแจ้งเตือนเข้ากะทาง LINE และไม่นับในสรุปการลงเวลาของ HR
                    {employmentType === "ft" ? " · คิดเงินเดือนแบบ fix เต็มจำนวน ไม่มีค่าล่วงเวลา (OT)" : ""}
                  </span>
                </span>
              </label>
              {/* ไม่รับส่วนแบ่งเซอร์วิสชาร์จ — แยกจาก "ไม่ต้องลงเวลา" (owner 2026-07-21).
                  ค่าเริ่มต้นทุกคนในสาขารับ SVC; ติ๊กเพื่อตัดออกจากกองกลาง. แสดงทุกประเภทงาน. */}
              <label className="flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 cursor-pointer hover:bg-slate-50">
                <input type="checkbox" className="mt-0.5" checked={noSvc}
                  onChange={(e) => setNoSvc(e.target.checked)} />
                <span className="text-sm text-slate-700">
                  ไม่รับส่วนแบ่งเซอร์วิสชาร์จ
                  <span className="block text-xs text-slate-500">
                    ไม่นับรวมในการแบ่งกองกลาง SVC ของสาขา (ค่าเริ่มต้น = รับส่วนแบ่ง)
                  </span>
                </span>
              </label>
              {employmentType === "" && (
                <p className="text-xs text-amber-700">
                  {t("admin.persona.employees.payRateNeedsType")}
                </p>
              )}
            </div>
            )}

            {/* Tax mode (in-system SSO vs out-of-system WHT) */}
            {canViewPayroll && (
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

              {/* Group-insurance enrolment month (owner 2026-08-02) — the ฿350/mo
                  SVC deduction runs FT 3 / PT 12 months from this month. Empty =
                  not enrolled yet → no deduction until set. */}
              <div className="mt-4">
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t("admin.persona.employees.groupInsurance.label")}
                </label>
                <select
                  value={giStartMonth}
                  onChange={(e) => setGiStartMonth(e.target.value)}
                  className="input max-w-[220px]"
                >
                  <option value="">— ไม่หัก —</option>
                  {(() => {
                    const TH_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
                      "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
                    const opts: Array<{ v: string; label: string }> = [];
                    const now = new Date(Date.now() + 7 * 3600 * 1000);
                    for (let off = 3; off >= -3; off--) {
                      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + off, 1));
                      opts.push({ v: d.toISOString().slice(0, 7), label: `${TH_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear() + 543}` });
                    }
                    // Keep an out-of-range stored value visible so a bad entry can be corrected.
                    if (giStartMonth && !opts.some((o) => o.v === giStartMonth)) opts.unshift({ v: giStartMonth, label: giStartMonth });
                    return opts.map((o) => <option key={o.v} value={o.v}>{o.label}</option>);
                  })()}
                </select>
                <p className="text-xs text-slate-500 mt-1">
                  {giStartMonth
                    ? t("admin.persona.employees.groupInsurance.hintSet")
                    : t("admin.persona.employees.groupInsurance.hintUnset")}
                </p>
              </div>
            </div>
            )}

            {/* PDPA — super_admin can grant per-admin payroll access.
                Only shown when (a) operator is super_admin AND (b)
                target user is an admin. Toggling syncs to
                users.can_view_payroll via the PATCH route. */}
            {currentUserRole === "super_admin" && employee.role === "admin" && (
              <div className="border-t border-slate-200 pt-4">
                <h4 className="text-sm font-semibold text-slate-700 mb-2">
                  สิทธิ์ดูข้อมูลเงินเดือน
                </h4>
                <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={canViewPayrollFlag}
                    onChange={(e) => setCanViewPayrollFlag(e.target.checked)}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-800">
                      อนุญาตให้แอดมินคนนี้ดูเงินเดือนของพนักงานทุกคนในสาขาที่ดูแล
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      เปิด = เห็นเมนู &quot;เงินเดือน&quot; + ฟิลด์ค่าจ้าง / ฐานเงินเดือนในรายชื่อพนักงาน · ปิด = ซ่อนทั้งหมด
                    </div>
                  </div>
                </label>
              </div>
            )}
          </>
        )}

        {/* Account role (staff↔admin) — super_admin only. One-stop
            account admin here so there's no need to bounce to
            /admin/reserva/staff (owner 2026-07-13). Hidden for
            super_admin targets so nobody can demote the top account. */}
        {currentUserRole === "super_admin" && (employee.role as string) !== "super_admin" && (
          <div className="border-t border-slate-200 pt-4 space-y-2">
            <h4 className="text-sm font-semibold text-slate-700">
              สิทธิ์บัญชีผู้ใช้
            </h4>
            <div className="max-w-[280px]">
              <label className="label">ระดับสิทธิ์</label>
              <select className="input" value={roleVal}
                onChange={(e) => setRoleVal(e.target.value as "admin" | "staff")}>
                <option value="staff">พนักงาน (staff) — ใช้งานฝั่งพนักงาน</option>
                <option value="admin">ผู้ดูแลระบบ (admin) — เข้าหลังบ้านได้</option>
              </select>
              <p className="text-[11px] text-slate-500 mt-1">
                เปลี่ยนเป็น <b>ผู้ดูแลระบบ</b> = เข้าเมนูหลังบ้านได้ · สิทธิ์ดูเงินเดือน/โมดูล
                กำหนดเพิ่มด้านล่าง · จะมีผลหลังกดบันทึกและผู้ใช้ล็อกอินใหม่
              </p>
            </div>
          </div>
        )}

        {/* RBAC — module-access roles (super_admin only). Assign which
            admin modules this employee can reach. Roles are created /
            edited at /admin/roles. Empty list (no roles defined) hides
            the section. (owner 2026-06-04) */}
        {currentUserRole === "super_admin" && allRoles.length > 0 && (
          <div className="border-t border-slate-200 pt-4 space-y-3">
            <h4 className="text-sm font-semibold text-slate-700">
              บทบาทการเข้าถึงระบบ
            </h4>
            <p className="text-[11px] text-slate-500">
              กำหนดว่าพนักงานคนนี้เข้าถึงโมดูลผู้ดูแลใดได้บ้าง · สร้าง/แก้บทบาทที่เมนู
              &quot;บทบาทและสิทธิ์&quot; · ผู้ดูแลระบบสูงสุดเข้าได้ทุกอย่างเสมอ
            </p>
            <div className="space-y-2">
              {allRoles.map((r) => (
                <label
                  key={r.id}
                  className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-slate-200 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4"
                    checked={roleSel.has(r.id)}
                    onChange={() => toggleRole(r.id)}
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-800">{r.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {r.permissions.length === 0
                        ? "— ยังไม่ได้ให้สิทธิ์โมดูล —"
                        : r.permissions
                            .map(
                              (pk) =>
                                RBAC_PERMISSIONS.find((c) => c.key === pk)?.module ?? pk
                            )
                            .join(" · ")}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Employee-health-data access — super_admin only, any employee.
            A company should provide a doctor to consult on employee
            health; only that consulting doctor + the employee see raw
            data. Executives / HR / supervisors get aggregate dashboards
            only. (owner 2026-06-05) */}
        {currentUserRole === "super_admin" && (
          <div className="border-t border-slate-200 pt-4 space-y-3">
            <h4 className="text-sm font-semibold text-slate-700">
              สิทธิ์เข้าถึงข้อมูลสุขภาพพนักงาน
            </h4>
            <p className="text-[11px] text-slate-500 -mt-1">
              ข้อมูลสุขภาพเข้าถึงได้เฉพาะ <b>แพทย์ที่ปรึกษา</b> และ <b>ตัวพนักงานเอง</b> ·
              ผู้บริหาร/ฝ่ายบุคคล/หัวหน้างานเห็นเป็น <b>ภาพรวม (dashboard)</b> เท่านั้น
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">บทบาทด้านสุขภาพ</label>
                <select className="input" value={clinicalRole}
                  onChange={(e) => setClinicalRole(e.target.value as "none" | "doctor")}>
                  <option value="none">— ไม่มี —</option>
                  <option value="doctor">แพทย์ที่ปรึกษา (เข้าถึงข้อมูลสุขภาพ)</option>
                </select>
              </div>
              {clinicalRole === "doctor" && (
                <div>
                  <label className="label">เลขใบประกอบวิชาชีพ (ว.) *</label>
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-semibold text-slate-500">ว.</span>
                    <input className="input" value={licenseNo} inputMode="numeric"
                      onChange={(e) => setLicenseNo(e.target.value.replace(/\D/g, ""))}
                      placeholder="เช่น 12345" />
                  </div>
                  <p className="text-[10px] text-slate-400 mt-1">ระบบเก็บเฉพาะตัวเลข · ใช้ยืนยันตัวตนทุกครั้งที่เปิดข้อมูล</p>
                </div>
              )}
            </div>
            <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-slate-200 hover:bg-slate-50">
              <input type="checkbox" className="mt-0.5 h-4 w-4"
                checked={hrAnalytics} onChange={(e) => setHrAnalytics(e.target.checked)} />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-800">เห็นภาพรวมสุขภาพพนักงาน (Dashboard)</div>
                <div className="text-xs text-slate-500 mt-1">เห็นสถิติรวมเท่านั้น ไม่เห็นข้อมูลรายบุคคล (สำหรับผู้บริหาร/ฝ่ายบุคคล)</div>
              </div>
            </label>
            <p className="text-[11px] text-slate-400">
              แพทย์ที่ปรึกษาเห็นเฉพาะผู้ป่วยที่ตนดูแล · ปลดล็อกด้วยเลขใบประกอบทุกครั้ง · ทุกการเข้าถึงถูกบันทึก log
            </p>
          </div>
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
                <label className="flex items-center gap-2 text-sm text-slate-600 pb-2 cursor-pointer">
                  <Switch
                    checked={clearPin}
                    accent="rose"
                    onChange={(v) => {
                      setClearPin(v);
                      if (v) setPin("");
                    }}
                  />
                  {t("admin.persona.employees.clearPin")}
                </label>
              )}
            </div>
          </div>
        </div>

        {/* ── สิทธิ์เข้าสาขา — which branches this employee may enter.
            Separate save (preserves branch-admin grants). Branches
            outside this admin's scope show disabled. */}
        <div className="border-t border-slate-200 pt-4">
          <h4 className="text-sm font-semibold text-slate-700 mb-1">
            สิทธิ์เข้าสาขา
          </h4>
          <p className="text-xs text-slate-500 mb-2">
            พนักงานจะเลือกสาขาที่เลือกไว้ตอนเข้าระบบได้ ·
            สาขาที่จางคือสาขาที่คุณไม่มีสิทธิ์จัดการ (ดูแลโดย super admin)
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {allBranches.map((b) => {
              const canEdit = editableSet.has(b.id);
              return (
                <label key={b.id}
                  className={"flex items-center gap-2 text-sm " +
                    (canEdit ? "text-slate-700" : "text-slate-400")}>
                  <input
                    type="checkbox"
                    checked={branchSel.has(b.id)}
                    disabled={!canEdit || branchBusy}
                    onChange={() => toggleBranch(b.id)}
                  />
                  {b.name}
                </label>
              );
            })}
          </div>
          {/* Home/primary branch picker — only when super_admin AND the
              employee is in 2+ branches (rotating). FT monthly salary is paid
              at the home branch only; the other branch(es) still pay OT + SVC
              for days worked there (owner 2026-07-14). */}
          {currentUserRole === "super_admin" && branchSel.size >= 2 && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="text-sm font-medium text-slate-700 mb-1">สาขาหลัก (บ้าน)</div>
              <p className="text-[11px] text-slate-500 mb-2">
                พนักงานประจำ (เงินเดือน) จะรับเงินเดือนที่สาขาหลักเท่านั้น · สาขาอื่นที่ไป
                เข้าเวรยังได้ค่าล่วงเวลา + เซอร์วิสชาร์จตามวันที่ทำ
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {allBranches.filter((b) => branchSel.has(b.id)).map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="radio"
                      name="primaryBranch"
                      checked={primaryBranch === b.id}
                      disabled={branchBusy}
                      onChange={() => setPrimaryBranch(b.id)}
                    />
                    {b.name}
                  </label>
                ))}
              </div>
              {primaryBranch == null && (
                <p className="text-[11px] text-amber-700 mt-1.5">
                  ยังไม่ได้เลือกสาขาหลัก — ระบบจะใช้สาขาแรกเป็นค่าเริ่มต้น
                </p>
              )}
            </div>
          )}
          {/* Per-branch PT rate (owner 2026-08-04) — a staffer who works several
              branches can earn a different rate at each (พรนภา). super_admin +
              payroll access only. Blank = the employee's default rate is used. */}
          {currentUserRole === "super_admin" && canViewPayroll && employmentType === "pt" && branchSel.size >= 1 && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div className="text-sm font-medium text-slate-700 mb-1">ค่าตอบแทนรายสาขา (รายชั่วโมง)</div>
              <p className="text-[11px] text-slate-500 mb-2">
                ตั้งเรตต่อชั่วโมงแยกตามสาขา เฉพาะกรณีค่าตอบแทนแต่ละที่ไม่เท่ากัน · เว้นว่าง =
                ใช้เรตปกติของพนักงาน{employee.hourly_rate != null ? ` (${employee.hourly_rate}/ชม.)` : ""}
              </p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                {allBranches.filter((b) => branchSel.has(b.id)).map((b) => (
                  <label key={b.id} className="flex items-center gap-2 text-sm text-slate-700">
                    <span className="flex-1 truncate">{b.name}</span>
                    <input
                      type="number" min="0" step="0.01" inputMode="decimal"
                      className="input !w-24 !py-1 text-sm text-right"
                      placeholder={employee.hourly_rate != null ? String(employee.hourly_rate) : "ปกติ"}
                      value={branchRates.get(b.id) ?? ""}
                      disabled={branchBusy}
                      onChange={(e) => setBranchRate(b.id, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
          {/* Cross-company/branch helper pay (owner 2026-08-18) — an FT who comes to
              help at another company's branch (พรนภา สังกัด AT HOME ไปช่วย) is paid
              there either รายวัน (flat/day) or รายชั่วโมง (like a PT: OT + วันพิเศษ×1.5),
              computed automatically from their clock-ins in that branch's weekly round
              (WHT 3%, no ประกันสังคม). super_admin + payroll access, FT only; the
              per-branch รายชั่วโมง for PT is handled by the section above. Only
              accessible (ticked) non-home branches, one row each. Blank = not a helper. */}
          {currentUserRole === "super_admin" && canViewPayroll && employmentType === "ft" && branchSel.size >= 1 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
              <div className="text-sm font-medium text-slate-700 mb-1">ค่าตอบแทนทำงานข้ามบริษัท</div>
              <p className="text-[11px] text-slate-500 mb-2">
                ตั้งเฉพาะสาขาที่พนักงานคนนี้ไป<b>ทำงานข้ามบริษัท</b> · เลือกจ่าย <b>รายวัน</b> (คิดต่อวันที่มา)
                หรือ <b>รายชั่วโมง</b> (คิดตามชั่วโมง + OT + วันพิเศษ×1.5) · ระบบคิดให้อัตโนมัติจาก
                การลงเวลา · หัก ณ ที่จ่าย 3% โดยบริษัทผู้จ่าย ไม่หักประกันสังคม · เว้นว่าง = ไม่คิดค่าตอบแทนข้ามบริษัทที่นี่
              </p>
              <div className="flex flex-col gap-1.5">
                {allBranches.filter((b) => branchSel.has(b.id) && b.id !== primaryBranch).map((b) => {
                  const row = getHelperRow(b.id);
                  return (
                    <div key={b.id} className="flex items-center gap-2 text-sm text-slate-700">
                      <span className="flex-1 truncate">{b.name}</span>
                      <input
                        type="number" min="0" step="0.01" inputMode="decimal"
                        className="input !w-24 !py-1 text-sm text-right"
                        placeholder={row.mode === "daily" ? "บาท/วัน" : "บาท/ชม."}
                        value={row.value}
                        disabled={branchBusy}
                        onChange={(e) => setHelperRow(b.id, { value: e.target.value })}
                      />
                      <select
                        className="input !w-28 !py-1 text-sm"
                        value={row.mode}
                        disabled={branchBusy}
                        onChange={(e) => setHelperRow(b.id, { mode: e.target.value as "daily" | "hourly" })}
                      >
                        <option value="daily">รายวัน</option>
                        <option value="hourly">รายชั่วโมง</option>
                      </select>
                    </div>
                  );
                })}
              </div>
              {allBranches.filter((b) => branchSel.has(b.id) && b.id !== primaryBranch).length === 0 && (
                <p className="text-[11px] text-slate-400">— ติ๊กสาขาที่ไปทำงาน (ที่ไม่ใช่สาขาหลัก) ก่อน</p>
              )}
            </div>
          )}
          <div className="flex items-center gap-3 mt-3">
            <button type="button" onClick={saveBranches}
              disabled={branchBusy}
              className="px-4 py-2 rounded-lg bg-brand text-white text-sm font-bold disabled:opacity-50">
              {branchBusy ? t("common.submitting") : "บันทึกสิทธิ์สาขา"}
            </button>
            {branchMsg === "saved" && (
              <span className="text-sm text-emerald-600">บันทึกแล้ว</span>
            )}
            {branchMsg && branchMsg !== "saved" && (
              <span className="text-sm text-rose-600">{branchMsg}</span>
            )}
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
            บัญชีจะถูกระงับ (status=disabled), ลบการเชื่อมต่อ LINE, ปิด session
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
              ลบบัญชี {nameWithPrefix(employee.title_prefix, employee.display_name)}
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-rose-700 font-bold">
                ยืนยันลบ {nameWithPrefix(employee.title_prefix, employee.display_name)} (@{employee.username}) ใช่ไหม?
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
                  className="flex-1 py-2 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold disabled:opacity-50">
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
            className="flex-1 py-2.5 rounded-full bg-brand hover:opacity-90 text-white text-sm font-bold disabled:opacity-50">
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
          onMouseDown={(e) => { if (e.target === e.currentTarget) setInviteLinkResp(null); }}>
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
                  {inviteLinkResp.kind === "rebind_line" && "เชื่อมต่อ LINE ใหม่"}
                </span>
                <br />
                หมดอายุ {bkkDateIso(inviteLinkResp.expires_at)}
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
                คัดลอกลิงก์
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[11px] text-amber-800 leading-snug">
              หลังพนักงานลงทะเบียนเสร็จ → ให้กดปุ่มริชเมนู → หน้าจอแสดง
              LINE ID → ส่งให้ผู้ดูแลระบบวางในช่อง "LINE binding" ของพนักงาน
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
