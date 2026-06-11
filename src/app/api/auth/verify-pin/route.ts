import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/auth/verify-pin  { pin }
//
// Verifies the caller's OWN 4-digit PIN (users.pin_hash — the same one the
// time-clock uses). General-purpose presence check for any logged-in user —
// used by the view-mode toggle to gate switching into the non-default mode
// (owner 2026-06-11). Not coupled to payroll like the persona verify-pin.
// View mode is cosmetic (actual pages stay role-gated by requireAdmin), so
// this is an intent/presence gate, not a security boundary.

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
