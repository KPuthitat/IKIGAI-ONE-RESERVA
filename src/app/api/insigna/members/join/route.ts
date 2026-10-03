import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, type Branch } from "@/lib/db";
import { resolveMemberLink, registerMember } from "@/lib/insigna";
import { notifyMemberCard } from "@/lib/line";

// POST /api/insigna/members/join — public, token-gated (the customer's own
// link token from the LINE card). Registers or updates the member, then pushes
// the member card into their LINE chat. No PII in the body.

export const dynamic = "force-dynamic";

const Body = z.object({
  t: z.string().min(8).max(200),
  birth_day: z.number().int().min(1).max(31),
  birth_month: z.number().int().min(1).max(12),
  birth_year_be: z.number().int().min(2400).max(2700).nullable().optional(),
  gender: z.enum(["M", "F", "X"]),
  home_area: z.string().max(60).nullable().optional(),
  acquisition_source: z.string().max(30).nullable().optional(),
  consent_marketing: z.boolean().optional(),
  accept_notice: z.literal(true)
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const d = parsed.data;
  const link = resolveMemberLink(d.t);
  if (!link) return NextResponse.json({ error: "bad_token" }, { status: 404 });

  let member;
  try {
    member = registerMember({
      customer_hash: link.customer_hash,
      signup_branch_id: link.branch_id,
      birth_day: d.birth_day,
      birth_month: d.birth_month,
      birth_year: d.birth_year_be ? d.birth_year_be - 543 : null,
      gender: d.gender,
      home_area: d.home_area ?? null,
      acquisition_source: d.acquisition_source ?? null,
      consent_marketing: !!d.consent_marketing
    });
  } catch (e) {
    return NextResponse.json({ error: "register_failed", message: (e as Error).message }, { status: 422 });
  }

  // Push the card into their chat (best-effort; the page shows the code anyway).
  if (link.branch_id) {
    const branch = getDb().prepare("SELECT * FROM branches WHERE id = ?").get(link.branch_id) as Branch | undefined;
    if (branch) notifyMemberCard(branch, link.line_user_id).catch(() => { /* best-effort */ });
  }
  return NextResponse.json({ ok: true, member_code: member.member_code });
}
