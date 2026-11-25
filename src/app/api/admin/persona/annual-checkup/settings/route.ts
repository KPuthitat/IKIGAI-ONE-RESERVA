import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// Health report settings — owner only. Everything the report reads from the database and an owner may edit without a code change:
//   config (consult link behind SCAN ME, critical enzyme multiple) · an item's unit / printed reference / plausible range / "checked by the doctor"
//   · its reference ranges by sex and age · the "what is this?" texts · the doctor's ready-made wording.
export const dynamic = "force-dynamic";

const Ref = z.object({ sex: z.enum(["M", "F", "A"]), ageMin: z.number().int().min(0).max(130).nullable(), ageMax: z.number().int().min(0).max(130).nullable(), low: z.number().finite().nullable(), high: z.number().finite().nullable(), lowIncl: z.boolean(), highIncl: z.boolean() })
  .refine((r) => r.low != null || r.high != null, "range needs a low or a high")
  .refine((r) => r.low == null || r.high == null || r.low <= r.high, "low above high")
  .refine((r) => r.ageMin == null || r.ageMax == null || r.ageMin <= r.ageMax, "age band reversed");
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_config"), key: z.enum(["consult_url", "critical_enzyme_multiple"]), value: z.string().max(500) }),
  z.object({ action: z.literal("item_update"), itemId: z.number().int().positive(), unit: z.string().max(40).nullable().optional(), refText: z.string().max(400).nullable().optional(), plausibleMin: z.number().finite().nullable().optional(), plausibleMax: z.number().finite().nullable().optional(), confirmed: z.boolean().optional(), refs: z.array(Ref).max(12).optional() }),
  z.object({ action: z.literal("explanation_save"), key: z.string().min(1).max(40), title: z.string().max(300).nullable().optional(), body: z.string().min(1).max(8000) }),
  z.object({ action: z.literal("template_save"), id: z.number().int().positive().optional(), section: z.string().regex(/^[a-z_]{2,20}$/), kind: z.enum(["summary", "recommendation"]), text: z.string().min(1).max(1000), active: z.boolean().optional() }),
  z.object({ action: z.literal("template_delete"), id: z.number().int().positive() })
]);

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") return NextResponse.json({ ok: false, error: "forbidden", message: "เฉพาะเจ้าของระบบ" }, { status: 403 });
  const p = Body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง (ตรวจช่วงตัวเลขและช่วงอายุ)" }, { status: 400 });
  const d = p.data, db = getDb();
  if (d.action === "set_config") {
    const v = d.value.trim();
    if (d.key === "critical_enzyme_multiple" && !(Number(v) > 0 && Number(v) <= 100)) return NextResponse.json({ ok: false, error: "bad_value", message: "ใส่ตัวเลขระหว่าง 1 ถึง 100" }, { status: 400 });
    if (d.key === "consult_url" && v && !/^https:\/\//i.test(v)) return NextResponse.json({ ok: false, error: "bad_value", message: "ลิงก์ต้องขึ้นต้นด้วย https://" }, { status: 400 });
    db.prepare("INSERT INTO annual_checkup_config (key, value, updated_by, updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP").run(d.key, v, user.id);
  } else if (d.action === "item_update") {
    db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM annual_checkup_items WHERE id = ?").get(d.itemId)) throw new Error("no_item");
      db.prepare(`UPDATE annual_checkup_items SET unit = COALESCE(?, unit), ref_text = CASE WHEN ? = 1 THEN ? ELSE ref_text END, plausible_min = CASE WHEN ? = 1 THEN ? ELSE plausible_min END, plausible_max = CASE WHEN ? = 1 THEN ? ELSE plausible_max END, needs_check = CASE WHEN ? = 1 THEN 0 ELSE needs_check END WHERE id = ?`)
        .run(d.unit ?? null, d.refText !== undefined ? 1 : 0, d.refText?.trim() || null, d.plausibleMin !== undefined ? 1 : 0, d.plausibleMin ?? null, d.plausibleMax !== undefined ? 1 : 0, d.plausibleMax ?? null, d.confirmed ? 1 : 0, d.itemId);
      if (d.refs) {
        db.prepare("DELETE FROM annual_checkup_item_refs WHERE item_id = ?").run(d.itemId);
        const ins = db.prepare("INSERT INTO annual_checkup_item_refs (item_id, sex, age_min, age_max, low, high, low_incl, high_incl) VALUES (?,?,?,?,?,?,?,?)");
        for (const r of d.refs) ins.run(d.itemId, r.sex, r.ageMin, r.ageMax, r.low, r.high, r.lowIncl ? 1 : 0, r.highIncl ? 1 : 0);
      }
    })();
  } else if (d.action === "explanation_save") {
    db.prepare("INSERT INTO annual_checkup_explanations (key, title_th, body_th, updated_by, updated_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET title_th = excluded.title_th, body_th = excluded.body_th, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP").run(d.key, d.title ?? null, d.body, user.id);
  } else if (d.action === "template_save") {
    if (d.id) db.prepare("UPDATE annual_checkup_note_templates SET section = ?, kind = ?, text = ?, active = ? WHERE id = ?").run(d.section, d.kind, d.text, d.active === false ? 0 : 1, d.id);
    else db.prepare("INSERT INTO annual_checkup_note_templates (section, kind, text, sort_no) VALUES (?,?,?,(SELECT COALESCE(MAX(sort_no),0)+1 FROM annual_checkup_note_templates))").run(d.section, d.kind, d.text);
  } else db.prepare("DELETE FROM annual_checkup_note_templates WHERE id = ?").run(d.id);
  logPersonaAction(user.id, `health_report.settings.${d.action}`, 0);
  return NextResponse.json({ ok: true });
}
