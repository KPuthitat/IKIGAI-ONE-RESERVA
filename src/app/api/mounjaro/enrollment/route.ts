import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { hasAdminPin, verifyAdminPin } from "@/lib/admin-pin";
import { enrollSelf, withdrawSelf, eraseMyData, getMyEnrollment, type MjActor } from "@/lib/mounjaro-db";

// POST /api/mounjaro/enrollment — employee self-service enrollment lifecycle.
//   action 'enroll'   → express interest (creates / reopens a pending enrollment)
//   action 'withdraw' → leave the program (keeps the record, status=withdrawn)
//   action 'erase'    → PDPA erasure (hide from portal; medical record retained)
// All scoped to the acting employee by the gateway — no id is accepted.
//
// Anti-accident gate (owner 2026-06-05): the two IRREVERSIBLE-feeling
// actions (withdraw, erase) require the employee's own 4-digit PIN —
// the same one set at onboarding. (The client also makes them type a
// confirmation phrase.) Accounts without a PIN fall through to the
// client's typed-phrase confirmation alone. 'enroll' needs no PIN
// (opt-in, and now reversible).

const Body = z.object({
  action: z.enum(["enroll", "withdraw", "erase"]),
  reason: z.string().max(500).optional(),
  pin: z.string().max(12).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const actor = user as MjActor;

  // PIN gate for the consequential actions: erasing data, or leaving the
  // program while ACTIVE (real participation). Cancelling a not-yet-
  // screened 'pending' request is harmless and skips the PIN so it's not
  // annoying. Only enforced when the user actually has a PIN set (every
  // onboarded employee does).
  const currentStatus = getMyEnrollment(actor)?.status ?? "none";
  const needsPin =
    parsed.data.action === "erase" ||
    (parsed.data.action === "withdraw" && currentStatus === "active");
  if (needsPin && hasAdminPin(user.id)) {
    const v = verifyAdminPin(user.id, parsed.data.pin ?? "");
    if (!v.ok) {
      return NextResponse.json(
        { error: "bad_pin", reason: v.ok ? null : v.reason },
        { status: 403 }
      );
    }
  }
  try {
    if (parsed.data.action === "enroll") {
      const enr = enrollSelf(actor);
      return NextResponse.json({ ok: true, status: enr.status });
    }
    if (parsed.data.action === "withdraw") {
      withdrawSelf(actor, parsed.data.reason ?? null);
      return NextResponse.json({ ok: true });
    }
    eraseMyData(actor);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
