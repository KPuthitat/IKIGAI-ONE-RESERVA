import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH /api/persona/profile — staff self-edit. Gated by the
// admin-controlled users.profile_self_edit_open flag: once admin
// flips that to 0, the entire endpoint short-circuits with
// `profile_locked` so staff can't keep changing things behind admin's
// back. The field set here is a STRICT SUBSET of the admin endpoint
// (no employment_status / supervisor / salary / etc.) so a staff
// can't elevate their own role by spoofing extra fields.

const Body = z.object({
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
  // National ID — 13 digits in Thailand, optional foreign passport
  // fallback. PDPA-sensitive; only collected so payroll & SSO docs
  // can quote it. Strict regex would reject foreign passports, so we
  // just cap length and let admin sanity-check.
  national_id:     z.string().max(20).nullable().optional(),
  personal_email:  z.string().max(120).nullable().optional(),
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
  emergency_phone:        z.string().max(40).nullable().optional()
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const db = getDb();
  const row = db.prepare(
    "SELECT profile_self_edit_open FROM users WHERE id = ?"
  ).get(user.id) as { profile_self_edit_open: number } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.profile_self_edit_open !== 1) {
    return NextResponse.json({ error: "profile_locked" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const fields: string[] = [];
  const vals: Array<string | number | null> = [];
  function addStr<K extends keyof typeof data>(k: K) {
    if (k in data) {
      fields.push(`${String(k)} = ?`);
      const v = data[k];
      vals.push((v === undefined || v === null) ? null : (v as string | number));
    }
  }
  addStr("title_prefix");
  addStr("first_name_th"); addStr("last_name_th");
  addStr("first_name_en"); addStr("last_name_en");
  addStr("nickname_th");   addStr("nickname_en");
  addStr("dob");           addStr("nationality");
  addStr("race");          addStr("religion");
  addStr("marital_status");addStr("military_status");
  addStr("blood_type");
  addStr("height_cm");     addStr("weight_kg");
  addStr("personal_notes");
  addStr("national_id");
  addStr("personal_email");
  addStr("mobile_phone");  addStr("work_phone");
  addStr("line_id");
  addStr("house_address"); addStr("house_subdistrict");
  addStr("house_district");addStr("house_province");
  addStr("house_postcode");
  addStr("contact_address"); addStr("contact_subdistrict");
  addStr("contact_district");addStr("contact_province");
  addStr("contact_postcode");
  addStr("emergency_name"); addStr("emergency_relationship");
  addStr("emergency_phone");
  if ("contact_same_as_house" in data) {
    fields.push("contact_same_as_house = ?");
    vals.push(data.contact_same_as_house ? 1 : 0);
  }
  if (fields.length === 0) return NextResponse.json({ error: "no_fields" }, { status: 400 });
  vals.push(user.id);
  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  logPersonaAction(user.id, "profile.self_update", user.id);
  return NextResponse.json({ ok: true });
}
