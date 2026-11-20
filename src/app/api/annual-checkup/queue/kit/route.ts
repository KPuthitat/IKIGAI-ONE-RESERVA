import { NextResponse } from "next/server";
import { z } from "zod";
import { setKitNo } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {queueId, kitNo} — correct the sample-kit number linked to a person. Clinic recorders only; a number already used in the round is refused.
const Body = z.object({ queueId: z.number().int().positive(), kitNo: z.string().min(1).max(60) });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณากรอกเลขชุด" }, { status: 400 });
    return NextResponse.json({ ok: true, scan: setKitNo(user, p.data.queueId, p.data.kitNo) });
  });
}
