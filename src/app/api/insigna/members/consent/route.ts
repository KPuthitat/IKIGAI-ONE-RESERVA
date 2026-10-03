import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMemberLink, setMemberMarketingConsent, getMemberByHash } from "@/lib/insigna";

// POST /api/insigna/members/consent — the member flips their own marketing
// consent from the card (PDPA withdrawal). Token-gated.

export const dynamic = "force-dynamic";
const Body = z.object({ t: z.string().min(8).max(200), consent_marketing: z.boolean() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const link = resolveMemberLink(parsed.data.t);
  if (!link || !getMemberByHash(link.customer_hash)?.member_code) return NextResponse.json({ error: "bad_token" }, { status: 404 });
  setMemberMarketingConsent(link.customer_hash, parsed.data.consent_marketing);
  return NextResponse.json({ ok: true, consent_marketing: parsed.data.consent_marketing });
}
