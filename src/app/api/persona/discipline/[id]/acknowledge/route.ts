import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { acknowledgeWarning, getWarning } from "@/lib/discipline";

// POST /api/persona/discipline/[id]/acknowledge
// Body: { method: "pin_explicit", pin: "1234" }
//   OR  { method: "auto_on_leave", reason?: string }
//
// pin_explicit  — staff entered correct 4-digit PIN. Server verifies
//                 against users.pin_hash before flipping acknowledged_at.
// auto_on_leave — fired by the client beforeunload handler when the
//                 staff opened the page (we already wrote a view row)
//                 but tried to leave without clicking the explicit
//                 acknowledge button. We log it as "system
//                 acknowledged on their behalf" so the audit trail
//                 distinguishes the two paths.
//
// Only the recipient can acknowledge their own warning; admins
// reading another staff's warning don't trip the ack.

const Body = z.object({
  method: z.enum(["pin_explicit", "auto_on_leave"]),
  pin: z.string().regex(/^\d{4}$/).optional(),
  reason: z.string().max(500).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const w = getWarning(id);
  if (!w) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (w.user_id !== user.id) {
    return NextResponse.json({ error: "not_recipient" }, { status: 403 });
  }
  if (w.acknowledged_at) {
    return NextResponse.json({ ok: true, already: true });
  }

  if (d.method === "pin_explicit") {
    if (!d.pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
    const db = getDb();
    const row = db.prepare("SELECT pin_hash FROM users WHERE id = ?")
      .get(user.id) as { pin_hash: string | null } | undefined;
    if (!row?.pin_hash) {
      return NextResponse.json({ error: "no_pin_set" }, { status: 400 });
    }
    if (!bcrypt.compareSync(d.pin, row.pin_hash)) {
      return NextResponse.json({ error: "wrong_pin" }, { status: 400 });
    }
    const flipped = acknowledgeWarning(id, "pin_explicit");
    if (flipped) logPersonaAction(user.id, "discipline.ack_pin", id);
    return NextResponse.json({ ok: true, flipped });
  } else {
    // auto_on_leave — no PIN required; client fires this when the
    // staff is leaving the warning page without explicit ack.
    const flipped = acknowledgeWarning(id, "auto_on_leave", d.reason ?? "page_leave");
    if (flipped) logPersonaAction(user.id, "discipline.ack_auto", id);
    return NextResponse.json({ ok: true, flipped });
  }
}
