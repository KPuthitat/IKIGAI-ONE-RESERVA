import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { createPatientRecord, setEmployeeTitlePrefixByEnrollment, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/baseline — a doctor takes a pending enrollment
// on as their patient: records baseline + flips enrollment to active.

const Flags = z.record(z.boolean()).default({});
const Body = z.object({
  enrollment_id: z.number().int().positive(),
  hn: z.string().max(40).optional(),
  // คำนำหน้า — prefilled from the employee record, editable; persisted to
  // users.title_prefix (canonical) so the prefix shows everywhere.
  title_prefix: z.string().max(20).optional(),
  baseline: z.record(z.number()).default({}),
  // Non-numeric baseline extras (stored alongside the numeric clinical
  // values in baseline_json). bp is "120/80"; age/sex/phone are
  // demographics prefilled from the employee record.
  bp: z.string().max(20).optional(),
  age: z.number().int().min(0).max(120).optional(),
  sex: z.string().max(20).optional(),
  phone: z.string().max(40).optional(),
  comorbidities: Flags, contraindications: Flags, medications: Flags,
  notes: z.string().max(2000).optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

/** Merge the numeric baseline with the string/demographic extras into the
 *  single object persisted as baseline_json. */
function mergeBaseline(d: {
  baseline: Record<string, number>; bp?: string; age?: number; sex?: string; phone?: string;
}): Record<string, unknown> {
  const b: Record<string, unknown> = { ...d.baseline };
  if (d.bp) b.bp = d.bp;
  if (d.age != null) b.age = d.age;
  if (d.sex) b.sex = d.sex;
  if (d.phone) b.phone = d.phone;
  return b;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.clinical_role !== "doctor") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!isClinicalUnlocked(user)) return NextResponse.json({ error: "locked" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;

  try {
    // Persist a corrected/added title prefix to the employee record first
    // (canonical), so the patient view + every other surface shows it.
    if (d.title_prefix !== undefined && d.title_prefix.trim()) {
      setEmployeeTitlePrefixByEnrollment(d.enrollment_id, d.title_prefix);
    }
    const id = createPatientRecord(user as MjActor, d.enrollment_id, {
      hn: d.hn ?? null, baseline: mergeBaseline(d), comorbidities: d.comorbidities,
      contraindications: d.contraindications, medications: d.medications,
      notes: d.notes ?? null, start_date: d.start_date ?? null
    });
    return NextResponse.json({ ok: true, patient_id: id });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
