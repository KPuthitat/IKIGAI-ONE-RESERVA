import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import {
  updatePatientRecord, softDeletePatient, isMounjaroForbidden, type MjActor
} from "@/lib/mounjaro-db";

// /api/admin/mounjaro/patient/[id]
//   PATCH  — edit an existing patient's baseline / flags ("แก้ไข")
//   DELETE — soft-delete the patient record ("ลบผู้ป่วย")
// Doctor + unlock gated; the gateway re-scopes to the attending doctor.

const Flags = z.record(z.boolean()).default({});
const Body = z.object({
  hn: z.string().max(40).optional(),
  baseline: z.record(z.number()).default({}),
  bp: z.string().max(20).optional(),
  age: z.number().int().min(0).max(120).optional(),
  sex: z.string().max(20).optional(),
  phone: z.string().max(40).optional(),
  comorbidities: Flags, contraindications: Flags, medications: Flags,
  notes: z.string().max(2000).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

function gate() {
  const user = getSessionUser();
  if (!user) return { error: "unauthenticated", status: 401 as const };
  if (user.clinical_role !== "doctor") return { error: "forbidden", status: 403 as const };
  if (!isClinicalUnlocked(user)) return { error: "locked", status: 403 as const };
  return { user };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const g = gate();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  const baseline: Record<string, unknown> = { ...d.baseline };
  if (d.bp) baseline.bp = d.bp;
  if (d.age != null) baseline.age = d.age;
  if (d.sex) baseline.sex = d.sex;
  if (d.phone) baseline.phone = d.phone;

  try {
    updatePatientRecord(g.user as MjActor, id, {
      hn: d.hn ?? null, baseline, comorbidities: d.comorbidities,
      contraindications: d.contraindications, medications: d.medications,
      notes: d.notes ?? null, start_date: d.start_date ?? null
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const g = gate();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  try {
    softDeletePatient(g.user as MjActor, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
