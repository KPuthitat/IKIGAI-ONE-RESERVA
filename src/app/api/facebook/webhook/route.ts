import { NextResponse } from "next/server";
import { getFacebookChannel, findFacebookChannelByVerifyToken, verifyFbSignature } from "@/lib/facebook";
import { recordInbound } from "@/lib/inbox";

// Facebook Messenger webhook (owner 2026-09-29). GET = Meta's verification
// handshake; POST = incoming messages → recorded into the น้องฮูก inbox
// (channel='facebook'). Signature-verified with the Page's App Secret.
//
// Set this URL as the Messenger webhook callback in the Meta app, with the same
// Verify Token saved on the Page in ANALYTICA/Inbox settings.

export const dynamic = "force-dynamic";

// GET — verification handshake. Echo hub.challenge only when the verify token
// matches a configured Page's token.
export function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token") ?? "";
  const challenge = sp.get("hub.challenge") ?? "";
  if (mode === "subscribe" && findFacebookChannelByVerifyToken(token)) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse("forbidden", { status: 403 });
}

type FbMessaging = {
  sender?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string }> };
};
type FbEntry = { id?: string; messaging?: FbMessaging[] };

// POST — incoming events. Always ack 200 quickly so Meta doesn't retry; do the
// (best-effort) work inline but never throw. Non-message events are ignored.
export async function POST(req: Request) {
  const raw = await req.text();
  let payload: { object?: string; entry?: FbEntry[] };
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ ok: true }); }
  if (payload?.object !== "page" || !Array.isArray(payload.entry)) return NextResponse.json({ ok: true });

  const sig = req.headers.get("x-hub-signature-256");
  for (const entry of payload.entry) {
    const pageId = entry.id;
    if (!pageId) continue;
    const ch = getFacebookChannel(pageId);
    // Unknown page or missing secret → ignore. Verify the signature with THIS
    // page's app secret before trusting anything in the body.
    if (!ch?.app_secret || !verifyFbSignature(ch.app_secret, raw, sig)) continue;

    for (const m of entry.messaging ?? []) {
      const psid = m.sender?.id;
      const msg = m.message;
      // Skip echoes (our own outbound) and non-message events (delivery/read).
      if (!psid || !msg || msg.is_echo) continue;
      const hasAttach = Array.isArray(msg.attachments) && msg.attachments.length > 0;
      const text = (msg.text ?? "").trim() || (hasAttach ? "[ไฟล์แนบจาก Messenger]" : "");
      if (!text) continue;
      try {
        recordInbound({
          channel: "facebook",
          channel_code: pageId,
          branch_id: ch.branch_id,
          line_user_id: psid,
          text,
          external_message_id: msg.mid ?? null
        });
      } catch { /* best-effort — never fail the ack */ }
    }
  }
  return NextResponse.json({ ok: true });
}
