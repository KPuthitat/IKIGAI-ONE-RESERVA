import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { createPatientRecord, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/baseline — a doctor takes a pending enrollment
// on as their patient: records baseline + flips enrollment to active.

const Flags = z.record(z.boolean()).default({});
const Body = z.object({
  enrollment_id: z.number().int().positive(),
  hn: z.string().max(40).optional(),
  baseline: z.record(z.number()).default({}),
  comorbidities: Flags, contraindications: Flags, medications: Flags,
  notes: z.string().max(2000).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  try {
    const id = createPatientRecord(user as MjActor, d.enrollment_id, {
      hn: d.hn ?? null, baseline: d.baseline, comorbidities: d.comorbidities,
      contraindications: d.contraindications, medications: d.medications,
      notes: d.notes ?? null, start_date: d.start_date ?? null
    });
    return NextResponse.json({ ok: true, patient_id: id });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
