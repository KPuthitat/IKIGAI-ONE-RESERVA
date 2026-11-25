import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, returnToRecorder } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, subject, note} — the doctor sends a person's results back to the recorder with what to fix.
const Body = z.object({ roundId: z.number().int().positive(), subject: z.string().max(12), note: z.string().min(1).max(2000) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณาระบุสิ่งที่ต้องแก้" }, { status: 400 });
    returnToRecorder(user, p.data.roundId, subject, p.data.note, { licenseUnlocked: isUnlocked(user) });
    return NextResponse.json({ ok: true });
  });
}
