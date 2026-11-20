import { NextResponse } from "next/server";
import { z } from "zod";
import { reviseResult } from "@/lib/annual-checkup-db";
import { handleClinical, isUnlocked } from "@/lib/annual-checkup-api";

// POST {resultId, reason, valueNum?, valueText?, unit?, refText?, interpretation?} — a revision of a verified / released result.
const Body = z.object({
  resultId: z.number().int().positive(), reason: z.string().min(1).max(500),
  valueNum: z.number().finite().nullable().optional(), valueText: z.string().max(2000).nullable().optional(),
  unit: z.string().max(40).nullable().optional(), refText: z.string().max(200).nullable().optional(),
  interpretation: z.enum(["normal", "abnormal", "follow_up"]).nullable().optional()
});

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณาระบุเหตุผลและค่าที่ถูกต้อง" }, { status: 400 });
    const { resultId, reason, ...data } = p.data;
    reviseResult(user, resultId, data, reason, { licenseUnlocked: isUnlocked(user) });
    return NextResponse.json({ ok: true });
  });
}
