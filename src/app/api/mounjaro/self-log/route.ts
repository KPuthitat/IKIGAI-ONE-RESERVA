import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { addSelfLog, updateSelfLog, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

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

// PATCH /api/mounjaro/self-log — edit an existing own entry (owner 2026-06-09).
// Editing health data requires the staff's PIN, and the change is audited
// (mounjaro_audit_log: action 'self_log_edit').
const EditBody = Body.extend({
  id: z.number().int().positive(),
  pin: z.string().regex(/^\d{4}$/)
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = EditBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  // PIN gate — same PIN as clock-in (users.pin_hash).
  const row = getDb().prepare("SELECT pin_hash FROM users WHERE id = ?")
    .get(user.id) as { pin_hash: string | null } | undefined;
  if (!row?.pin_hash) return NextResponse.json({ error: "no_pin_set" }, { status: 400 });
  if (!bcrypt.compareSync(d.pin, row.pin_hash)) {
    return NextResponse.json({ error: "wrong_pin" }, { status: 401 });
  }

  try {
    updateSelfLog(user as MjActor, d.id, {
      date: d.date,
      weight: d.weight ?? null,
      injection_done: d.injection_done,
      side_effect_diary: d.side_effect_diary,
      notes_for_doctor: d.notes_for_doctor ?? null,
      bp: d.bp ?? null, hr: d.hr ?? null, fbs: d.fbs ?? null, diary: d.diary ?? null
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) {
      return NextResponse.json({ error: "forbidden_or_not_active" }, { status: 403 });
    }
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
