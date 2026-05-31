import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth";
import { setChannelCreds } from "@/lib/messaging-channels";

// POST /api/recruita/settings/channel
// Body: { channel_secret?, channel_token?, liff_id? }
// All three fields optional — omitted = leave alone, empty = clear.
// Sent values get encrypted at rest via setChannelCreds (secret-vault).

const Body = z.object({
  channel_secret: z.string().max(200).optional(),
  channel_token:  z.string().max(500).optional(),
  liff_id:        z.string().max(100).optional()
});

export async function POST(req: Request) {
  const user = requireSuperAdmin();
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const result = setChannelCreds({
    code: "ikigai-recruit",
    ...parsed.data,
    updated_by: user.id
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
