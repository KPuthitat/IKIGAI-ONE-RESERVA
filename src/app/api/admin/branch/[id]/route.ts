import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Patch = z.object({
  open_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  close_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  slot_minutes: z.number().int().min(15).max(240).optional(),
  default_duration_minutes: z.number().int().min(15).max(480).optional(),
  reminder_minutes_before: z.number().int().min(0).max(720).optional(),
  line_channel_secret: z.string().max(200).optional(),
  line_channel_token: z.string().max(500).optional(),
  staff_line_user_ids: z.string().max(2000).optional(),
  // Branch status (Phase 1F.2)
  status: z.enum(["open", "coming_soon"]).optional(),
  opens_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  closed_weekdays: z.string().max(50).nullable().optional(),  // JSON array string
  // Lunch break (Phase 1F.3)
  lunch_break_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  lunch_break_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  lunch_break_weekdays: z.string().max(50).nullable().optional(),
  no_lunch_break_dates: z.string().max(2000).nullable().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "ต้องเป็นแอดมิน" }, { status: 403 });
  }
  const id = Number(params.id);
  if (!userHasBranch(user, id)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าสาขานี้" }, { status: 403 });
  }
  const parsed = Patch.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
  const updates: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) updates[k] = v;
  if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
  getDb().prepare(`UPDATE branches SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);
  return NextResponse.json({ ok: true });
}
