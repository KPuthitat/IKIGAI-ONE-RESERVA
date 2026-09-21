import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/auth/verify-pin  { pin }
//
// Verifies the caller's OWN 4-digit PIN (users.pin_hash — the same one the
// time-clock uses). A generic presence check with NO side effects, used by
// field-unlock flows (revshare rounds, recruita) that just need "prove it's
// you". Entering admin mode goes through /api/auth/unlock-admin instead, so
// this route never touches the admin-unlock cookie.

const Body = z.object({ pin: z.string() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const status = verifyAdminPin(user.id, parsed.data.pin);
  if (!status.ok) {
    const code = status.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: status.reason }, { status: code });
  }
  return NextResponse.json({ ok: true });
}
