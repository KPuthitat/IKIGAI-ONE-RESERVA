import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { claimReward } from "@/lib/insigna";

// POST /api/insigna/reviews/claim  — any logged-in staff/admin.
//
// Front-of-house redemption: staff scan the reward QR (via น้องฮูก) or type
// the code, and this marks it used. Redeeming a voucher is an operational
// counter action, so it's gated by login rather than insigna.view (which
// admins use for the analytics back office). The scanned QR carries the plain
// code, but we also tolerate a URL/extra text and pull the IK-XXXXXX out.

export const dynamic = "force-dynamic";

const Body = z.object({ code: z.string().min(1).max(200) });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Accept a raw code or anything containing one (e.g. a scanned URL).
  const m = parsed.data.code.toUpperCase().match(/IK-[A-Z0-9]{6}/);
  const code = m ? m[0] : parsed.data.code.trim();

  const result = claimReward(code);
  logPersonaAction(user.id, "insigna.reviews_claim_scan", null);
  return NextResponse.json({ ok: result === "claimed", result, code });
}
