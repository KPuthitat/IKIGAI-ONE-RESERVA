import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

// POST /api/admin/persona/holidays — upsert holiday
const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name_th: z.string().min(1).max(200),
  name_en: z.string().min(1).max(200),
  is_workday: z.boolean().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const { date, name_th, name_en, is_workday } = parsed.data;
  getDb().prepare(`
    INSERT INTO public_holidays (date, name_th, name_en, is_workday)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      name_th = excluded.name_th,
      name_en = excluded.name_en,
      is_workday = excluded.is_workday
  `).run(date, name_th, name_en, is_workday ? 1 : 0);

  return NextResponse.json({ ok: true });
}
