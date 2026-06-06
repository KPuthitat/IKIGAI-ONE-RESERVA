"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiUrl } from "@/lib/url";
import { useLang } from "@/lib/LangProvider";
import Switch from "@/app/components/Switch";
import type { EmployeeProfile } from "@/lib/db";
import { nameWithPrefix } from "@/lib/name";

// Shared multi-section profile form.
//
//   mode="self"  → staff edits their own row. Some fields stay
//                  read-only (employment_status, supervisor, salary
//                  fields...) because they're admin-controlled.
//                  When the admin closes profile_self_edit_open the
//                  whole form locks.
//   mode="admin" → admin edits anyone. Everything is editable.
//
// The API endpoints differ — admin posts to /api/admin/persona/
// employees/[id] (already extended for Phase A), staff posts to
// /api/persona/profile.

export type ProfileSupervisor = { id: number; display_name: string; title_prefix: string | null };

type Mode = "self" | "admin";

export default function ProfileForm({
  mode, profile, supervisors
}: {
  mode: Mode;
  profile: EmployeeProfile;
  supervisors: ProfileSupervisor[];
}) {
  const router = useRouter();
  const { t } = useLang();
  const locked = mode === "self" && profile.profile_self_edit_open !== 1;
  const adminMode = mode === "admin";

  // We hold the whole form in a single state bag — way more concise
  // than ~50 separate useStates. Cast to keep TypeScript happy with
  // partial updates.
  const [f, setF] = useState({
    title_prefix:    profile.title_prefix ?? "",
    first_name_th:   profile.first_name_th ?? "",
    last_name_th:    profile.last_name_th ?? "",
    first_name_en:   profile.first_name_en ?? "",
    last_name_en:    profile.last_name_en ?? "",
    nickname_th:     profile.nickname_th ?? "",
    nickname_en:     profile.nickname_en ?? "",
    dob:             profile.dob ?? "",
    gender:          profile.gender ?? "",
    nationality:     profile.nationality ?? "ไทย",
    race:            profile.race ?? "ไทย",
    religion:        profile.religion ?? "",
    marital_status:  profile.marital_status ?? "",
    military_status: profile.military_status ?? "",
    blood_type:      profile.blood_type ?? "",
    height_cm:       profile.height_cm == null ? "" : String(profile.height_cm),
    weight_kg:       profile.weight_kg == null ? "" : String(profile.weight_kg),
    personal_notes:  profile.personal_notes ?? "",
    national_id:     profile.national_id ?? "",
    personal_email:  profile.personal_email ?? "",
    corporate_email: profile.corporate_email ?? "",
    mobile_phone:    profile.mobile_phone ?? "",
    work_phone:      profile.work_phone ?? "",
    line_id:         profile.line_id ?? "",
    house_address:        profile.house_address ?? "",
    house_subdistrict:    profile.house_subdistrict ?? "",
    house_district:       profile.house_district ?? "",
    house_province:       profile.house_province ?? "",
    house_postcode:       profile.house_postcode ?? "",
    contact_address:      profile.contact_address ?? "",
    contact_subdistrict:  profile.contact_subdistrict ?? "",
    contact_district:     profile.contact_district ?? "",
    contact_province:     profile.contact_province ?? "",
    contact_postcode:     profile.contact_postcode ?? "",
    contact_same_as_house: profile.contact_same_as_house === 1,
    emergency_name:         profile.emergency_name ?? "",
    emergency_relationship: profile.emergency_relationship ?? "",
    emergency_phone:        profile.emergency_phone ?? "",
    // Admin-only fields
    supervisor_user_id: profile.supervisor_user_id ?? "",
    job_title:          profile.job_title ?? "",
    contract_end_date:  profile.contract_end_date ?? "",
    employment_status:  profile.employment_status ?? "",
    track_attendance:   profile.track_attendance !== 0,
    hire_mode:          profile.hire_mode ?? "",
    payment_method:     profile.payment_method ?? "",
    driver_license_no:  profile.driver_license_no ?? "",
    manpower_type:      profile.manpower_type ?? "",
    profile_self_edit_open: profile.profile_self_edit_open === 1
  });
  const update = <K extends keyof typeof f>(k: K, v: typeof f[K]) =>
    setF((prev) => ({ ...prev, [k]: v }));

  // 2026-05 owner direction: identifiers + English-only fields should
  // auto-uppercase. Thai characters have no upper/lower distinction so
  // toUpperCase() is a no-op for those — safe to apply broadly.
  // Exclusions live next to each input directly (email / line_id /
  // free-text notes keep their case).
  const upperHandler = (k: keyof typeof f) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      update(k, e.target.value.toUpperCase() as typeof f[typeof k]);
  // CSS-only visual transform for instant feedback while typing — pairs
  // with upperHandler above. Also applied to date inputs so their
  // browser-rendered DD/MM/YYYY placeholder reads uppercase.
  const UPPER_STYLE: React.CSSProperties = { textTransform: "uppercase" };

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  // คำนำหน้า is mandatory (owner #9). Highlight the field when the
  // employee tries to save without choosing one.
  const [prefixError, setPrefixError] = useState(false);
  const prefixMissing = !f.title_prefix.trim();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Title prefix is required for everyone — block the save and point
    // the employee at the empty field rather than writing a NULL prefix.
    if (prefixMissing) {
      setPrefixError(true);
      setMsg({ kind: "err", text: t("staff.persona.profile.prefixRequired") });
      setTimeout(() => {
        document.querySelector('[data-prefix-field="true"]')
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      return;
    }
    setPrefixError(false);
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = {
        title_prefix:    f.title_prefix || null,
        first_name_th:   f.first_name_th || null,
        last_name_th:    f.last_name_th || null,
        first_name_en:   f.first_name_en || null,
        last_name_en:    f.last_name_en || null,
        nickname_th:     f.nickname_th || null,
        nickname_en:     f.nickname_en || null,
        dob:             f.dob || null,
        nationality:     f.nationality || null,
        race:            f.race || null,
        religion:        f.religion || null,
        marital_status:  f.marital_status || null,
        military_status: f.military_status || null,
        blood_type:      f.blood_type || null,
        height_cm:       f.height_cm.trim() === "" ? null : Number(f.height_cm),
        weight_kg:       f.weight_kg.trim() === "" ? null : Number(f.weight_kg),
        personal_notes:  f.personal_notes || null,
        national_id:     f.national_id || null,
        personal_email:  f.personal_email || null,
        corporate_email: f.corporate_email || null,
        mobile_phone:    f.mobile_phone || null,
        work_phone:      f.work_phone || null,
        line_id:         f.line_id || null,
        house_address:        f.house_address || null,
        house_subdistrict:    f.house_subdistrict || null,
        house_district:       f.house_district || null,
        house_province:       f.house_province || null,
        house_postcode:       f.house_postcode || null,
        contact_address:      f.contact_same_as_house ? f.house_address : f.contact_address || null,
        contact_subdistrict:  f.contact_same_as_house ? f.house_subdistrict : f.contact_subdistrict || null,
        contact_district:     f.contact_same_as_house ? f.house_district : f.contact_district || null,
        contact_province:     f.contact_same_as_house ? f.house_province : f.contact_province || null,
        contact_postcode:     f.contact_same_as_house ? f.house_postcode : f.contact_postcode || null,
        contact_same_as_house: f.contact_same_as_house,
        emergency_name:         f.emergency_name || null,
        emergency_relationship: f.emergency_relationship || null,
        emergency_phone:        f.emergency_phone || null
      };
      if (adminMode) {
        body.supervisor_user_id = f.supervisor_user_id ? Number(f.supervisor_user_id) : null;
        body.job_title          = f.job_title || null;
        body.contract_end_date  = f.contract_end_date || null;
        body.employment_status  = f.employment_status || null;
        body.track_attendance   = f.track_attendance;
        body.hire_mode          = f.hire_mode || null;
        body.payment_method     = f.payment_method || null;
        body.driver_license_no  = f.driver_license_no || null;
        body.manpower_type      = f.manpower_type || null;
        body.profile_self_edit_open = f.profile_self_edit_open;
      }
      const url = adminMode
        ? apiUrl(`/api/admin/persona/employees/${profile.id}`)
        : apiUrl("/api/persona/profile");
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setMsg({ kind: "err", text: j.error ?? t("common.error") });
        return;
      }
      setMsg({ kind: "ok", text: t("staff.persona.profile.saved") });
      router.refresh();
    } catch {
      setMsg({ kind: "err", text: t("common.error") });
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {locked && (
        <div className="card bg-amber-50 border-amber-200 text-sm text-amber-800">
          🔒 {t("staff.persona.profile.lockedHint")}
        </div>
      )}

      {/* Nudge existing employees to set their คำนำหน้า — we do NOT
          backfill prefixes automatically (owner #9). Shown only when
          the employee can actually edit their own profile. */}
      {!adminMode && !locked && prefixMissing && (
        <div className="card bg-sky-50 border-sky-200 text-sm text-sky-800">
          {t("staff.persona.profile.prefixPrompt")}
        </div>
      )}

      {/* ── Personal ───────────────────────────────────────── */}
      <Section title={t("staff.persona.profile.section.personal")}>
        <Grid>
          <Field label={t("staff.persona.profile.field.titlePrefix") + " *"}>
            <div data-prefix-field="true"
              className={prefixError && prefixMissing ? "rounded-lg ring-2 ring-rose-400" : ""}>
              <select className="input" value={f.title_prefix} disabled={locked}
                onChange={(e) => { update("title_prefix", e.target.value); if (e.target.value.trim()) setPrefixError(false); }}>
                <option value="">—</option>
                <option value="นาย">นาย</option>
                <option value="นาง">นาง</option>
                <option value="นางสาว">นางสาว</option>
                <option value="ดร.">ดร.</option>
                <option value="อื่นๆ">อื่นๆ</option>
              </select>
            </div>
          </Field>
          <Field label={t("staff.persona.profile.field.gender")}>
            <select className="input" value={f.gender} disabled
              title={t("staff.persona.profile.adminControlledHint")}>
              <option value="">—</option>
              <option value="male">{t("admin.persona.employees.gender.male")}</option>
              <option value="female">{t("admin.persona.employees.gender.female")}</option>
            </select>
          </Field>
          <Field label={t("staff.persona.profile.field.firstNameTh")}>
            <input className="input" value={f.first_name_th} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("first_name_th")} />
          </Field>
          <Field label={t("staff.persona.profile.field.lastNameTh")}>
            <input className="input" value={f.last_name_th} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("last_name_th")} />
          </Field>
          <Field label={t("staff.persona.profile.field.firstNameEn")}>
            <input className="input" value={f.first_name_en} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("first_name_en")} />
          </Field>
          <Field label={t("staff.persona.profile.field.lastNameEn")}>
            <input className="input" value={f.last_name_en} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("last_name_en")} />
          </Field>
          <Field label={t("staff.persona.profile.field.nicknameTh")}>
            <input className="input" value={f.nickname_th} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("nickname_th")} />
          </Field>
          <Field label={t("staff.persona.profile.field.nicknameEn")}>
            <input className="input" value={f.nickname_en} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("nickname_en")} />
          </Field>
          <Field label={t("staff.persona.profile.field.dob")}>
            <input type="date" className="input" value={f.dob} disabled={locked}
              style={UPPER_STYLE}
              onChange={(e) => update("dob", e.target.value)} />
          </Field>
          <Field label={t("staff.persona.profile.field.bloodType")}>
            <select className="input" value={f.blood_type} disabled={locked}
              onChange={(e) => update("blood_type", e.target.value)}>
              <option value="">—</option>
              <option value="A">A</option><option value="B">B</option>
              <option value="AB">AB</option><option value="O">O</option>
            </select>
          </Field>
          <Field label={t("staff.persona.profile.field.nationality")}>
            <input className="input" value={f.nationality} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("nationality")} />
          </Field>
          <Field label={t("staff.persona.profile.field.race")}>
            <input className="input" value={f.race} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("race")} />
          </Field>
          <Field label={t("staff.persona.profile.field.religion")}>
            <input className="input" value={f.religion} disabled={locked}
              style={UPPER_STYLE} onChange={upperHandler("religion")} />
          </Field>
          <Field label={t("staff.persona.profile.field.maritalStatus")}>
            <select className="input" value={f.marital_status} disabled={locked}
              onChange={(e) => update("marital_status", e.target.value)}>
              <option value="">—</option>
              <option value="single">โสด</option>
              <option value="married">สมรส</option>
              <option value="divorced">หย่า</option>
              <option value="widowed">หม้าย</option>
            </select>
          </Field>
          <Field label={t("staff.persona.profile.field.militaryStatus")}>
            <select className="input" value={f.military_status} disabled={locked}
              onChange={(e) => update("military_status", e.target.value)}>
              <option value="">—</option>
              <option value="exempt">ได้รับการยกเว้น</option>
              <option value="passed">ผ่านการเกณฑ์</option>
              <option value="served">เคยรับราชการ</option>
              <option value="pending">ยังไม่เกณฑ์</option>
            </select>
          </Field>
          <Field label={t("staff.persona.profile.field.heightCm")}>
            <input type="number" min={0} max={300} step={0.1} className="input"
              value={f.height_cm} disabled={locked}
              onChange={(e) => update("height_cm", e.target.value)} />
          </Field>
          <Field label={t("staff.persona.profile.field.weightKg")}>
            <input type="number" min={0} max={500} step={0.1} className="input"
              value={f.weight_kg} disabled={locked}
              onChange={(e) => update("weight_kg", e.target.value)} />
          </Field>
        </Grid>
        {/* National ID — staff fills it themselves so admin doesn't
            have to ask. Tax ID and SSO ID default to this same number
            in Thailand, so we only collect this one. PDPA-sensitive
            field; only stored, never displayed in notifications. */}
        <div className="mt-3">
          <label className="label">{t("staff.persona.profile.field.nationalId")}</label>
          <input className="input" type="text" inputMode="numeric" maxLength={13}
            value={f.national_id} disabled={locked}
            style={UPPER_STYLE}
            onChange={(e) => update("national_id", e.target.value.toUpperCase())}
            placeholder="13 DIGITS" />
          <p className="text-[10px] text-slate-400 mt-1">
            {t("staff.persona.profile.field.nationalIdHint")}
          </p>
        </div>
        <div className="mt-3">
          <label className="label">{t("staff.persona.profile.field.personalNotes")}</label>
          <textarea className="input" rows={2} maxLength={2000}
            value={f.personal_notes} disabled={locked}
            onChange={(e) => update("personal_notes", e.target.value)} />
        </div>
      </Section>

      {/* ── Contact ────────────────────────────────────────── */}
      <Section title={t("staff.persona.profile.section.contact")}>
        <Grid>
          <Field label={t("staff.persona.profile.field.mobilePhone")}>
            <input className="input" inputMode="tel" value={f.mobile_phone}
              disabled={locked} style={UPPER_STYLE}
              onChange={upperHandler("mobile_phone")} />
          </Field>
          <Field label={t("staff.persona.profile.field.workPhone")}>
            <input className="input" inputMode="tel" value={f.work_phone}
              disabled={locked} style={UPPER_STYLE}
              onChange={upperHandler("work_phone")} />
          </Field>
          <Field label={t("staff.persona.profile.field.personalEmail")}>
            <input className="input" type="email" value={f.personal_email}
              disabled={locked}
              onChange={(e) => update("personal_email", e.target.value)} />
          </Field>
          <Field label={t("staff.persona.profile.field.corporateEmail")}>
            <input className="input" type="email" value={f.corporate_email}
              disabled={!adminMode}
              title={!adminMode ? t("staff.persona.profile.adminControlledHint") : undefined}
              onChange={(e) => update("corporate_email", e.target.value)} />
          </Field>
          <Field label={t("staff.persona.profile.field.lineId")}>
            <input className="input" value={f.line_id} disabled={locked}
              onChange={(e) => update("line_id", e.target.value)} />
          </Field>
        </Grid>

        <div className="mt-4">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-[0.5px] mb-2">
            {t("staff.persona.profile.section.houseAddress")}
          </h3>
          <Grid>
            <Field label={t("staff.persona.profile.field.address")} colSpan={2}>
              <input className="input" value={f.house_address} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("house_address")} />
            </Field>
            <Field label={t("staff.persona.profile.field.subdistrict")}>
              <input className="input" value={f.house_subdistrict} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("house_subdistrict")} />
            </Field>
            <Field label={t("staff.persona.profile.field.district")}>
              <input className="input" value={f.house_district} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("house_district")} />
            </Field>
            <Field label={t("staff.persona.profile.field.province")}>
              <input className="input" value={f.house_province} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("house_province")} />
            </Field>
            <Field label={t("staff.persona.profile.field.postcode")}>
              <input className="input" inputMode="numeric" maxLength={5}
                value={f.house_postcode} disabled={locked} style={UPPER_STYLE}
                onChange={upperHandler("house_postcode")} />
            </Field>
          </Grid>
        </div>

        <div className="mt-4">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-[0.5px] mb-2">
            {t("staff.persona.profile.section.contactAddress")}
          </h3>
          <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer mb-2">
            <Switch checked={f.contact_same_as_house} disabled={locked}
              onChange={(v) => update("contact_same_as_house", v)} />
            {t("staff.persona.profile.field.contactSameAsHouse")}
          </label>
          {!f.contact_same_as_house && (
            <Grid>
              <Field label={t("staff.persona.profile.field.address")} colSpan={2}>
                <input className="input" value={f.contact_address} disabled={locked}
                  style={UPPER_STYLE} onChange={upperHandler("contact_address")} />
              </Field>
              <Field label={t("staff.persona.profile.field.subdistrict")}>
                <input className="input" value={f.contact_subdistrict} disabled={locked}
                  style={UPPER_STYLE} onChange={upperHandler("contact_subdistrict")} />
              </Field>
              <Field label={t("staff.persona.profile.field.district")}>
                <input className="input" value={f.contact_district} disabled={locked}
                  style={UPPER_STYLE} onChange={upperHandler("contact_district")} />
              </Field>
              <Field label={t("staff.persona.profile.field.province")}>
                <input className="input" value={f.contact_province} disabled={locked}
                  style={UPPER_STYLE} onChange={upperHandler("contact_province")} />
              </Field>
              <Field label={t("staff.persona.profile.field.postcode")}>
                <input className="input" inputMode="numeric" maxLength={5}
                  value={f.contact_postcode} disabled={locked} style={UPPER_STYLE}
                  onChange={upperHandler("contact_postcode")} />
              </Field>
            </Grid>
          )}
        </div>

        <div className="mt-4">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-[0.5px] mb-2">
            {t("staff.persona.profile.section.emergency")}
          </h3>
          <Grid>
            <Field label={t("staff.persona.profile.field.emergencyName")}>
              <input className="input" value={f.emergency_name} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("emergency_name")} />
            </Field>
            <Field label={t("staff.persona.profile.field.emergencyRelationship")}>
              <input className="input" value={f.emergency_relationship} disabled={locked}
                style={UPPER_STYLE} onChange={upperHandler("emergency_relationship")} />
            </Field>
            <Field label={t("staff.persona.profile.field.emergencyPhone")}>
              <input className="input" inputMode="tel" value={f.emergency_phone}
                disabled={locked} style={UPPER_STYLE}
                onChange={upperHandler("emergency_phone")} />
            </Field>
          </Grid>
        </div>
      </Section>

      {/* ── Employment — admin-only edit ────────────────────── */}
      {adminMode && (
        <Section title={t("staff.persona.profile.section.employment")}>
          <Grid>
            <Field label={t("staff.persona.profile.field.jobTitle")}>
              <input className="input" value={f.job_title} style={UPPER_STYLE}
                onChange={upperHandler("job_title")} />
            </Field>
            <Field label={t("staff.persona.profile.field.supervisor")}>
              <select className="input"
                value={f.supervisor_user_id === "" ? "" : String(f.supervisor_user_id)}
                onChange={(e) => update("supervisor_user_id", e.target.value === "" ? "" : Number(e.target.value))}>
                <option value="">—</option>
                {supervisors.filter((s) => s.id !== profile.id).map((s) => (
                  <option key={s.id} value={s.id}>{nameWithPrefix(s.title_prefix, s.display_name)}</option>
                ))}
              </select>
            </Field>
            <Field label={t("staff.persona.profile.field.employmentStatus")}>
              <select className="input" value={f.employment_status}
                onChange={(e) => update("employment_status", e.target.value)}>
                <option value="">—</option>
                <option value="probation">ทดลองงาน</option>
                <option value="permanent">บรรจุ</option>
              </select>
            </Field>
            <Field label={t("staff.persona.profile.field.contractEndDate")}>
              <input type="date" className="input" value={f.contract_end_date}
                style={UPPER_STYLE}
                onChange={(e) => update("contract_end_date", e.target.value)} />
            </Field>
            <Field label={t("staff.persona.profile.field.hireMode")}>
              <select className="input" value={f.hire_mode}
                onChange={(e) => update("hire_mode", e.target.value)}>
                <option value="">—</option>
                <option value="monthly">รายเดือน</option>
                <option value="daily">รายวัน</option>
                <option value="hourly">รายชั่วโมง</option>
              </select>
            </Field>
            <Field label={t("staff.persona.profile.field.paymentMethod")}>
              <select className="input" value={f.payment_method}
                onChange={(e) => update("payment_method", e.target.value)}>
                <option value="">—</option>
                <option value="bank">ธนาคาร</option>
                <option value="cash">เงินสด</option>
              </select>
            </Field>
            <Field label={t("staff.persona.profile.field.manpowerType")}>
              <select className="input" value={f.manpower_type}
                onChange={(e) => update("manpower_type", e.target.value)}>
                <option value="">—</option>
                <option value="new">ใหม่</option>
                <option value="replacement">ทดแทน</option>
              </select>
            </Field>
            <Field label={t("staff.persona.profile.field.driverLicenseNo")}>
              <input className="input" value={f.driver_license_no}
                style={UPPER_STYLE} onChange={upperHandler("driver_license_no")} />
            </Field>
          </Grid>
          <div className="mt-3 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={f.track_attendance}
                onChange={(v) => update("track_attendance", v)} />
              <span className="font-bold text-slate-700">
                {t("staff.persona.profile.field.trackAttendance")}
              </span>
              <span className="text-xs text-slate-500">
                {t("staff.persona.profile.field.trackAttendanceHint")}
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <Switch checked={f.profile_self_edit_open}
                onChange={(v) => update("profile_self_edit_open", v)} />
              <span className="font-bold text-slate-700">
                {t("staff.persona.profile.field.selfEditOpen")}
              </span>
              <span className="text-xs text-slate-500">
                {t("staff.persona.profile.field.selfEditOpenHint")}
              </span>
            </label>
          </div>
        </Section>
      )}

      {msg && (
        <div className={`text-sm text-center ${msg.kind === "ok" ? "text-emerald-700" : "text-rose-600"}`}>
          {msg.kind === "ok" ? "✓ " : "✗ "}{msg.text}
        </div>
      )}

      <button type="submit"
        disabled={busy || locked}
        className="btn-primary w-full text-base py-3.5">
        {busy ? t("common.submitting") : t("common.save")}
      </button>
    </form>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card space-y-3">
      <h2 className="font-bold text-slate-800 text-sm uppercase tracking-[0.5px]">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

function Field({
  label, colSpan, children
}: {
  label: string;
  colSpan?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <div className={colSpan === 2 ? "sm:col-span-2" : ""}>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}
