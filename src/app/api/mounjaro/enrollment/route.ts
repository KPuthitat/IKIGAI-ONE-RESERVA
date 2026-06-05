import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { hasAdminPin, verifyAdminPin } from "@/lib/admin-pin";
import {
  confirmMyInvitation, withdrawSelf, eraseMyData, getMyEnrollment,
  requestPendingAction, type MjActor
} from "@/lib/mounjaro-db";
import { notifyDoctorPendingAction, notifyDoctorEmployeeConfirmed } from "@/lib/mounjaro-notify";

// POST /api/mounjaro/enrollment — employee self-service enrollment lifecycle.
//   action 'enroll'   → express interest (creates / reopens a pending enrollment)
//   action 'withdraw' → leave the program
//   action 'erase'    → PDPA erasure (hide from portal; medical record retained)
// All scoped to the acting employee by the gateway — no id is accepted.
//
// Anti-accident gate (owner 2026-06-05): the two IRREVERSIBLE-feeling
// actions (withdraw, erase) require the employee's own 4-digit PIN —
// the same one set at onboarding. (The client also makes them type a
// confirmation phrase.) Accounts without a PIN fall through to the
// client's typed-phrase confirmation alone. 'enroll' needs no PIN.
//
// Doctor-approval gate (owner 2026-06-05): for an ACTIVE participant,
// withdraw/erase don't execute immediately — they file a request that
// the attending doctor must approve. Cancelling a not-yet-screened
// 'pending' interest stays self-serve (no doctor, harmless).

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
      // Confirm the doctor's invitation — self-enrollment is no longer
      // allowed; an invitation from an attending doctor is required.
      const confirmed = confirmMyInvitation(actor);
      if (!confirmed) {
        return NextResponse.json({ error: "no_invitation" }, { status: 400 });
      }
      notifyDoctorEmployeeConfirmed(user.id).catch(() => {});
      return NextResponse.json({ ok: true, status: "pending" });
    }
    if (parsed.data.action === "withdraw") {
      // Active participant → file a doctor-approval request. Pending
      // interest (not yet screened) → cancel immediately, no doctor.
      if (currentStatus === "active") {
        requestPendingAction(actor, "withdraw", parsed.data.reason ?? null);
        notifyDoctorPendingAction(user.id, "withdraw").catch(() => {});
        return NextResponse.json({ ok: true, pending: true });
      }
      withdrawSelf(actor, parsed.data.reason ?? null);
      return NextResponse.json({ ok: true });
    }
    // erase — active participant routes through doctor approval; otherwise
    // (no active treatment to protect) erase the portal data immediately.
    if (currentStatus === "active") {
      requestPendingAction(actor, "erase", parsed.data.reason ?? null);
      notifyDoctorPendingAction(user.id, "erase").catch(() => {});
      return NextResponse.json({ ok: true, pending: true });
    }
    eraseMyData(actor);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
