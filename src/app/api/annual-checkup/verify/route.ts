import { NextResponse } from "next/server";
import { z } from "zod";
import { isAnnualCheckupInvalid, verifyResult } from "@/lib/annual-checkup-db";
import { ERROR_TEXT, handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {ids: [resultId, ...]} — the approver doctor (licence unlocked) verifies draft results, one by one.
const Body = z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const unlocked = isUnlocked(user);
    const results = p.data.ids.map((id) => {
      try { verifyResult(user, id, { licenseUnlocked: unlocked }); return { id, ok: true as const }; }
      catch (e) {
        if (isAnnualCheckupInvalid(e)) return { id, ok: false as const, error: e.code, message: ERROR_TEXT[e.code] ?? e.code };
        throw e;                                    // not approver / not unlocked / DB refusal: the whole call is refused
      }
    });
    return NextResponse.json({ ok: true, results, verified: results.filter((r) => r.ok).length });
  });
}
