import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getActiveConsent, recordConsent, type MjActor } from "@/lib/mounjaro-db";

// POST /api/mounjaro/consent — the employee accepts the current active
// consent version. Stamps consent_version + signed_at on their enrollment.

export async function POST() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const active = getActiveConsent();
  if (!active) return NextResponse.json({ error: "no_consent_version" }, { status: 400 });
  recordConsent(user as MjActor, active.version);
  return NextResponse.json({ ok: true });
}
