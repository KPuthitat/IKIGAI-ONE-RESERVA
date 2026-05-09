/**
 * LINE Messaging API Webhook (multi-channel router)
 *
 * URL pattern in LINE Developers Console:
 *   https://your-domain.example.com/api/line/webhook/<code>
 *
 * <code> resolution order:
 *   1. messaging_channels.code  (preferred — used by IKIGAI OS platform OA
 *      and any future per-restaurant RESERVA OAs that have been migrated)
 *   2. branches.slug             (legacy — original RESERVA per-branch OA
 *      whose token/secret still live on the branches row)
 *
 * Behaviors per channel scope:
 *   - 'platform' (IKIGAI OS): only the staff-facing commands ("id", "help"),
 *     no booking commands.
 *   - 'reserva' / branch-slug: full RESERVA flow ("ยกเลิก #xxx", "id", "help").
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { sendLinePush } from "@/lib/line";
import { getChannelByCode } from "@/lib/messaging-channels";

type LineEvent = {
  type: string;
  source?: { userId?: string };
  message?: { type: string; text?: string };
  replyToken?: string;
};

type ResolvedChannel = {
  scope: "platform" | "reserva" | "legacy-branch";
  label: string;
  channel_secret: string;
  channel_token: string;
  branch: Branch | null;          // populated when scope is 'reserva' or 'legacy-branch'
};

/** Resolve the URL <code> param to a channel. Returns null if unknown / unconfigured. */
function resolveChannel(code: string): ResolvedChannel | null {
  const db = getDb();

  // 1) New table (preferred)
  const row = getChannelByCode(code);
  if (row && row.channel_secret && row.channel_token) {
    let branch: Branch | null = null;
    if (row.branch_id != null) {
      branch = (db.prepare("SELECT * FROM branches WHERE id = ?").get(row.branch_id) as Branch | undefined) ?? null;
    }
    return {
      scope: row.scope,
      label: row.label,
      channel_secret: row.channel_secret,
      channel_token: row.channel_token,
      branch
    };
  }

  // 2) Legacy: code matches a branch slug whose token/secret still live on branches
  const branch = db.prepare("SELECT * FROM branches WHERE slug = ?").get(code) as Branch | undefined;
  if (branch?.line_channel_secret && branch.line_channel_token) {
    return {
      scope: "legacy-branch",
      label: branch.name,
      channel_secret: branch.line_channel_secret,
      channel_token: branch.line_channel_token,
      branch
    };
  }

  return null;
}

function verifySignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

/** GET — health check for the webhook URL.
 *
 * LINE itself sends POST, so opening the URL in a browser would otherwise
 * 405. This handler lets admins sanity-check from any browser that the URL
 * is reachable and that credentials are saved on our side, without
 * exposing any secret values. Returns 200 even when not configured so the
 * page renders something readable. */
export function GET(_req: Request, { params }: { params: { branch: string } }) {
  const channel = resolveChannel(params.branch);
  return NextResponse.json({
    ok: true,
    code: params.branch,
    configured: !!channel,
    scope: channel?.scope ?? null,
    label: channel?.label ?? null,
    hint: channel
      ? "URL is reachable. LINE will call this endpoint via POST with x-line-signature."
      : "Channel not configured yet — paste the access token + secret in the admin page."
  });
}

export async function POST(req: Request, { params }: { params: { branch: string } }) {
  // The route param is named [branch] for backward-compat with old URLs;
  // semantically it's now a channel code.
  const channel = resolveChannel(params.branch);
  if (!channel) {
    return NextResponse.json({ error: "channel_not_configured", code: params.branch }, { status: 404 });
  }

  const raw = await req.text();
  const signature = req.headers.get("x-line-signature");
  if (!verifySignature(channel.channel_secret, raw, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const db = getDb();
  const json = JSON.parse(raw) as { events: LineEvent[] };
  for (const ev of json.events ?? []) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    if (ev.type === "follow") {
      console.log(`[line:${channel.scope}] new follower for ${channel.label}: ${userId}`);
      continue;
    }

    if (ev.type === "message" && ev.message?.type === "text") {
      const text = (ev.message.text ?? "").trim();

      // RESERVA-only: cancel a booking by ref
      if (channel.scope !== "platform" && channel.branch) {
        const cancelMatch = text.match(/ยกเลิก\s*#?\s*(\d+)/i);
        if (cancelMatch) {
          const id = Number(cancelMatch[1]);
          const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND branch_id = ?")
            .get(id, channel.branch.id) as Booking | undefined;
          if (b && b.status === "confirmed") {
            db.prepare(
              "UPDATE bookings SET status='cancelled', cancelled_at=?, updated_at=? WHERE id = ?"
            ).run(new Date().toISOString(), new Date().toISOString(), id);
            await sendLinePush(channel.channel_token, {
              to: userId,
              messages: [{ type: "text", text: `ยกเลิกการจอง #${id} เรียบร้อย ขอบคุณที่แจ้งล่วงหน้า` }]
            });
          } else {
            await sendLinePush(channel.channel_token, {
              to: userId,
              messages: [{ type: "text", text: `ไม่พบการจอง #${id} หรือสถานะไม่อนุญาตให้ยกเลิก` }]
            });
          }
          continue;
        }
      }

      // Universal: echo userId — used for binding staff (PERSONA) or
      // mapping a customer's LINE id to their booking later (RESERVA).
      if (/^\s*(id|ไอดี|myid|line\s*id)\s*$/i.test(text)) {
        const tail = channel.scope === "platform"
          ? "กรุณาบันทึกหน้าจอและส่งให้แอดมินเพื่อตั้งค่าในระบบ — หลังจากนั้นจะได้รับข้อความยืนยันการเข้างานทุกครั้ง"
          : "กรุณาบันทึกหน้าจอและส่งให้แอดมินเพื่อตั้งค่าในระบบ";
        await sendLinePush(channel.channel_token, {
          to: userId,
          messages: [{
            type: "text",
            text: `LINE User ID ของคุณ:\n${userId}\n\n${tail}`
          }]
        });
        continue;
      }

      // Help text — different per scope
      if (/help|ช่วย|สั่ง|cmd/i.test(text)) {
        const helpText = channel.scope === "platform"
          ? "วิธีใช้:\n- พิมพ์ 'id' เพื่อดู LINE User ID ของคุณ (พนักงานใช้สำหรับ bind ในระบบ)"
          : "วิธีใช้:\n- พิมพ์ 'ยกเลิก #หมายเลขจอง' เพื่อยกเลิก\n- พิมพ์ 'id' เพื่อดู LINE User ID ของคุณ\n- จองโต๊ะใหม่ที่ลิงก์ของร้าน";
        await sendLinePush(channel.channel_token, {
          to: userId,
          messages: [{ type: "text", text: helpText }]
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
