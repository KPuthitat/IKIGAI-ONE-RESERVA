import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/persona/employees/[id] — admin update profile + payroll fields
// Note: ไม่อนุญาตเปลี่ยน role/username/password_hash/display_name (sync จาก Payroll)
const Body = z.object({
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
  // LINE userId (33-char string starting with 'U'). Empty / null = unbind.
  line_user_id: z.string().max(64).nullable().optional(),
  // Expected shift start "HH:MM" — used by late-detection. Empty / null = unset
  // (no lateness computed for this staff member). Accepts both 1- and 2-digit hours.
  shift_start_time: z.string().regex(/^\d{1,2}:\d{2}$/).or(z.literal("")).nullable().optional(),
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

  const db = getDb();
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!target) return NextResponse.json({ error: "user_not_found" }, { status: 404 });

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
  addField("line_user_id");
  // shift_start_time: empty string from form = clear to NULL
  if ("shift_start_time" in data) {
    fields.push("shift_start_time = ?");
    const v = data.shift_start_time;
    vals.push(v === "" || v === undefined ? null : v);
  }

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

  if (fields.length === 0 && data.pin === undefined) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  if (fields.length > 0) {
    vals.push(id);
    db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  }
  return NextResponse.json({ ok: true });
}
