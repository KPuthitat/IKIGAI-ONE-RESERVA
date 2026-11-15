import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, releaseSubject } from "@/lib/annual-checkup-db";
import { handle, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, subject} — open one person's results to them. (The LINE card is sent in phase 5, never with a value in it.)
const Body = z.object({ roundId: z.number().int().positive(), subject: z.string().max(12) });

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const released = releaseSubject(user, p.data.roundId, subject, { licenseUnlocked: isUnlocked(user) });
    return NextResponse.json({ ok: true, released });
  });
}
