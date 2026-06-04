import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// PATCH  /api/admin/persona/health/[id] — edit an existing check-up row
// DELETE /api/admin/persona/health/[id] — remove a check-up record
//
// These act on a health_checkups row (a document), NOT a user account,
// so a hard DELETE is fine here — no cascade/audit concern like the
// users soft-delete. Admin / super_admin only.

const ItemSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  result: z.enum(["pass", "fail", "na"])
});

const Body = z.object({
  exam_type: z.enum(["pre_placement", "periodic", "return_to_work"]).optional(),
  checkup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  clinic_name: z.string().max(200).nullable().optional(),
  doctor_name: z.string().max(200).nullable().optional(),
  cert_no: z.string().max(100).nullable().optional(),
  overall_result: z.enum(["pass", "fail", "conditional"]).optional(),
  items: z.array(ItemSchema).max(50).nullable().optional(),
  attachment_url: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  const db = getDb();
  const row = db.prepare("SELECT id FROM health_checkups WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | null> = [];
  function add(col: string, v: string | null | undefined) {
    if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v); }
  }
  add("exam_type", d.exam_type);
  add("checkup_date", d.checkup_date);
  add("expiry_date", d.expiry_date ?? (("expiry_date" in d) ? null : undefined));
  add("clinic_name", d.clinic_name ?? (("clinic_name" in d) ? null : undefined));
  add("doctor_name", d.doctor_name ?? (("doctor_name" in d) ? null : undefined));
  add("cert_no", d.cert_no ?? (("cert_no" in d) ? null : undefined));
  add("overall_result", d.overall_result);
  if ("items" in d) {
    fields.push("items_json = ?");
    vals.push(d.items ? JSON.stringify(d.items) : null);
  }
  add("attachment_url", d.attachment_url ?? (("attachment_url" in d) ? null : undefined));
  add("notes", d.notes ?? (("notes" in d) ? null : undefined));

  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  fields.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(String(id));
  db.prepare(`UPDATE health_checkups SET ${fields.join(", ")} WHERE id = ?`)
    .run(...vals);

  logPersonaAction(user.id, "health.update", id);
  return NextResponse.json({ ok: true });
}

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

  const db = getDb();
  const row = db.prepare("SELECT id FROM health_checkups WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  db.prepare("DELETE FROM health_checkups WHERE id = ?").run(id);
  logPersonaAction(user.id, "health.delete", id);
  return NextResponse.json({ ok: true });
}
