import { NextResponse } from "next/server";
import { z } from "zod";
import { createSession } from "@/lib/auth";
import { getDb, type UserRole } from "@/lib/db";

// POST /api/auth/line-login — one-tap login via LIFF for the staff rich
// menu. After a staff has redeemed their invite (which bound their LINE
// userId to their user row), they can tap the OA rich menu and land
// straight in /staff/persona without typing anything.
//
// Trust model:
//   The client sends us a LIFF accessToken (NOT a userId). We verify
//   that token by calling LINE Profile API as Bearer — LINE responds
//   with the verified userId. This proves the user actually controls
//   that LINE account at the time of the request; we never trust a
//   client-asserted userId.
//
// Then we look up `users.line_user_id` and, if found + status='active',
// create a session. On miss → 404 so the client can show "ติดต่อ
// หัวหน้างานเพื่อขอลิงก์เชิญ" and offer a manual-login fallback.

const Body = z.object({
  accessToken: z.string().min(20).max(2048)
});

type LineProfile = {
  userId: string;
  displayName?: string;
  pictureUrl?: string;
};

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const { accessToken } = parsed.data;

  // (1) Verify access token by calling LINE Profile API. We deliberately
  //     don't call /verify because /profile gives us the userId in the
  //     same round-trip — one less network hop, same security level
  //     (an invalid/expired token returns 401 here too).
  let profile: LineProfile;
  try {
    const r = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store"
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "invalid_line_token" },
        { status: 401 }
      );
    }
    profile = (await r.json()) as LineProfile;
    if (!profile.userId) {
      return NextResponse.json(
        { error: "invalid_line_token" },
        { status: 401 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "line_profile_fetch_failed" },
      { status: 502 }
    );
  }

  // (2) Look up our user. status='active' filter ensures pending_invite
  //     / disabled accounts can't slip in through this back door even
  //     if the line_user_id matches.
  const db = getDb();
  const user = db.prepare(`
    SELECT id, role, status, display_name FROM users
    WHERE line_user_id = ? AND status = 'active'
  `).get(profile.userId) as {
    id: number;
    role: UserRole;
    status: string;
    display_name: string;
  } | undefined;

  if (!user) {
    return NextResponse.json(
      {
        error: "line_not_registered",
        line_display_name: profile.displayName ?? null
      },
      { status: 404 }
    );
  }

  // (3) Stamp last_login_at — keeps the admin "inactive users" audit
  //     consistent with the regular username/password login path.
  db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(user.id);
  createSession(user.id, null);

  // super_admin counts as "admin" for routing purposes — no separate tab.
  const tabRole: "admin" | "staff" =
    user.role === "super_admin" || user.role === "admin" ? "admin" : "staff";

  return NextResponse.json({
    ok: true,
    role: tabRole,
    display_name: user.display_name
  });
}
