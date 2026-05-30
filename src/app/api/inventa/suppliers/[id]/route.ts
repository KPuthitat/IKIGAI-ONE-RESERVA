import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH  /api/inventa/suppliers/[id] — edit
// DELETE /api/inventa/suppliers/[id] — soft-delete (active = 0); items
//   referencing it keep their supplier_id so history stays intact.

const Body = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  code: z.string().trim().max(12).nullable().optional(),
  order_cycle: z.string().max(200).nullable().optional(),
  lead_time: z.string().max(200).nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
  note: z.string().max(1000).nullable().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
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
  const row = db.prepare("SELECT id FROM inventa_suppliers WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const fields: string[] = [];
  const vals: Array<string | null> = [];
  const set = (c: string, v: string | null | undefined) => {
    if (v !== undefined) { fields.push(`${c} = ?`); vals.push(v ?? null); }
  };
  if (d.name !== undefined) set("name", d.name.trim());
  if (d.code !== undefined) set("code", d.code ? d.code.trim() : null);
  set("order_cycle", d.order_cycle);
  set("lead_time", d.lead_time);
  set("contact", d.contact);
  set("note", d.note);
  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  vals.push(String(id));
  db.prepare(`UPDATE inventa_suppliers SET ${fields.join(", ")} WHERE id = ?`)
    .run(...vals);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const db = getDb();
  const row = db.prepare("SELECT id FROM inventa_suppliers WHERE id = ?").get(id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  db.prepare("UPDATE inventa_suppliers SET active = 0 WHERE id = ?").run(id);
  return NextResponse.json({ ok: true });
}
