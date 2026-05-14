import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { logPersonaAction } from "@/lib/db";
import {
  endImpersonation,
  impersonatorLogId,
  currentImpersonationContext,
  IMPERSONATOR_COOKIE
} from "@/lib/impersonation";

// POST /api/admin/impersonate/end — close the active impersonation
// session. Restores the original impersonator's session, stamps
// ended_at on the log row, clears the marker cookie. Idempotent.

export async function POST() {
  const logId = impersonatorLogId();
  if (!logId) return NextResponse.json({ ok: true, already: true });
  const ctx = currentImpersonationContext();
  const sessionId = cookies().get("reserva_session")?.value;
  if (!sessionId) return NextResponse.json({ error: "no_session" }, { status: 401 });

  const ok = endImpersonation({ sessionId, logId });
  if (ok && ctx) {
    logPersonaAction(ctx.impersonatorId, "impersonation.end", logId);
  }
  cookies().set(IMPERSONATOR_COOKIE, "", { path: "/", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
