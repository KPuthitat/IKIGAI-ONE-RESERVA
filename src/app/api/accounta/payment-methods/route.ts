import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listPaymentMethods, createPaymentMethod } from "@/lib/accounta-db";

// GET  /api/accounta/payment-methods — active channels (picklist)
// POST /api/accounta/payment-methods — add a channel (e.g. director credit
//      card · bank X) so future methods are categorised correctly.

const Body = z.object({ name: z.string().trim().min(1).max(60) });

export async function GET() {
  requirePermission("accounta.manage");
  return NextResponse.json({ ok: true, methods: listPaymentMethods() });
}

export async function POST(req: Request) {
  requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createPaymentMethod(parsed.data);
  return NextResponse.json({ ok: true, id, methods: listPaymentMethods() });
}
