import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { acknowledge, PolicyError, POLICY_ERROR_TH } from "@/lib/policy-notices";

// POST {notice_id, suggestion?} → "รับทราบ", optionally with an anonymous suggestion. The only thing an employee can do with a notice.
const Body = z.object({ notice_id: z.number().int().positive(), suggestion: z.string().max(5000).optional() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const r = acknowledge(parsed.data.notice_id, user.id, parsed.data.suggestion);
    if (!r.already) logPersonaAction(user.id, "policy_notice_ack", parsed.data.notice_id);
    return NextResponse.json({ ok: true, ackedAt: r.ackedAt, already: r.already });
  } catch (e) {
    if (e instanceof PolicyError) return NextResponse.json({ error: e.code, message: POLICY_ERROR_TH[e.code] }, { status: e.code === "not_found" ? 404 : e.code === "not_recipient" ? 403 : 409 });
    throw e;
  }
}
