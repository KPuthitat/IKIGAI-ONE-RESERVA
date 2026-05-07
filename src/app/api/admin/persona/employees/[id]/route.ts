import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// PATCH /api/admin/persona/employees/[id] — admin update profile + payroll fields
// Note: ไม่อนุญาตเปลี่ยน role/username/password_hash/display_name (sync จาก Payroll)
const Body = z.object({
  // Profile
  gender: z.enum(["male", "female"]).nullable().optional(),
  employment_type: z.enum(["pt", "ft"]).nullable().optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  weekly_off_day: z.number().int().min(0).max(6).nullable().optional(),
  // Phase 1D — Payroll fields
  employee_code: z.string().max(40).nullable().optional(),
  national_id: z.string().max(20).nullable().optional(),
  bank_name: z.string().max(40).nullable().optional(),
  bank_account: z.string().max(40).nullable().optional(),
  tax_id: z.string().max(20).nullable().optional(),
  sso_id: z.string().max(20).nullable().optional(),
  hourly_rate: z.number().min(0).nullable().optional(),
  monthly_salary: z.number().min(0).nullable().optional(),
  pay_cycle: z.enum(["weekly", "monthly"]).nullable().optional()
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
  addField("weekly_off_day");
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

  if (fields.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  vals.push(id);

  db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  return NextResponse.json({ ok: true });
}
