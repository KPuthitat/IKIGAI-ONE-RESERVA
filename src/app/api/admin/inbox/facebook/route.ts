import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { listFacebookChannels, setFacebookChannel } from "@/lib/facebook";

// Facebook Messenger channel config (owner 2026-09-29). super_admin only —
// holds Page tokens. Tokens are NEVER returned to the browser (a boolean "set"
// flag instead); the save keeps a stored token when its field is left blank.

export const dynamic = "force-dynamic";

function ensureSuperAdmin() {
  const user = getSessionUser();
  if (!user) return { user: null, res: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  if (user.role !== "super_admin") return { user: null, res: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { user, res: null };
}

function webhookUrl(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  return `${proto}://${host}/api/facebook/webhook`;
}

export function GET(req: Request) {
  const { res } = ensureSuperAdmin();
  if (res) return res;
  const channels = listFacebookChannels().map((c) => ({
    page_id: c.page_id, page_name: c.page_name, branch_id: c.branch_id,
    // Secrets (incl. the webhook verify token) are never sent back — only whether
    // they are set, so a captured GET response can't leak them.
    has_verify_token: !!c.verify_token,
    has_access_token: !!c.access_token, has_app_secret: !!c.app_secret
  }));
  const branches = (getDb().prepare("SELECT id, name FROM branches ORDER BY display_order, name").all()) as Array<{ id: number; name: string }>;
  return NextResponse.json({ ok: true, channels, branches, webhookUrl: webhookUrl(req) });
}

const Body = z.object({
  page_id: z.string().trim().min(1).max(64),
  page_name: z.string().trim().max(200).nullable().optional(),
  verify_token: z.string().trim().max(200).nullable().optional(),
  branch_id: z.number().int().positive().nullable().optional(),
  // Secrets — only sent when (re)setting them; blank/omitted keeps the stored value.
  access_token: z.string().trim().max(1000).optional(),
  app_secret: z.string().trim().max(400).optional()
});

export async function POST(req: Request) {
  const { user, res } = ensureSuperAdmin();
  if (res) return res;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  setFacebookChannel({
    pageId: d.page_id,
    pageName: d.page_name ?? null,
    branchId: d.branch_id ?? null,
    // undefined = keep stored secret; a non-empty string sets it. The verify
    // token is a shared secret too, so it follows the same keep-when-blank rule.
    verifyToken: d.verify_token ? d.verify_token : undefined,
    accessToken: d.access_token ? d.access_token : undefined,
    appSecret: d.app_secret ? d.app_secret : undefined,
    updatedBy: user!.id
  });
  return NextResponse.json({ ok: true });
}
