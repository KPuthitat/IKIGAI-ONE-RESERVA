import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { inboxImageSource, inboxScopeFor } from "@/lib/inbox";
import { downloadLineContent } from "@/lib/line";

// GET /api/admin/inbox/media/[id] — stream the bytes of an inbound LINE IMAGE
// message so the inbox can render the real photo (owner 2026-09-26). Fetched
// on-demand from LINE by the stored message id; branch-scoped like the rest of
// the inbox. Stickers are NOT served here — the client renders those straight
// from LINE's public sticker CDN. The bytes are immutable per message, so a long
// private browser cache avoids refetching while a thread is open.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const { scope, hasAccess } = inboxScopeFor(user);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  if (!hasAccess) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const src = inboxImageSource(id, scope);
  if (!src) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const content = await downloadLineContent(src.token, src.lineMessageId);
  if (!content) return NextResponse.json({ error: "unavailable", message: "รูปหมดอายุจาก LINE แล้ว" }, { status: 404 });

  // Only trust an image/* content-type; anything else is served as an opaque
  // download with nosniff so a browser can't interpret it as active content.
  const safeMime = /^image\//.test(content.mime) ? content.mime : "application/octet-stream";
  return new NextResponse(new Uint8Array(content.buffer), {
    status: 200,
    headers: {
      "Content-Type": safeMime,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
