import { NextResponse } from "next/server";
import { z } from "zod";
import { recordResult } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {orderId, valueNum?, valueText?, unit?, refText?, interpretation?} — record / overwrite a DRAFT result of one ordered test.
// (An attached lab file is kept unless the body sends filePath explicitly; files themselves go through /file/upload.)
const ResultFields = z.object({
  orderId: z.number().int().positive(),
  valueNum: z.number().finite().nullable().optional(), valueText: z.string().max(2000).nullable().optional(),
  unit: z.string().max(40).nullable().optional(), refText: z.string().max(200).nullable().optional(),
  interpretation: z.enum(["normal", "abnormal", "follow_up"]).nullable().optional()
});

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = ResultFields.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    const { orderId, ...data } = p.data;
    const id = recordResult(user, orderId, data);
    return NextResponse.json({ ok: true, resultId: id });
  });
}
