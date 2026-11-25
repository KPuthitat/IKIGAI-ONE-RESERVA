import { NextResponse } from "next/server";
import { z } from "zod";
import { fillMissingLdl } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {roundId} — with the LDL calculation mode on, fill LDL for everyone in the round who has total cholesterol, HDL and triglyceride
// but no LDL yet. Typed or verified LDL values are never touched.
const Body = z.object({ roundId: z.number().int().positive() });
export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    return NextResponse.json({ ok: true, filled: fillMissingLdl(user, p.data.roundId) });
  });
}
