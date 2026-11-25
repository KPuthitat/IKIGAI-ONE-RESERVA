import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, verifyAllForSubject } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, subject} — verify every draft result of one person (the doctor reviewed the whole booklet).
const Body = z.object({ roundId: z.number().int().positive(), subject: z.string().max(12) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    return NextResponse.json({ ok: true, verified: verifyAllForSubject(user, p.data.roundId, subject, { licenseUnlocked: isUnlocked(user) }) });
  });
}
