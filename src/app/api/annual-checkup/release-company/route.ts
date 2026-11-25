import { NextResponse } from "next/server";
import { z } from "zod";
import { releaseCompany } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {roundId, payerId} — open the results of every person of one paying company who is ready; the rest are listed with the reason.
const Body = z.object({ roundId: z.number().int().positive(), payerId: z.number().int().positive() });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    return NextResponse.json({ ok: true, ...releaseCompany(user, p.data.roundId, p.data.payerId, { licenseUnlocked: isUnlocked(user) }) });
  });
}
