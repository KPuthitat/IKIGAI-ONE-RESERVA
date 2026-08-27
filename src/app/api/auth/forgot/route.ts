import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { createInvite, revokeOpenInvites, listInvitesForUser } from "@/lib/invites";
import { getPlatformChannel, isChannelReady } from "@/lib/messaging-channels";
import { sendLinePush } from "@/lib/line";

// Self-service password reset (owner 2026-07-02).
//
// Staff who forgot their username/password ask for a reset from the login
// page. We look them up by username OR 13-digit national ID, and — if the
// account has a bound LINE — push a one-time "set new credentials" link to
// that LINE (reusing the existing invite kind='reset' + /persona/invite
// redeem flow). Verification is possession of the linked LINE account, so
// no password/OTP is needed and non-technical staff recover in two taps.
//
// SECURITY: the response is ALWAYS {ok:true} regardless of whether the
// account exists / has LINE bound — no account-enumeration oracle. When
// LINE isn't bound the staff simply won't receive a link and must fall
// back to the admin (emergency credential), same as before.

export const dynamic = "force-dynamic";

const Body = z.object({ identifier: z.string().trim().min(1).max(120) });
const THROTTLE_MS = 3 * 60_000;

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: true });
  const id = parsed.data.identifier.trim();

  const user = getDb()
    .prepare(`
      SELECT id, line_user_id, status FROM users
      WHERE username = @id OR (national_id = @id AND length(@id) = 13)
      LIMIT 1
    `)
    .get({ id }) as { id: number; line_user_id: string | null; status: string } | undefined;

  // Only send when the account is recoverable this way: exists, has a
  // bound LINE, and isn't disabled. resigned/pending are also skipped
  // (they'd hit the account-state gate on login anyway).
  if (user && user.line_user_id && user.status !== "disabled") {
    // Throttle: if a fresh unused reset link already went out in the last
    // few minutes, don't mint/send another (avoids spamming the LINE and
    // invalidating a link the staff may be mid-way through using).
    const recent = listInvitesForUser(user.id).some(
      (inv) =>
        inv.kind === "reset" &&
        !inv.used_at &&
        Date.now() - new Date(inv.created_at).getTime() < THROTTLE_MS
    );
    if (!recent) {
      const platform = getPlatformChannel();
      if (isChannelReady(platform) && platform?.channel_token) {
        revokeOpenInvites(user.id); // kill older links — one live reset at a time
        const invite = createInvite({ userId: user.id, kind: "reset", createdBy: user.id });
        const base = (process.env.NEXT_PUBLIC_PUBLIC_BASE_URL || "").replace(/\/$/, "");
        const link = `${base}/persona/invite/${invite.token}`;
        await sendLinePush(platform.channel_token, {
          to: user.line_user_id,
          messages: [
            {
              type: "text",
              text:
                "คำขอตั้งรหัสผ่านใหม่ (IKIGAI OS)\n\n" +
                "กดลิงก์นี้เพื่อตั้ง username / รหัสผ่าน / PIN ใหม่:\n" +
                link +
                "\n\nลิงก์ใช้ได้ 7 วัน และใช้ได้ครั้งเดียว\n" +
                "หากคุณไม่ได้เป็นผู้ขอ ไม่ต้องกดลิงก์นี้ (บัญชียังปลอดภัย)"
            }
          ]
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
