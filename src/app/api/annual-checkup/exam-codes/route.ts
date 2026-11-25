import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { handleClinical } from "@/lib/annual-checkup-api";
import { isRecorderEligible } from "@/lib/annual-checkup-db";
import { registerExamCodes } from "@/lib/health-report/lab-import";

// POST {roundId, text, dryRun?} — one line per person: "AHC69-0001 <employee code or full name>". Each line is answered separately; nothing is guessed.
const Body = z.object({ roundId: z.number().int().positive(), text: z.string().max(100_000), dryRun: z.boolean().optional() });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    if (!isRecorderEligible(user.id)) return NextResponse.json({ ok: false, error: "not_recorder", message: "ท่านไม่มีสิทธิ์ลงผลตรวจสุขภาพ" }, { status: 403 });
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    return NextResponse.json({ ok: true, lines: registerExamCodes(getDb(), user.id, p.data.roundId, p.data.text, p.data.dryRun === true) });
  });
}
