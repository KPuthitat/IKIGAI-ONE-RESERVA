import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { addVisit, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/visit — doctor records a visit on their patient.

const Sev = z.number().int().min(0).max(3);
const Body = z.object({
  patient_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dose: z.union([z.literal(2.5), z.literal(5), z.literal(7.5), z.literal(10), z.literal(12.5), z.literal(15)]).nullable().optional(),
  weight: z.number().min(0).max(500).nullable().optional(),
  bp: z.string().max(20).optional(),
  hr: z.number().int().min(0).max(300).nullable().optional(),
  hba1c: z.number().min(0).max(30).nullable().optional(),
  fbs: z.number().min(0).max(1000).nullable().optional(),
  waist: z.number().min(0).max(500).nullable().optional(),
  side_effects: z.record(Sev).default({}),
  hypo_count: z.number().int().min(0).max(99).nullable().optional(),
  adherence: z.enum(["full", "missed1", "missed2", "held"]).nullable().optional(),
  decision: z.enum(["maintain", "increase", "decrease", "hold"]).nullable().optional(),
  next_visit: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(2000).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const { patient_id, ...rest } = parsed.data;

  try {
    addVisit(user as MjActor, patient_id, rest);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
