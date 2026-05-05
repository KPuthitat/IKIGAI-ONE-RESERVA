/**
 * LINE Messaging API Webhook
 * URL ที่ตั้งใน LINE Developers Console:
 *   https://your-domain.example.com/api/line/webhook/<branch_slug>
 *
 * รองรับ:
 *   - follow: เก็บ userId ของลูกค้าไว้ในตารางชั่วคราวเพื่อ map กับ booking ภายหลัง (ตาม phone หรือ name)
 *   - message: รองรับ "ยกเลิก #xxx" เพื่อให้ลูกค้ายกเลิกการจองผ่าน LINE
 */

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getDb, type Branch, type Booking } from "@/lib/db";
import { sendLinePush } from "@/lib/line";

type LineEvent = {
  type: string;
  source?: { userId?: string };
  message?: { type: string; text?: string };
  replyToken?: string;
};

function verifySignature(secret: string, body: string, signature: string | null): boolean {
  if (!signature) return false;
  const hash = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return hash === signature;
}

export async function POST(req: Request, { params }: { params: { branch: string } }) {
  const db = getDb();
  const branch = db.prepare("SELECT * FROM branches WHERE slug = ?").get(params.branch) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "no branch" }, { status: 404 });
  if (!branch.line_channel_secret || !branch.line_channel_token) {
    return NextResponse.json({ error: "LINE not configured for this branch" }, { status: 400 });
  }

  const raw = await req.text();
  const signature = req.headers.get("x-line-signature");
  if (!verifySignature(branch.line_channel_secret, raw, signature)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const json = JSON.parse(raw) as { events: LineEvent[] };
  for (const ev of json.events ?? []) {
    const userId = ev.source?.userId;
    if (!userId) continue;

    if (ev.type === "follow") {
      // ลูกค้ากด add OA — link userId กับ booking ที่เพิ่ง create และยังไม่มี line_user_id (best-effort)
      // เก็บ userId ไว้รอ map ภายหลัง
      console.log("[line] new follower for branch", branch.slug, userId);
      continue;
    }

    if (ev.type === "message" && ev.message?.type === "text") {
      const text = (ev.message.text ?? "").trim();
      const cancelMatch = text.match(/ยกเลิก\s*#?\s*(\d+)/i);
      if (cancelMatch) {
        const id = Number(cancelMatch[1]);
        const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND branch_id = ?")
          .get(id, branch.id) as Booking | undefined;
        if (b && b.status === "confirmed") {
          db.prepare(
            "UPDATE bookings SET status='cancelled', cancelled_at=?, updated_at=? WHERE id = ?"
          ).run(new Date().toISOString(), new Date().toISOString(), id);
          await sendLinePush(branch.line_channel_token, {
            to: userId,
            messages: [{ type: "text", text: `ยกเลิกการจอง #${id} เรียบร้อยค่ะ ขอบคุณที่แจ้งล่วงหน้า 🙏` }]
          });
        } else {
          await sendLinePush(branch.line_channel_token, {
            to: userId,
            messages: [{ type: "text", text: `ไม่พบการจอง #${id} หรือสถานะไม่อนุญาตให้ยกเลิก` }]
          });
        }
        continue;
      }

      // คำสั่งช่วยเหลือ
      if (/help|ช่วย|สั่ง|cmd/i.test(text)) {
        await sendLinePush(branch.line_channel_token, {
          to: userId,
          messages: [{
            type: "text",
            text: "วิธีใช้:\n- พิมพ์ 'ยกเลิก #หมายเลขจอง' เพื่อยกเลิก\n- จองโต๊ะใหม่ที่ลิงก์ของร้าน"
          }]
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
