import { NextResponse } from "next/server";
import { z } from "zod";
import { parseSubjectKey, submitToDoctor } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";
import { notifyDoctorsAwaiting } from "@/lib/annual-checkup-notify";

// POST {roundId, subject: "u<id>" | "e<id>"} — the recorder sends a person's finished drafts to the doctor, who is told on LINE (a count, no names).
const Body = z.object({ roundId: z.number().int().positive(), subject: z.string().regex(/^[ue]\d+$/) });

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    const subject = p.success ? parseSubjectKey(p.data.subject) : null;
    if (!p.success || !subject) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const r = submitToDoctor(user, p.data.roundId, subject);
    const notified = await notifyDoctorsAwaiting(p.data.roundId);
    return NextResponse.json({ ok: true, submittedAt: r.submitted_at, awaiting: r.awaiting, notifiedDoctors: notified });
  });
}
