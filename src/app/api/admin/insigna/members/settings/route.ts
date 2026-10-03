import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getMemberMessageConfig, saveMemberMessageConfig } from "@/lib/member-line";

// GET/POST /api/admin/insigna/members/settings — the birthday greeting and
// win-back texts pushed to consenting members. Blank = built-in default.

export const dynamic = "force-dynamic";
const Body = z.object({
  birthday_text: z.string().max(500).nullable().optional(),
  winback_text: z.string().max(500).nullable().optional()
});

export function GET() {
  requireAdmin();
  return NextResponse.json({ ok: true, ...getMemberMessageConfig() });
}

export async function POST(req: Request) {
  requireAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  return NextResponse.json({ ok: true, ...saveMemberMessageConfig(parsed.data) });
}
