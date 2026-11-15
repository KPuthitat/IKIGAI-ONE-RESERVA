import { NextResponse } from "next/server";
import { z } from "zod";
import { setOrderClinical } from "@/lib/annual-checkup-db";
import { handle } from "@/lib/annual-checkup-api";

// POST {orderId, waiveReason?, externalLabName?} — the medical reason a test is waived and the outside lab's name. Clinical staff only;
// never shown to HR, managers or the employee.
const Body = z.object({ orderId: z.number().int().positive(), waiveReason: z.string().max(2000).nullable().optional(), externalLabName: z.string().max(200).nullable().optional() });

export async function POST(req: Request) {
  return handle(async (user) => {
    const p = Body.safeParse(await req.json().catch(() => ({})));
    if (!p.success) return NextResponse.json({ ok: false, error: "invalid_body", message: "ข้อมูลไม่ถูกต้อง" }, { status: 400 });
    setOrderClinical(user, p.data.orderId, { waiveReason: p.data.waiveReason ?? null, externalLabName: p.data.externalLabName ?? null });
    return NextResponse.json({ ok: true });
  });
}
