import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { deleteVisit, updateVisit, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// Same clinical fields as the POST create body, minus patient_id (immutable).
const Sev = z.number().int().min(0).max(3);
const EditBody = z.object({
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

// DELETE /api/admin/mounjaro/visit/[id] — remove one visit row from the
// doctor's own patient. Doctor + unlock gated; gateway re-scopes + audits.
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    deleteVisit(user as MjActor, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}

// PATCH /api/admin/mounjaro/visit/[id] — edit an existing visit record on the
// doctor's own patient. Same doctor + unlock gates as create/delete.
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = EditBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    updateVisit(user as MjActor, id, parsed.data);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
