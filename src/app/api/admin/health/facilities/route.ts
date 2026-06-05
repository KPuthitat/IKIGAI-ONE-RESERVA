import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { createHealthFacility } from "@/lib/health-facility";

// POST /api/admin/health/facilities — super_admin adds a health-consulting
// facility (name + license + address). The default one is what the health
// module pulls in place of the old hardcoded "AT HOME CLINIC".

const Body = z.object({
  name: z.string().min(2).max(200),
  license_no: z.string().max(100).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  logo_path: z.string().max(300).nullable().optional(),
  make_default: z.boolean().optional()
});

export async function POST(req: Request) {
  const actor = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const id = createHealthFacility({
    name: parsed.data.name,
    license_no: parsed.data.license_no ?? null,
    address: parsed.data.address ?? null,
    logo_path: parsed.data.logo_path ?? null,
    makeDefault: !!parsed.data.make_default
  });
  logPersonaAction(actor.id, "health.facility.create", id);
  return NextResponse.json({ ok: true, id });
}
