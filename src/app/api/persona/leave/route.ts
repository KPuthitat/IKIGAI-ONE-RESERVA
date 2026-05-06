import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const LEAVE_TYPES = [
  "sick", "personal", "annual", "maternity",
  "ordination", "sterilization", "pilgrimage", "military"
] as const;

const Body = z.object({
  type: z.enum(LEAVE_TYPES),
  date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().positive().max(365),
  reason: z.string().max(500).optional()
});

// POST /api/persona/leave — staff submit leave request
export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { type, date_from, date_to, days, reason } = parsed.data;

  // Validate date range
  if (date_from > date_to) {
    return NextResponse.json({ error: "date_range_invalid" }, { status: 400 });
  }

  const db = getDb();
  const nowIso = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO leave_requests
      (user_id, type, date_from, date_to, days, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(user.id, type, date_from, date_to, days, reason ?? null, nowIso);

  return NextResponse.json({ ok: true, id: result.lastInsertRowid });
}
