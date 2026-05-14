import { NextResponse } from "next/server";
import { z } from "zod";
import { lookupValidInvite, redeemInvite } from "@/lib/invites";
import { createSession } from "@/lib/auth";

// GET  /api/persona/invite/[token] — peek at the invite. Public
//   (the link itself is the secret). Returns display_name + kind
//   so the redemption page can show "Welcome, ฐิติรัตน์".
//
// POST /api/persona/invite/[token] — redeem. Body: username +
//   password + pin + optional line_user_id. On success returns ok
//   + auto-creates a session cookie so the staff is logged in
//   immediately.

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const invite = lookupValidInvite(params.token);
  if (!invite) {
    return NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    kind: invite.kind,
    user_display_name: invite.user_display_name,
    expires_at: invite.expires_at
  });
}

const RedeemBody = z.object({
  username: z.string().trim().min(3).max(40)
    .regex(/^[a-zA-Z0-9._-]+$/, "username_format"),
  password: z.string().min(6).max(128),
  pin: z.string().regex(/^\d{4}$/),
  line_user_id: z.string().max(64).optional()
});

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const parsed = RedeemBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const d = parsed.data;

  // Quick collision check before we attempt the redeem transaction,
  // so we can return a specific error instead of bouncing inside
  // the redeem on a generic UNIQUE violation.
  // (The redeem itself ALSO catches it — this is just for nicer UX.)
  try {
    const result = redeemInvite({
      token: params.token,
      username: d.username,
      password: d.password,
      pin: d.pin,
      lineUserId: d.line_user_id ?? null
    });
    if (!result) {
      return NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
    }
    // Auto-login: create a session pointing at the new user.
    createSession(result.userId, null);
    return NextResponse.json({ ok: true, user_id: result.userId, kind: result.kind });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return NextResponse.json({ error: "username_taken" }, { status: 409 });
    }
    throw e;
  }
}
