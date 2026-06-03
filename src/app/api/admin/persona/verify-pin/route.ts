import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/admin/persona/verify-pin
//
// Lightweight PIN check for "enter PIN before editing" gates — proves
// the admin's PIN before the payroll per-day editor unlocks its fields
// (owner 2026-06-03). No side effects, no audit: the actual write
// (e.g. /day) re-verifies the PIN and records the audit row, so this is
// purely a UX pre-check so a wrong PIN is caught up front instead of
// after the admin has typed their corrections.

const Body = z.object({ pin: z.string() });

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

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
