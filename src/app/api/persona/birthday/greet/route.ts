import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import { sendLinePush } from "@/lib/line";

// POST /api/persona/birthday/greet
//
// Anyone logged into the staff/admin app can send a birthday wish
// to a colleague whose dob matches today (or any picked day from
// the calendar). The message routes through the IKIGAI OS platform
// OA push API directly to the recipient's LINE userId.
//
// We intentionally don't gate this on "is today their actual
// birthday" — the calendar UI gates the affordance, and there are
// valid reasons to send wishes slightly early/late (someone's on
// leave during the day, weekend handoff, etc.). The to_user_id
// must reference a real user in the same branch as the sender so
// you can't dox arbitrary userIds via the endpoint.

const Body = z.object({
  to_user_id: z.number().int().positive(),
  message: z.string().trim().min(1).max(500)
});

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const sender = getSessionUser();
  if (!sender) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  if (parsed.data.to_user_id === sender.id) {
    return NextResponse.json(
      { error: "self_greet", message: "ส่งคำอวยพรให้ตัวเองไม่ได้นะ 😄" },
      { status: 400 }
    );
  }

  const db = getDb();

  // Verify the recipient shares a branch with the sender. Without
  // this check the endpoint would let anyone fire LINE messages at
  // any userId in the org just by guessing user ids.
  const recipient = db.prepare(`
    SELECT u.id, u.display_name, u.nickname_th, u.line_user_id,
           u.title_prefix
    FROM users u
    WHERE u.id = ?
      AND u.status NOT IN ('disabled', 'resigned', 'terminated')
      AND EXISTS (
        SELECT 1
        FROM user_branches ub1
        JOIN user_branches ub2 ON ub2.branch_id = ub1.branch_id
        WHERE ub1.user_id = ?
          AND ub2.user_id = ?
      )
  `).get(parsed.data.to_user_id, sender.id, parsed.data.to_user_id) as
    | { id: number; display_name: string; nickname_th: string | null;
        line_user_id: string | null; title_prefix: string | null }
    | undefined;

  if (!recipient) {
    return NextResponse.json(
      { error: "not_in_same_branch", message: "พนักงานคนนี้ไม่ได้อยู่สาขาเดียวกัน" },
      { status: 403 }
    );
  }

  if (!recipient.line_user_id) {
    return NextResponse.json(
      { error: "no_line_binding", message: "พนักงานคนนี้ยังไม่ได้เชื่อมต่อ LINE — ส่งไม่ได้" },
      { status: 422 }
    );
  }

  const channel = getPlatformChannel();
  if (!isChannelReady(channel) || !channel?.channel_token) {
    return NextResponse.json(
      { error: "channel_not_ready", message: "ระบบ LINE OA ยังไม่พร้อม กรุณาแจ้งแอดมิน" },
      { status: 503 }
    );
  }

  // Prepend a small "from <sender>" attribution so the recipient
  // knows who's wishing. Recipient sees the sender's nickname/display
  // name above the actual message body.
  const senderLabel = sender.title_prefix
    ? `${sender.title_prefix}${sender.display_name}`
    : sender.display_name;
  const text =
    `🎂 คำอวยพรวันเกิดจาก ${senderLabel}\n\n` +
    parsed.data.message;

  const result = await sendLinePush(channel.channel_token, {
    to: recipient.line_user_id,
    messages: [{ type: "text", text }]
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error || "push_failed",
        message: result.error === "monthly_quota_exceeded"
          ? "โควต้า LINE OA เดือนนี้หมดแล้ว ลองอีกครั้งเดือนหน้า"
          : "ส่งไม่สำเร็จ ลองอีกครั้ง"
      },
      { status: result.status >= 400 ? result.status : 502 }
    );
  }

  logPersonaAction(sender.id, "birthday.greet", recipient.id);

  return NextResponse.json({ ok: true });
}
