import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { createBreakSkipRequest } from "@/lib/break-skip";

// POST /api/persona/break-skip-requests — a staffer asks to work through TODAY's
// break (owner 2026-09-13). Must be filed before the break starts; a supervisor
// approves (retroactive OK). One per (user, day); a pending/rejected day can be
// re-filed, an approved one is locked. Only for one's OWN record.

// Only `reason` is read from the client; the work date is always TODAY (BKK),
// derived server-side so a stale client clock near midnight can't misfile it.
const Body = z.object({
  reason: z.string().max(500).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }

  const todayBkk = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  const db = getDb();
  const res = createBreakSkipRequest(db, {
    userId: user.id,
    workDate: todayBkk,
    branchId: user.activeBranchId ?? null,
    reason: parsed.data.reason ?? null
  });
  if ("error" in res) return NextResponse.json({ error: res.error }, { status: 409 });
  logPersonaAction(user.id, "break_skip.submit", res.id);
  return NextResponse.json({ ok: true, id: res.id });
}
