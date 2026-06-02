import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";

// POST /api/inventa/counts/[id]/reopen — reopen a SUBMITTED count round
// for correction (owner 2026-06-03). Flips status submitted→open so the
// staff can keep counting / fix numbers instead of starting a new round.
// PIN-gated (the staff's own 4-digit PIN) + logged for the audit trail.
//
// Guard: only one open round per branch at a time. If another round is
// already open for the branch we refuse, so the two don't fork.

const Body = z.object({ pin: z.string().optional() });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const pin = parsed.success ? parsed.data.pin : undefined;
  if (!pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
  const pinStatus = verifyAdminPin(user.id, pin);
  if (!pinStatus.ok) {
    const code = pinStatus.reason === "no_pin" ? 400 : 403;
    return NextResponse.json({ error: pinStatus.reason }, { status: code });
  }

  const db = getDb();
  const count = db.prepare(
    "SELECT id, branch_id, status FROM inventa_counts WHERE id = ?"
  ).get(id) as { id: number; branch_id: number | null; status: string } | undefined;
  if (!count) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (count.status !== "submitted") {
    return NextResponse.json({ error: "not_submitted" }, { status: 409 });
  }

  // Refuse if the branch already has an open round (avoid forking).
  const open = db.prepare(`
    SELECT id FROM inventa_counts
    WHERE status = 'open' AND (branch_id IS ? OR branch_id = ?)
    LIMIT 1
  `).get(count.branch_id, count.branch_id) as { id: number } | undefined;
  if (open) {
    return NextResponse.json({ error: "another_open" }, { status: 409 });
  }

  db.prepare(`
    UPDATE inventa_counts
    SET status = 'open', submitted_at = NULL,
        reopened_at = ?, reopened_by = ?
    WHERE id = ? AND status = 'submitted'
  `).run(new Date().toISOString(), user.id, id);

  logPersonaAction(user.id, "inventa.count.reopen", id);

  return NextResponse.json({ ok: true });
}
