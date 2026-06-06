import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  addExerciseLog, deleteMyExerciseLog, isMounjaroForbidden, type MjActor
} from "@/lib/mounjaro-db";
import { getActivity } from "@/lib/exercise-catalog";

// POST   /api/mounjaro/exercise-log — employee logs one activity for a day
// DELETE /api/mounjaro/exercise-log?id=123 — remove one of their own rows
// Only works while the enrollment is 'active' (gateway enforces). met +
// level are taken from the catalog server-side, not trusted from the body.

const Body = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activity_id: z.string().min(1).max(20),
  // durationMin is editable; clamp to a sane range.
  duration_min: z.number().int().min(1).max(600),
  // RPE is mandatory (Borg CR10, 0–10).
  rpe: z.number().int().min(0).max(10)
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  if (!getActivity(d.activity_id)) {
    return NextResponse.json({ error: "unknown_activity" }, { status: 400 });
  }

  try {
    addExerciseLog(user as MjActor, {
      date: d.date, activityId: d.activity_id, durationMin: d.duration_min, rpe: d.rpe
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "not_active" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const ok = deleteMyExerciseLog(user as MjActor, id);
  return NextResponse.json({ ok });
}
