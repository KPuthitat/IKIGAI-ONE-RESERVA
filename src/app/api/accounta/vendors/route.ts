import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listVendors, createVendor } from "@/lib/accounta-db";

// GET  /api/accounta/vendors — active vendor master (for the picker)
// POST /api/accounta/vendors — add a vendor (de-duped on name)

const Body = z.object({
  name: z.string().trim().min(1).max(200),
  tax_id: z.string().trim().max(30).nullable().optional(),
  category: z.string().trim().max(100).nullable().optional()
});

export async function GET() {
  requirePermission("accounta.manage");
  return NextResponse.json({ ok: true, vendors: listVendors() });
}

export async function POST(req: Request) {
  const user = requirePermission("accounta.manage");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createVendor(user.id, parsed.data);
  return NextResponse.json({ ok: true, id });
}
