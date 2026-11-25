import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, saveSectionNote } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, subject, section, summary?, recommendation?} — the doctor's wording for one section ("overall" = closing summary).
const Body = z.object({
  roundId: z.number().int().positive(), subject: z.string().max(12), section: z.string().regex(/^[a-z_]{2,20}$/),
  summary: z.string().max(4000).nullable().optional(), recommendation: z.string().max(4000).nullable().optional()
});

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    saveSectionNote(user, p.data.roundId, subject, p.data.section, { summary: p.data.summary ?? null, recommendation: p.data.recommendation ?? null }, { licenseUnlocked: isUnlocked(user) });
    return NextResponse.json({ ok: true });
  });
}
