import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { setChannelCreds } from "@/lib/messaging-channels";

// Admin: configure DELIVERA LINE channels in-app (customer + ทีมงานส่งสุข).
// Writes to messaging_channels (scope='delivera'), token/secret encrypted. Same
// three-state semantics as RESERVA/RECRUITA: omitted = leave, "" = clear, value = set.
export const dynamic = "force-dynamic";

const One = z.object({
  channel_token: z.string().max(500).optional(),
  channel_secret: z.string().max(200).optional(),
  liff_id: z.string().max(120).optional()
});
const Body = z.object({
  kind: z.enum(["customer", "rider"]),
  creds: One
});

export async function POST(req: Request) {
  const user = requireAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const code = parsed.data.kind === "customer" ? "delivera-customer" : "delivera-rider";
  const r = setChannelCreds({ code, ...parsed.data.creds, updated_by: user.id });
  return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 404 });
}
