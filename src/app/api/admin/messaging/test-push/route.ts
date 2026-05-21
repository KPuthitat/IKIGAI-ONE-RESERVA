import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import { getPlatformChannel } from "@/lib/messaging-channels";
import { sendLinePush } from "@/lib/line";

// POST /api/admin/messaging/test-push
//
// Diagnostic helper for the LINE OA setup. Reads whatever credentials
// + group id are currently saved, builds a one-line test message, and
// pushes it via the real LINE API. The response includes the actual
// LINE API status code + body so the admin can see exactly why a push
// fails (invalid token, group not joined, rate-limited, etc.) instead
// of the generic "ส่งไม่สำเร็จ" they get from the auto-flow.
//
// Auth: admin or super_admin only. We don't expose the credentials
// themselves in the response — only their presence/absence and the
// LINE API's reply.

export async function POST() {
  const user = getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Resolve credentials the same way notifyToStaffGroup does so this
  // diagnostic exercises the exact path the auto-flow takes.
  const platform = getPlatformChannel();
  const sys = getSystemSettings();
  const token = platform?.channel_token ?? sys.global_line_channel_token ?? null;
  const groupId = sys.global_staff_group_id ?? null;

  const status = {
    has_platform_token: !!platform?.channel_token,
    has_legacy_token: !!sys.global_line_channel_token,
    has_group_id: !!groupId,
    group_id_preview: groupId ? `${groupId.slice(0, 5)}…${groupId.slice(-5)}` : null,
    group_id_looks_valid: !!(groupId && /^[CRU][0-9a-f]{32}$/i.test(groupId)),
    platform_label: platform?.label ?? null,
    platform_code: platform?.code ?? null
  };

  // Hard pre-flight checks. Return a structured diagnosis so the UI
  // can tell admin exactly what's missing without making them parse a
  // LINE API error.
  if (!token) {
    return NextResponse.json({
      ok: false,
      error: "no_token",
      message: "ยังไม่ได้ตั้ง Channel access token ของ IKIGAI OS — เพิ่มในช่อง Channel access token แล้วบันทึก",
      status
    }, { status: 400 });
  }
  if (!groupId) {
    return NextResponse.json({
      ok: false,
      error: "no_group_id",
      message: "ยังไม่ได้ตั้ง Staff Group ID — เพิ่มในช่อง Staff Group ID แล้วบันทึก",
      status
    }, { status: 400 });
  }
  if (!status.group_id_looks_valid) {
    return NextResponse.json({
      ok: false,
      error: "invalid_group_id_format",
      message: "Group ID ที่ตั้งไว้ไม่ตรงรูปแบบ LINE — ต้องขึ้นต้นด้วย C/R/U + ฮกซะเดซิมอล 32 ตัว",
      status
    }, { status: 400 });
  }

  // Build the test payload — a plain text message so we don't have to
  // worry about Flex schema issues during config debugging.
  const nowBkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const stamp = nowBkk.toISOString().slice(0, 16).replace("T", " ");
  const result = await sendLinePush(token, {
    to: groupId,
    messages: [{
      type: "text",
      text: `🧪 ทดสอบการส่งจาก IKIGAI OS PORTAL\nเวลา ${stamp} (UTC+7)\nผู้ทดสอบ: ${user.display_name}`
    }]
  });

  if (result.ok) {
    return NextResponse.json({ ok: true, status });
  }

  // LINE API rejected — return the raw error string so the UI can
  // show it. Common ones we'd surface:
  //   • 401  invalid_signature / Authorization header invalid → wrong token
  //   • 403  The user/group hasn't joined the channel → OA not in group
  //   • 400  Invalid push target → wrong group_id
  return NextResponse.json({
    ok: false,
    error: "line_api_error",
    line_status: result.status,
    line_body: result.error ?? null,
    message: explainLineError(result.status, result.error),
    status
  }, { status: 502 });
}

function explainLineError(httpStatus: number, body: string | undefined): string {
  const text = body ?? "";
  if (httpStatus === 401) {
    return "Channel access token ใช้งานไม่ได้ (401 Unauthorized) — ตรวจสอบว่าก็อปปี้ทั้งสตริงและไม่หมดอายุ";
  }
  if (httpStatus === 403) {
    return "OA ยังไม่ได้เข้ากลุ่ม หรือไม่มีสิทธิ์ส่งข้อความเข้ากลุ่มนี้ (403) — เชิญ IKIGAI OS PORTAL เข้ากลุ่ม แล้วเปิด 'Allow group chats' ใน LINE OA Manager";
  }
  if (httpStatus === 400) {
    if (text.toLowerCase().includes("invalid push target")) {
      return "Group ID ไม่ถูกต้อง (Invalid push target) — ตรวจสอบว่าคัดลอก Group ID มาตรงจากบอทที่โพสต์ในกลุ่ม";
    }
    return `LINE ปฏิเสธคำขอ (400): ${text}`;
  }
  if (httpStatus === 429) {
    return "เกินโควต้าการส่ง (429 Rate Limited) — ลองอีกครั้งภายหลัง";
  }
  return `LINE API คืน HTTP ${httpStatus}: ${text || "(no body)"}`;
}
