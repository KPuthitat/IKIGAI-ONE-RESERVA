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
import { getDb, type Branch } from "@/lib/db";
import { sendLinePush } from "@/lib/line";
import { ingestLineBill, handleBillVerifyPostback } from "@/lib/accounta-line-bill";
import { getChannelByCode } from "@/lib/messaging-channels";

type LineEvent = {
  type: string;
  source?: {
    type?: "user" | "group" | "room";
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: { type: string; text?: string; id?: string; fileName?: string };
  postback?: { data?: string };
  replyToken?: string;
};

type ResolvedChannel = {
  scope: "platform" | "reserva" | "legacy-branch" | "recruita";
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
    // Group/room events have source.groupId / source.roomId instead of userId.
    // Handle those before the userId early-exit so admin gets the groupId
    // to paste into settings.
    if (ev.type === "join" && ev.source?.type === "group") {
      const groupId = ev.source.groupId;
      if (!groupId) continue;
      console.log(`[line:${channel.scope}] OA joined group ${groupId} for ${channel.label}`);
      // Reply in the group with the ID so admin (who's in the group) can
      // copy it. Push to group (1 msg) — counts toward LINE quota but
      // happens once per group ever. Scope-aware: the IKIGAI OS platform
      // OA serves BOTH the PERSONA staff group and the RECRUITA exec
      // group; RESERVA branch OAs serve booking staff groups. The
      // candidate-facing IKIGAI Recruit OA isn't used for group pushes,
      // so steer it back to IKIGAI OS.
      let reply: string;
      if (channel.scope === "recruita") {
        reply = `ℹ️ กลุ่มผู้บริหารรับสมัครงานใช้บอท IKIGAI OS (ไม่ใช่ IKIGAI Recruit)\nกรุณาเชิญบอท IKIGAI OS เข้ากลุ่มนี้แทน\n\nGroup ID:\n${groupId}`;
      } else if (channel.scope === "platform") {
        reply = `เพิ่ม OA เข้ากลุ่มเรียบร้อย\n\nGroup ID:\n${groupId}\n\nคัดลอก Group ID ด้านบนไปใส่ที่ ตั้งค่าระบบ ตามประเภทกลุ่ม:\n• กลุ่มพนักงาน (PERSONA) → กลุ่ม LINE พนักงานรวม\n• กลุ่มผู้บริหารรับสมัครงาน → "RECRUITA · กลุ่ม LINE ผู้บริหาร"`;
      } else {
        reply = `เพิ่ม OA เข้ากลุ่มเรียบร้อย\n\nGroup ID:\n${groupId}\n\nกรุณาคัดลอก Group ID ด้านบนนี้ไปใส่ในหน้าตั้งค่าของระบบ\n(/admin/reserva/settings → "กลุ่ม LINE พนักงาน")\n\nหลังจากตั้งค่าแล้ว ระบบจะส่งการแจ้งเตือนการจองใหม่เข้ากลุ่มนี้แทนการส่งหาพนักงานรายคน`;
      }
      await sendLinePush(channel.channel_token, {
        to: groupId,
        messages: [{ type: "text", text: reply }]
      });
      continue;
    }
    if (ev.type === "leave") {
      // OA was kicked from the group. Just log; don't auto-clear the
      // staff_group_id setting (admin should fix manually if intentional).
      const groupId = ev.source?.groupId;
      console.log(`[line:${channel.scope}] OA left group ${groupId} for ${channel.label}`);
      continue;
    }

    const userId = ev.source?.userId;
    if (!userId) continue;

    if (ev.type === "follow") {
      console.log(`[line:${channel.scope}] new follower for ${channel.label}: ${userId}`);
      // RECRUITA: when a candidate follows the "IKIGAI Recruit" OA,
      // greet them + try to link their LINE userId to the most
      // recent candidate row that doesn't yet have one. Phase 1e
      // matches by recency-only — the proper match (phone number
      // from the LINE profile, or a follow-up "id" reply) lands in
      // 1f. For now, a simple welcome message + a CTA back to the
      // public positions board.
      // RECRUITA: the system-sent follow welcome was REMOVED (owner
      // 2026-06-13). It contained a PUBLIC web link
      // (ikigaimedihealth.com/recruita/positions) which let new followers
      // apply via the web form — bypassing LIFF, so their LINE userId was
      // never captured and they fell into the "no notification" black hole.
      // The owner wants applicants to come ONLY through the Rich Menu
      // (a LIFF link that captures the userId). New followers now see just
      // the OA's own Greeting message (set in LINE OA Manager), which points
      // at the Rich Menu button. The "ID" text-reply fallback below still
      // works for anyone who needs manual linking.
      continue;
    }

    // ACCOUNTA bill verify (owner 2026-06-27). The staff member taps
    // ถูกต้อง / ไม่ตรง on the bill-verify card → record it on their draft.
    // Platform OA only; the data prefix keeps us off any unrelated postback.
    if (ev.type === "postback") {
      const data = ev.postback?.data ?? "";
      if (channel.scope === "platform" && data.startsWith("acct_bill_")) {
        await handleBillVerifyPostback({
          channelToken: channel.channel_token,
          senderUserId: userId,
          data
        });
      }
      continue;
    }

    // ACCOUNTA bill ingest (owner 2026-06-18). A bound staff member sends a
    // bill to the IKIGAI OS OA → OCR → draft expense. Accepts a photo
    // (image message) OR a PDF e-tax invoice (file message ending .pdf;
    // owner 2026-06-19). Non-PDF file messages are ignored so random docs
    // don't reach OCR. Only the platform (staff-facing) OA; RESERVA /
    // legacy-branch OAs are customer-facing so their uploads must never
    // reach OCR. Processed inline; the unique line_message_id index dedups
    // LINE's retry deliveries.
    const msg = ev.message;
    const isBillUpload = ev.type === "message" && !!msg?.id && (
      msg.type === "image" ||
      (msg.type === "file" && /\.pdf$/i.test(msg.fileName ?? ""))
    );
    if (isBillUpload && msg?.id) {
      // ONLY OCR bills sent in a 1:1 DM to the OA. Images posted in a
      // GROUP / room are NOT read — the OA sits in staff group chats (e.g.
      // the AT HOME CLINIC group) where people share all sorts of photos,
      // and OCR-ing every one of them is wrong + wastes API spend. Bills
      // must be DM'd to the OA. (owner 2026-06-20.)
      const isDirect = ev.source?.type === "user" || ev.source?.type == null;
      if (channel.scope === "platform" && isDirect) {
        await ingestLineBill({
          channelToken: channel.channel_token,
          senderUserId: userId,
          messageId: msg.id,
          replyToken: ev.replyToken,
          isDirect: true
        });
      }
      continue;
    }

    if (ev.type === "message" && ev.message?.type === "text") {
      const text = (ev.message.text ?? "").trim();

      // RESERVA: legacy "ยกเลิก #X" path — DISABLED. Self-serve
      // cancellation by typing in chat was unreliable (regex didn't
      // accept the R-prefixed ref format etc.) so we steered everyone
      // to the tel: button on the Flex card. We still detect the
      // pattern here so customers who type out of habit get a polite
      // redirect to call instead of silence.
      if (channel.scope !== "platform" && channel.branch) {
        const cancelMatch = text.match(/ยกเลิก\s*#?\s*[A-Z0-9]+/i);
        if (cancelMatch) {
          // Read the branch's contact phone (if configured) so we can
          // tell the customer exactly which number to call. Falls back
          // to a generic "please call the restaurant" line.
          const branchRow = db.prepare(
            "SELECT contact_phone FROM branches WHERE id = ?"
          ).get(channel.branch.id) as { contact_phone: string | null } | undefined;
          const phone = branchRow?.contact_phone?.trim();
          const reply = phone
            ? `ขออภัย การยกเลิกผ่านแชทไม่รองรับแล้ว กรุณาโทรติดต่อร้านที่ ${phone} เพื่อยกเลิกการจอง`
            : "ขออภัย การยกเลิกผ่านแชทไม่รองรับแล้ว กรุณาติดต่อร้านโดยตรงเพื่อยกเลิกการจอง";
          await sendLinePush(channel.channel_token, {
            to: userId,
            messages: [{ type: "text", text: reply }]
          });
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

      // Help text — different per scope. Anchored to whole-message
      // match (^...$) so we don't trigger on every chat that happens
      // to contain "สั่ง" as a substring — that was bombing staff
      // with help-text spam any time anyone wrote "สั่งอาหาร",
      // "ส่งคำสั่ง", "สั่งงาน", etc. (Same anchoring pattern as the
      // 'id' branch above; missed in the original code.) Drop "สั่ง"
      // entirely — it never appears as a standalone message anyway.
      if (/^\s*(help|ช่วย|cmd|menu|วิธีใช้)\s*$/i.test(text)) {
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
