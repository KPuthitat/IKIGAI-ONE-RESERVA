import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { setChannelCreds } from "@/lib/messaging-channels";

// PATCH /api/admin/messaging/channel/[code] — set/clear creds on any channel
// (platform OR per-branch RESERVA). Three-state semantics:
//   undefined → leave alone
//   ""        → clear (NULL)
//   non-empty → set
const Body = z.object({
  channel_token: z.string().max(500).optional(),
  channel_secret: z.string().max(200).optional(),
  liff_id: z.string().max(64).optional()
});

export async function PATCH(req: Request, { params }: { params: { code: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const code = params.code?.trim();
  if (!code) return NextResponse.json({ error: "invalid_code" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.channel_token === undefined && d.channel_secret === undefined && d.liff_id === undefined) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  const r = setChannelCreds({
    code,
    channel_token: d.channel_token,
    channel_secret: d.channel_secret,
    liff_id: d.liff_id,
    updated_by: user.id
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
