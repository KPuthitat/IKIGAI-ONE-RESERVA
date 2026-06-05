import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { addSelfLog, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// POST /api/mounjaro/self-log — employee logs their own weekly entry.
// Only works while their enrollment is 'active' (gateway enforces).

const Sev = z.number().int().min(0).max(3);
const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  weight: z.number().min(0).max(500).nullable().optional(),
  injection_done: z.boolean(),
  side_effect_diary: z.object({
    nausea: Sev, vomit: Sev, diarrhea: Sev, const: Sev,
    abdomen: Sev, tachy: Sev, fatigue: Sev, inject: Sev
  }).partial().default({}),
  notes_for_doctor: z.string().max(1000).optional(),
  // Daily vitals + food/exercise diary (2026-06-05).
  bp: z.string().max(20).optional(),
  hr: z.number().int().min(0).max(300).nullable().optional(),
  fbs: z.number().min(0).max(1000).nullable().optional(),
  diary: z.string().max(2000).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  try {
    addSelfLog(user as MjActor, {
      date: d.date,
      weight: d.weight ?? null,
      injection_done: d.injection_done,
      side_effect_diary: d.side_effect_diary,
      notes_for_doctor: d.notes_for_doctor ?? null,
      bp: d.bp ?? null,
      hr: d.hr ?? null,
      fbs: d.fbs ?? null,
      diary: d.diary ?? null
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) {
      return NextResponse.json({ error: "not_active" }, { status: 403 });
    }
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
