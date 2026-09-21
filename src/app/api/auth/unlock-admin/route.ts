import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { getSessionUser, setAdminUnlocked } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/auth/unlock-admin  { pin }
//
// The single PIN gate for ENTERING admin mode (owner 2026-09-21). Verifies the
// caller's 4-digit PIN, then sets the httpOnly os_admin_unlock cookie the admin
// layout enforces plus the os_view=admin chrome preference. Used by the mode
// toggle and the login-time /admin/unlock page. Kept separate from the generic
// /api/auth/verify-pin (which has no side effects) so presence checks elsewhere
// never widen the admin window.

const Body = z.object({ pin: z.string() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Brute-force guard (owner 2026-09-21): this PIN gate stands between a
  // walk-up session and the admin console, so cap tries per account. 8 per 5 min.
  const rl = rateLimit(`unlock-admin:${user.id}`, 8, 5 * 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่" },
      { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
    );
  }

  const status = verifyAdminPin(user.id, parsed.data.pin);
  if (!status.ok) {
    const code = status.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: status.reason }, { status: code });
  }
  setAdminUnlocked(user.id);
  cookies().set("os_view", "admin", {
    httpOnly: false, sameSite: "lax",
    secure: process.env.NODE_ENV === "production", path: "/", maxAge: 31_536_000
  });
  return NextResponse.json({ ok: true });
}
