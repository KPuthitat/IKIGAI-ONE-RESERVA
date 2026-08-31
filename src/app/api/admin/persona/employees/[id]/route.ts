import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb, logPersonaAction, setUserRoles, type UserRole } from "@/lib/db";
import { revokeOpenInvites } from "@/lib/invites";

// PATCH /api/admin/persona/employees/[id] — admin update profile + payroll fields
// Note: ไม่อนุญาตเปลี่ยน username/password_hash/display_name (sync จาก Payroll).
// role (staff↔admin) IS editable here — super_admin only — so account admin is
// one-stop at the พนักงาน menu instead of bouncing to /admin/reserva/staff
// (owner 2026-07-13). Gated + guarded below (super_admin target / self are
// stripped so nobody can self-demote or touch a super_admin).
const Body = z.object({
  // Role — super_admin only (stripped for everyone else below).
  role: z.enum(["admin", "staff"]).optional(),
  // Profile
  gender: z.enum(["male", "female"]).nullable().optional(),
  employment_type: z.enum(["pt", "ft"]).nullable().optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Multi-day weekly off — array of digits 0..6 (0=Sunday). Empty array = unset.
  weekly_off_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  // Phase 1D — Payroll fields
  employee_code: z.string().max(40).nullable().optional(),
  national_id: z.string().max(20).nullable().optional(),
  bank_name: z.string().max(40).nullable().optional(),
  bank_account: z.string().max(40).nullable().optional(),
  tax_id: z.string().max(20).nullable().optional(),
  sso_id: z.string().max(20).nullable().optional(),
  hourly_rate: z.number().min(0).nullable().optional(),
  monthly_salary: z.number().min(0).nullable().optional(),
  pay_cycle: z.enum(["weekly", "monthly"]).nullable().optional(),
  salary_tax_mode: z.enum(["sso", "wht"]).optional(),
  // Group-insurance enrolment month "YYYY-MM" (owner 2026-08-02). "" / null =
  // not enrolled → no ฿350/mo SVC deduction until set. Payroll-gated (money).
  group_insurance_start_month: z.string().regex(/^\d{4}-\d{2}$/).or(z.literal("")).nullable().optional(),
  // วันที่มีผลของการเปลี่ยน PT→FT (owner 2026-07-13) — ใช้เป็น ft_started_at
  ft_effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบแล้วถึงวันที่ (owner 2026-08-18) — YYYY-MM-DD; ""/null
  // = ล้าง. รอบรายสัปดาห์จะไม่คิดฐานเงินเดือนของวันเปลี่ยนผ่านที่ ≤ วันนี้ (จ่ายด้วยวิธีเก่าแล้ว).
  ft_salary_paid_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).nullable().optional(),
  // Correct a born-FT that was wrongly stamped as a PT→FT weekly transition
  // (owner 2026-07-30): clears ft_started_at + forces pay_cycle monthly so the
  // person lands in the FT-monthly table and the first partial month prorates by
  // hire_date. "เป็นประจำมาแต่แรก ไม่เคยเป็น PT" in the edit form.
  clear_ft_transition: z.boolean().optional(),
  // วันที่มีผลของการเปลี่ยน FT→PT (owner 2026-08-31) — ใช้เป็น pt_started_at. จากเดือน
  // ของวันที่นี้ระบบคิดเป็นพาร์ทไทม์รายชั่วโมง (จากตารางกะเมื่อไม่ลงเวลา), ก่อนหน้าเป็นเงินเดือนประจำ.
  pt_effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // ยกเลิกการเปลี่ยนเป็นพาร์ทไทม์ที่ตั้งไว้ → ล้าง pt_started_at (กลับเป็นประจำเต็มตัว).
  clear_pt_switch: z.boolean().optional(),
  // LINE userId (33-char string starting with 'U'). Empty / null = unbind.
  line_user_id: z.string().max(64).nullable().optional(),
  // Expected shift start "HH:MM" — used by late-detection. Empty / null = unset
  // (no lateness computed for this staff member). Accepts both 1- and 2-digit hours.
  shift_start_time: z.string().regex(/^\d{1,2}:\d{2}$/).or(z.literal("")).nullable().optional(),
  // Chain-of-command (2026-05). Direct manager + per-user override
  // of the escalation window (system default kicks in when null).
  reports_to_user_id: z.number().int().positive().nullable().optional(),
  escalation_hours:   z.number().int().min(1).max(720).nullable().optional(),
  // 2026-05-27 — test-account flag. 1 = hide from operational lists.
  is_test_account:    z.number().int().min(0).max(1).optional(),
  // 2026-07-21 — service-charge eligibility, decoupled from track_attendance.
  // 1 = receives SVC (default), 0 = excluded from the branch pool.
  receives_service_charge: z.number().int().min(0).max(1).optional(),
  // 2026-05-30 — PDPA payroll-access grant. Only super_admin may set
  // this; the server gate strips it for everyone else (below).
  can_view_payroll:   z.number().int().min(0).max(1).optional(),
  // 2026-06-04 — Mounjaro clinical access (super_admin only; stripped for
  // everyone else below). doctor requires a license number.
  clinical_role:   z.enum(["doctor", "nurse"]).nullable().optional(),
  license_no:      z.string().max(60).nullable().optional(),
  is_hr_analytics: z.number().int().min(0).max(1).optional(),
  // 2026-06-04 — RBAC: full set of module-access role ids to assign to
  // this user (replaces existing). super_admin only; stripped otherwise.
  role_ids:        z.array(z.number().int().positive()).max(50).optional(),
  // PIN — 4 digits to set, "" to clear, omit to keep
  pin: z.string().regex(/^\d{4}$/).or(z.literal("")).optional(),

  // ── Phase A profile fields (TC-P) ─────────────────────────────
  // Personal
  title_prefix:    z.string().max(40).nullable().optional(),
  first_name_th:   z.string().max(100).nullable().optional(),
  last_name_th:    z.string().max(100).nullable().optional(),
  first_name_en:   z.string().max(100).nullable().optional(),
  last_name_en:    z.string().max(100).nullable().optional(),
  nickname_th:     z.string().max(60).nullable().optional(),
  nickname_en:     z.string().max(60).nullable().optional(),
  dob:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nationality:     z.string().max(60).nullable().optional(),
  race:            z.string().max(60).nullable().optional(),
  religion:        z.string().max(60).nullable().optional(),
  marital_status:  z.string().max(20).nullable().optional(),
  military_status: z.string().max(20).nullable().optional(),
  blood_type:      z.string().max(5).nullable().optional(),
  height_cm:       z.number().min(0).max(300).nullable().optional(),
  weight_kg:       z.number().min(0).max(500).nullable().optional(),
  personal_notes:  z.string().max(2000).nullable().optional(),
  // Contact
  personal_email:  z.string().max(120).nullable().optional(),
  corporate_email: z.string().max(120).nullable().optional(),
  mobile_phone:    z.string().max(40).nullable().optional(),
  work_phone:      z.string().max(40).nullable().optional(),
  line_id:         z.string().max(60).nullable().optional(),
  house_address:        z.string().max(500).nullable().optional(),
  house_subdistrict:    z.string().max(120).nullable().optional(),
  house_district:       z.string().max(120).nullable().optional(),
  house_province:       z.string().max(120).nullable().optional(),
  house_postcode:       z.string().max(10).nullable().optional(),
  contact_address:      z.string().max(500).nullable().optional(),
  contact_subdistrict:  z.string().max(120).nullable().optional(),
  contact_district:     z.string().max(120).nullable().optional(),
  contact_province:     z.string().max(120).nullable().optional(),
  contact_postcode:     z.string().max(10).nullable().optional(),
  contact_same_as_house: z.boolean().optional(),
  emergency_name:         z.string().max(120).nullable().optional(),
  emergency_relationship: z.string().max(60).nullable().optional(),
  emergency_phone:        z.string().max(40).nullable().optional(),
  // Employment
  supervisor_user_id: z.number().int().positive().nullable().optional(),
  job_title:          z.string().max(120).nullable().optional(),
  contract_end_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  employment_status:  z.enum(["probation", "permanent"]).nullable().optional(),
  track_attendance:   z.boolean().optional(),
  hire_mode:          z.enum(["monthly", "daily", "hourly"]).nullable().optional(),
  payment_method:     z.enum(["bank", "cash"]).nullable().optional(),
  driver_license_no:  z.string().max(40).nullable().optional(),
  manpower_type:      z.enum(["new", "replacement"]).nullable().optional(),
  profile_self_edit_open: z.boolean().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  // PDPA guard (2026-05-30): admins without payroll access can edit
  // profile fields freely but must not touch salary. The server is
  // the ground truth — even if the UI hides those inputs, a
  // crafted request must not slip through. Strip the salary keys
  // from the parsed payload silently so the rest of the update
  // still lands.
  if (!userCanViewPayroll(user)) {
    delete parsed.data.hourly_rate;
    delete parsed.data.monthly_salary;
    delete parsed.data.pay_cycle;
    delete parsed.data.salary_tax_mode;
    delete parsed.data.group_insurance_start_month;
    delete parsed.data.ft_salary_paid_through;
  }
  // Only super_admin can grant / revoke payroll-access on another
  // account. A regular admin trying to flip this for themselves or
  // a peer must be silently stripped — the privilege escalation
  // would otherwise be one POST away.
  if (user.role !== "super_admin") {
    delete parsed.data.can_view_payroll;
    // Clinical access is super_admin-only too — strip for everyone else.
    delete parsed.data.clinical_role;
    delete parsed.data.license_no;
    delete parsed.data.is_hr_analytics;
    // RBAC role assignment is super_admin-only as well.
    delete parsed.data.role_ids;
    // Account role (staff↔admin) is a privilege-granting change — super_admin only.
    delete parsed.data.role;
  }
  // A doctor must carry a license number (their clinical unlock key).
  if ("clinical_role" in parsed.data && parsed.data.clinical_role === "doctor"
      && !(parsed.data.license_no ?? "").trim()) {
    return NextResponse.json({ error: "license_required_for_doctor" }, { status: 400 });
  }
  // Clearing the clinical role clears the license too.
  if ("clinical_role" in parsed.data && parsed.data.clinical_role === null) {
    parsed.data.license_no = null;
  }

  const db = getDb();
  const target = db.prepare("SELECT id, employment_type, role FROM users WHERE id = ?")
    .get(id) as { id: number; employment_type: "pt" | "ft" | null; role: UserRole } | undefined;
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

  // Role-change safety net (owner 2026-07-13): even a super_admin may not
  // change a super_admin's role or their own — that could demote the only
  // super_admin and lock everyone out. The UI hides the dropdown for these
  // cases; this strips it server-side too. A no-op change (role already the
  // requested value) is harmless.
  if ("role" in parsed.data && (target.role === "super_admin" || id === user.id)) {
    delete parsed.data.role;
  }

  // FT pay_cycle is system-managed. Two DIFFERENT ways to become FT (owner
  // 2026-07-30 — เกิดมาเป็น FT ไม่ใช่การแปลงจาก PT):
  //  • GENUINE PT→FT conversion (was actually 'pt') → first month weekly
  //    (fix-rate + WHT), stamp ft_started_at. Only 'pt' qualifies — someone who
  //    "รับค่าตอบแทนแบบพาร์ทไทม์มาก่อน" is what this transition month is for.
  //  • BORN-FT new hire (was NULL/unclassified → ft) → plain monthly FT: NO
  //    ft_started_at, pay_cycle stays monthly. Lands in the FT-monthly table and
  //    the first partial month prorates DAILY by hire_date (isFtPartialMonth) —
  //    the previous `!wasFt` test wrongly forced these into the weekly PT round.
  //  • already FT → don't let the form's hardcoded 'monthly' cut short an
  //    in-progress weekly transition; the boot migration flips to monthly on time.
  //  • clear_ft_transition → fix a born-FT wrongly stamped: clear ft_started_at +
  //    force monthly (handled in the ft_started_at section below).
  let convertToFt = false;
  const clearFtTransition = parsed.data.clear_ft_transition === true
    && userCanViewPayroll(user)
    && (parsed.data.employment_type ?? target.employment_type) === "ft";
  if (userCanViewPayroll(user) && !clearFtTransition) {
    const wasPt = target.employment_type === "pt";
    const wasFt = target.employment_type === "ft";
    const nowFt = parsed.data.employment_type === "ft";
    if (wasPt && nowFt) {
      convertToFt = true;
      parsed.data.pay_cycle = "weekly";
    } else if (wasFt && nowFt) {
      delete parsed.data.pay_cycle;
    }
    // born-FT (NULL/other → ft): leave pay_cycle as the form sent it (monthly),
    // and do NOT stamp ft_started_at — the monthly partial-month proration path
    // (keyed on hire_date) handles the first incomplete month.
  }
  if (clearFtTransition) {
    // Force monthly; the ft_started_at clear happens in the stamp section below.
    parsed.data.pay_cycle = "monthly";
  }
  // Never persist the control flag as a column.
  delete (parsed.data as { clear_ft_transition?: boolean }).clear_ft_transition;

  // Build dynamic UPDATE — only provided fields
  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  const data = parsed.data;

  // Helper to add a field if it was provided in the body
  function addField<K extends keyof typeof data>(key: K): void {
    if (key in data) {
      fields.push(`${String(key)} = ?`);
      const v = data[key];
      vals.push(v === undefined ? null : (v as string | number | null));
    }
  }

  // Account role (staff↔admin) — already gated/guarded to super_admin above.
  addField("role");
  // Profile
  addField("gender");
  addField("employment_type");
  addField("hire_date");
  // Weekly off — store as CSV "1,2" in weekly_off_days, mirror first day into
  // legacy weekly_off_day for backward compat with old reads
  if ("weekly_off_days" in data) {
    const arr = data.weekly_off_days;
    if (arr === null || arr === undefined || arr.length === 0) {
      fields.push("weekly_off_days = ?");
      vals.push(null);
      fields.push("weekly_off_day = ?");
      vals.push(null);
    } else {
      const sorted = [...new Set(arr)].sort((a, b) => a - b);
      fields.push("weekly_off_days = ?");
      vals.push(sorted.join(","));
      fields.push("weekly_off_day = ?");
      vals.push(sorted[0]);
    }
  }
  // Payroll
  addField("employee_code");
  addField("national_id");
  addField("bank_name");
  addField("bank_account");
  addField("tax_id");
  addField("sso_id");
  addField("hourly_rate");
  addField("monthly_salary");
  addField("pay_cycle");
  addField("salary_tax_mode");
  // จ่ายเงินเดือนช่วงเปลี่ยนผ่านครบถึงวันที่ (owner 2026-08-18) — normalise "" → NULL.
  if ("ft_salary_paid_through" in data) {
    fields.push("ft_salary_paid_through = ?");
    vals.push(data.ft_salary_paid_through ? data.ft_salary_paid_through : null);
  }
  // Group-insurance enrolment month — "" from the form clears to NULL.
  if ("group_insurance_start_month" in data) {
    fields.push("group_insurance_start_month = ?");
    const v = data.group_insurance_start_month;
    vals.push(v === "" || v === undefined ? null : v);
  }
  // Stamp the PT→FT effective date (owner-entered) so the pay engine keeps them
  // weekly for that calendar month, then the boot migration flips them to
  // monthly. Falls back to today if the client didn't send one.
  if (clearFtTransition) {
    // Born-FT correction — clear the transition stamp so ftEffectiveCycle +
    // the payroll staffWhere both treat them as a plain monthly FT.
    fields.push("ft_started_at = ?");
    vals.push(null);
  } else if (convertToFt) {
    const eff = parsed.data.ft_effective_date
      ?? new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    fields.push("ft_started_at = ?");
    vals.push(eff);
  } else if (
    userCanViewPayroll(user) &&
    parsed.data.ft_effective_date &&
    (parsed.data.employment_type ?? target.employment_type) === "ft"
  ) {
    // Correct/backfill an ALREADY-FT employee's transition date (owner
    // 2026-07-19: ธนะรัตน์ converted before ft_started_at existed → NULL → the
    // pay engine treated him as a full-month FT instead of a transition-month
    // weekly). Client only sends this when the admin actually changed the date.
    fields.push("ft_started_at = ?");
    vals.push(parsed.data.ft_effective_date);
  }
  // FT→PT switch date (owner 2026-08-31) — payroll-gated (money). From this date's
  // month the pay engine treats the (stored-FT) employee as part-time hourly.
  // clear_pt_switch wins (cancels a pending switch).
  if (userCanViewPayroll(user)) {
    if (parsed.data.clear_pt_switch) {
      fields.push("pt_started_at = ?");
      vals.push(null);
    } else if (parsed.data.pt_effective_date) {
      fields.push("pt_started_at = ?");
      vals.push(parsed.data.pt_effective_date);
    }
  }
  addField("line_user_id");
  // shift_start_time: empty string from form = clear to NULL
  if ("shift_start_time" in data) {
    fields.push("shift_start_time = ?");
    const v = data.shift_start_time;
    vals.push(v === "" || v === undefined ? null : v);
  }
  // Chain-of-command — null = top of chain / use system default.
  addField("reports_to_user_id");
  addField("escalation_hours");
  // Test-account flag — 0/1 boolean. Hide from operational lists when 1.
  addField("is_test_account");
  // Service-charge eligibility — 0/1 boolean. 0 = excluded from the branch pool.
  addField("receives_service_charge");
  // PDPA payroll-access grant — only present in parsed.data when
  // operator is super_admin (stripped above for everyone else).
  addField("can_view_payroll");
  // Mounjaro clinical access (already stripped above for non-super_admin)
  addField("clinical_role");
  addField("license_no");
  addField("is_hr_analytics");

  // ── Phase A profile (TC-P) ────────────────────────────────────
  // Plain string fields — same pattern as the existing payroll
  // fields above. addField() already handles null → null and
  // undefined → null.
  addField("title_prefix");
  addField("first_name_th");  addField("last_name_th");
  addField("first_name_en");  addField("last_name_en");
  addField("nickname_th");    addField("nickname_en");
  addField("dob");
  addField("nationality");    addField("race");
  addField("religion");       addField("marital_status");
  addField("military_status");addField("blood_type");
  addField("height_cm");      addField("weight_kg");
  addField("personal_notes");
  addField("personal_email"); addField("corporate_email");
  addField("mobile_phone");   addField("work_phone");
  addField("line_id");
  addField("house_address");  addField("house_subdistrict");
  addField("house_district"); addField("house_province");
  addField("house_postcode");
  addField("contact_address");  addField("contact_subdistrict");
  addField("contact_district"); addField("contact_province");
  addField("contact_postcode");
  addField("emergency_name");
  addField("emergency_relationship");
  addField("emergency_phone");
  addField("supervisor_user_id");
  addField("job_title");
  addField("contract_end_date");
  addField("employment_status");
  addField("hire_mode");
  addField("payment_method");
  addField("driver_license_no");
  addField("manpower_type");
  // Boolean → 0/1 fields. The addField helper would push true/false
  // verbatim and break SQLite typing, so handle inline.
  if ("contact_same_as_house" in data) {
    fields.push("contact_same_as_house = ?");
    vals.push(data.contact_same_as_house ? 1 : 0);
  }
  if ("track_attendance" in data) {
    fields.push("track_attendance = ?");
    vals.push(data.track_attendance ? 1 : 0);
  }
  if ("profile_self_edit_open" in data) {
    fields.push("profile_self_edit_open = ?");
    vals.push(data.profile_self_edit_open ? 1 : 0);
  }

  // PIN handled separately because we need to bcrypt-hash before storing
  if (data.pin !== undefined) {
    if (data.pin === "") {
      db.prepare("UPDATE users SET pin_hash = NULL WHERE id = ?").run(id);
    } else {
      const hash = bcrypt.hashSync(data.pin, 10);
      db.prepare("UPDATE users SET pin_hash = ? WHERE id = ?").run(hash, id);
    }
  }

  // RBAC role assignment — super_admin only (stripped above otherwise).
  // Not a users column, so handled separately from the dynamic UPDATE:
  // it replaces the user's full role set.
  const hasRoleIds = "role_ids" in data && user.role === "super_admin";

  if (fields.length === 0 && data.pin === undefined && !hasRoleIds) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  if (fields.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  }
  if (hasRoleIds) {
    setUserRoles(id, data.role_ids ?? [], user.id);
  }
  // Audit the account-role change (staff↔admin) — a privilege grant/revoke.
  if ("role" in data && data.role != null && data.role !== target.role) {
    logPersonaAction(user.id, "user.role_change", id);
  }
  return NextResponse.json({ ok: true });
}

