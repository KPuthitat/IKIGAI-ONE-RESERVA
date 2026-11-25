import { NextResponse } from "next/server";
import { z } from "zod";
import { addExternalPerson } from "@/lib/annual-checkup-db";
import { handleClinical } from "@/lib/annual-checkup-api";

// POST — a clinic recorder adds one outside examinee by hand (a person of a paying company who is not in the planning file).
// No account is created; the person gets the tests their company's programme gives to everyone. Only the last 4 of an ID are accepted.
const Body = z.object({
  roundId: z.number().int().positive(), payerId: z.number().int().positive(),
  title: z.string().max(20).nullable().optional(), firstName: z.string().min(1).max(100), lastName: z.string().max(100).default(""),
  sex: z.enum(["M", "F"]).nullable().optional(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  phone: z.string().max(40).nullable().optional(), email: z.string().max(120).nullable().optional(),
  idLast4: z.string().regex(/^[A-Za-z0-9]{4}$/).nullable().optional(), sponsorEmployeeCode: z.string().max(40).nullable().optional(), pdpa: z.boolean().optional()
});

export async function POST(req: Request) {
  return handleClinical(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "กรุณากรอกชื่อ บริษัท และวันเกิดในรูปแบบ ปปปป-ดด-วว (ถ้ามี) ส่วนเลขบัตรใส่เฉพาะ 4 ตัวท้าย" }, { status: 400 });
    const { roundId, payerId, ...d } = p.data;
    const r = addExternalPerson(user, roundId, payerId, d);
    return NextResponse.json({ ok: true, ...r });
  });
}
