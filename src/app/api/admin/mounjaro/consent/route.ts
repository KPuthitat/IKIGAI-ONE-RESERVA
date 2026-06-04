import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { setMounjaroConsent } from "@/lib/mounjaro-db";

// POST /api/admin/mounjaro/consent — super_admin edits the PDPA consent
// text for the Mounjaro program.
//   new_version=false → fix wording in place (no re-consent)
//   new_version=true  → publish a new version (active enrollees re-consent)
const Body = z.object({
  body: z.string().min(20).max(8000),
  new_version: z.boolean().optional()
});

export async function POST(req: Request) {
  const actor = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const res = setMounjaroConsent(parsed.data.body.trim(), !!parsed.data.new_version);
  logPersonaAction(actor.id, "mounjaro.consent.update", null);
  return NextResponse.json({ ok: true, version: res.version });
}
