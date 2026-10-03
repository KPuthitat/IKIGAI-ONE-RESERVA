import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMemberLink, deleteMember } from "@/lib/insigna";

// POST /api/insigna/members/delete — right to be forgotten from the member's
// own card: INSIGNA rows, bill links, pending links and the link token.

export const dynamic = "force-dynamic";
const Body = z.object({ t: z.string().min(8).max(200) });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const link = resolveMemberLink(parsed.data.t);
  if (!link) return NextResponse.json({ error: "bad_token" }, { status: 404 });
  const r = deleteMember(link.line_user_id);
  return NextResponse.json({ ok: true, deleted: r.deleted });
}
