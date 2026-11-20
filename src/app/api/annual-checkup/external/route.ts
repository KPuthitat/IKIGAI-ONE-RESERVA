import { NextResponse } from "next/server";
import { z } from "zod";
import { setExternalName } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST {externalId, fullName, sex?, dob?} — give a "รอเพิ่มรายชื่อ" place its name (a person from an outside company, no account).
const Body = z.object({ externalId: z.number().int().positive(), fullName: z.string().min(1).max(200), sex: z.enum(["M", "F"]).nullable().optional(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() });

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณาใส่ชื่อ (และวันเกิดในรูปแบบ ปปปป-ดด-วว ถ้ามี)" }, { status: 400 });
    setExternalName(user, p.data.externalId, { fullName: p.data.fullName, sex: p.data.sex ?? null, dob: p.data.dob ?? null });
    return NextResponse.json({ ok: true });
  });
}