// DELETE /api/admin/persona/employees/[id]
//
// Soft-delete an employee. Sets status='disabled', clears LINE binding,
// PARKS the username (so it can be reused), revokes any open invites, and
// terminates active sessions. We DON'T hard-delete the users row because many
// tables (bookings.created_by, persona_activity_log, payroll_lines, etc.)
// reference users(id) and a destructive cascade would lose operational/audit
// data.
//
// After the soft-delete:
//   • The user disappears from /admin/persona/employees (filtered).
//   • Their LINE userId is freed up — important when admin needs to
//     re-bind it to a different user row (e.g. fixing a misplaced
//     binding from a test account).
//   • Their username is parked to "<name>__disabled_<id>" (username is
//     UNIQUE) so a future hire/onboard can reuse the ORIGINAL username —
//     e.g. a mis-hire that's deleted and re-done (owner 2026-06-16). The
//     original is recoverable by stripping the suffix.
//   • Their active session is killed so they can't continue acting
//     under the old identity if they're currently logged in.
//   • Login is blocked (login route filters status='active' only).
//
// Safety guards:
//   • Can't soft-delete yourself.
//   • Only super_admin can soft-delete an admin or another super_admin.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  if (id === user.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }

  const db = getDb();
  const target = db.prepare(
    "SELECT id, role, status, display_name FROM users WHERE id = ?"
  ).get(id) as
    | { id: number; role: UserRole; status: string; display_name: string }
    | undefined;

  if (!target) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  if (target.status === "disabled") {
    return NextResponse.json({ error: "already_disabled" }, { status: 409 });
  }

  // Only super_admin can disable admin / super_admin accounts. Plain
  // admins are allowed to disable staff only.
  if (target.role !== "staff" && user.role !== "super_admin") {
    return NextResponse.json({ error: "super_admin_required_for_role" }, { status: 403 });
  }

  // All-in-one transaction so a crash partway can't leave a half-deleted
  // account (e.g. status=disabled but sessions still alive, or invites
  // still redeemable).
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET status = 'disabled',
          line_user_id = NULL,
          username = username || '__disabled_' || id
      WHERE id = ?
    `).run(id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    revokeOpenInvites(id, "user_disabled");
  });
  tx();

  logPersonaAction(user.id, "user.disable", id);

  return NextResponse.json({ ok: true });
}
