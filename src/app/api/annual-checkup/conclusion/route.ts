import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, saveConclusion } from "@/lib/annual-checkup-db";
import { handle, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, subject: "u12" | "e5", summary?, doctorComment?} — the doctor's summary for one person.
const Body = z.object({
  roundId: z.number().int().positive(), subject: z.string().max(12),
  summary: z.enum(["normal", "abnormal", "follow_up"]).nullable().optional(), doctorComment: z.string().max(4000).nullable().optional()
});

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    saveConclusion(user, p.data.roundId, subject, { summary: p.data.summary ?? null, doctorComment: p.data.doctorComment ?? null }, { licenseUnlocked: isUnlocked(user) });
    return NextResponse.json({ ok: true });
  });
}
