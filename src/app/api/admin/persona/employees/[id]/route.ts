import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/persona/employees/[id] — admin update profile fields
// Note: ไม่อนุญาตเปลี่ยน role/username/password_hash/display_name (sync จาก Payroll)
const Body = z.object({
  gender: z.enum(["male", "female"]).nullable().optional(),
  employment_type: z.enum(["pt", "ft"]).nullable().optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  weekly_off_day: z.number().int().min(0).max(6).nullable().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

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
  if ("gender" in parsed.data) {
    fields.push("gender = ?");
    vals.push(parsed.data.gender ?? null);
  }
  if ("employment_type" in parsed.data) {
    fields.push("employment_type = ?");
    vals.push(parsed.data.employment_type ?? null);
  }
  if ("hire_date" in parsed.data) {
    fields.push("hire_date = ?");
    vals.push(parsed.data.hire_date ?? null);
  }
  if ("weekly_off_day" in parsed.data) {
    fields.push("weekly_off_day = ?");
    vals.push(parsed.data.weekly_off_day ?? null);
  }
  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  vals.push(id);

  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  return NextResponse.json({ ok: true });
}
