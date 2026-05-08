import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { upsertZone } from "@/lib/zones";

// POST /api/admin/reserva/zones — create a zone for the admin's active branch
const Body = z.object({
  name: z.string().trim().min(1).max(50),
  description: z.string().max(200).nullable().optional(),
  display_order: z.number().int().min(1).max(9999).optional(),
  active: z.union([z.literal(0), z.literal(1)]).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const id = upsertZone({
      branch_id: user.activeBranchId,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      display_order: parsed.data.display_order ?? 100,
      active: parsed.data.active ?? 1
    });
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE")) {
      return NextResponse.json({ error: "duplicate_name" }, { status: 409 });
    }
    return NextResponse.json({ error: "save_failed", detail: msg }, { status: 500 });
  }
}
