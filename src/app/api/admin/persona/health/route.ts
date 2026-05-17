import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/health — record a new health check-up
// (food-handler cert / ส.ณ.11) for an employee. Admin or super_admin
// only. Keeps full history — every call inserts a new row; the UI
// shows the latest by checkup_date.

const ItemSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  result: z.enum(["pass", "fail", "na"])
});

const Body = z.object({
  user_id: z.number().int().positive(),
  checkup_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  clinic_name: z.string().max(200).nullable().optional(),
  doctor_name: z.string().max(200).nullable().optional(),
  cert_no: z.string().max(100).nullable().optional(),
  overall_result: z.enum(["pass", "fail", "conditional"]),
  items: z.array(ItemSchema).max(50).optional(),
  attachment_url: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(d.user_id);
  if (!target) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  const info = db.prepare(`
    INSERT INTO health_checkups
      (user_id, branch_id, checkup_date, expiry_date, clinic_name,
       doctor_name, cert_no, overall_result, items_json, attachment_url,
       notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.user_id,
    user.activeBranchId ?? null,
    d.checkup_date,
    d.expiry_date ?? null,
    d.clinic_name ?? null,
    d.doctor_name ?? null,
    d.cert_no ?? null,
    d.overall_result,
    d.items ? JSON.stringify(d.items) : null,
    d.attachment_url ?? null,
    d.notes ?? null,
    user.id
  );

  logPersonaAction(user.id, "health.create", Number(info.lastInsertRowid));

  return NextResponse.json({ ok: true, id: Number(info.lastInsertRowid) });
}
