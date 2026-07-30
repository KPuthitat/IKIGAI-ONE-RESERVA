import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { requestEarlyLeave } from "@/lib/early-leave";

// POST /api/persona/early-leave-requests — a staff member asks permission to
// leave a shift early (owner 2026-07-30). Creates a PENDING request; a
// supervisor/admin must approve for it to exempt the day's food-credit SVC
// clawback. One request per (user, day) — re-submitting resets to pending.
//
// No pay-engine effect and no per-request LINE push — pending early-leave
// surfaces in the admin PERSONA list (mirrors ot_requests).

const Body = z.object({
  work_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { work_date, reason } = parsed.data;
  requestEarlyLeave(user.id, user.activeBranchId ?? null, work_date, reason?.trim() || null);
  return NextResponse.json({ ok: true });
}
