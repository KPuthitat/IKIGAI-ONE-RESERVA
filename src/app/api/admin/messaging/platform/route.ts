import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { setPlatformChannel } from "@/lib/messaging-channels";

// PATCH /api/admin/messaging/platform — set/clear IKIGAI OS LINE creds.
//
// Both fields are optional in a single PATCH:
//   { channel_token: "abc..." }            → set token only, keep secret
//   { channel_secret: "xyz..." }           → set secret only, keep token
//   { channel_token: "", channel_secret: "" } → clear both
const Body = z.object({
  channel_token: z.string().max(500).optional(),
  channel_secret: z.string().max(200).optional()
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;
  if (d.channel_token === undefined && d.channel_secret === undefined) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }

  // Three-state: undefined = leave alone, "" = clear, non-empty = set.
  // Zod has already accepted strings (incl. empty string), so just pass through.
  setPlatformChannel({
    channel_token: d.channel_token,
    channel_secret: d.channel_secret,
    updated_by: user.id
  });

  return NextResponse.json({ ok: true });
}
