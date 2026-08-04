import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { verifyAdminPin } from "@/lib/admin-pin";

// PATCH /api/admin/persona/ot-requests/[id]
// Supervisor/admin approves or rejects an OT request. A day's row carries two
// independent segments (owner 2026-08-04): the late-end (requested_until,
// gated by `status`) and the early-start (requested_from, gated by
// `early_status`). `segment` picks which one this decision touches — defaulting
// to 'late' for backward compatibility. Deciding one segment never disturbs the
// other. Editing that segment's time changes a pay-affecting value, so it
// requires the admin's PIN (owner 2026-06-03); approve/reject alone does not.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Body = z.object({
  action: z.enum(["approve", "reject"]),
  segment: z.enum(["late", "early"]).default("late"),
  requested_until: z.string().regex(HHMM).optional(),
  requested_from: z.string().regex(HHMM).optional(),
  pin: z.string().optional()
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  const db = getDb();
  const row = db.prepare(
    "SELECT id, requested_until, requested_from FROM ot_requests WHERE id = ?"
  ).get(id) as { id: number; requested_until: string; requested_from: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const newStatus = d.action === "approve" ? "approved" : "rejected";
  const nowIso = new Date().toISOString();

  if (d.segment === "early") {
    // Early-start segment (requested_from → early_status). Editing the time is
    // a pay change → PIN. Never touch `status`/requested_until (the late seg).
    if (d.requested_from && d.requested_from !== row.requested_from) {
      if (!d.pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
      const pin = verifyAdminPin(user.id, d.pin);
      if (!pin.ok) {
        return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });
      }
      db.prepare("UPDATE ot_requests SET requested_from = ? WHERE id = ?").run(d.requested_from, id);
    }
    db.prepare(
      "UPDATE ot_requests SET early_status = ?, decided_by = ?, decided_at = ? WHERE id = ?"
    ).run(newStatus, user.id, nowIso, id);
    logPersonaAction(user.id, `ot.early_${d.action}`, id);
    return NextResponse.json({ ok: true });
  }

  // Late-end segment (requested_until → status). Editing the time is a pay
  // change → PIN. Never touch early_status/requested_from.
  if (d.requested_until && d.requested_until !== row.requested_until) {
    if (!d.pin) return NextResponse.json({ error: "pin_required" }, { status: 400 });
    const pin = verifyAdminPin(user.id, d.pin);
    if (!pin.ok) {
      return NextResponse.json({ error: pin.reason }, { status: pin.reason === "no_pin" ? 400 : 403 });
    }
    db.prepare("UPDATE ot_requests SET requested_until = ? WHERE id = ?")
      .run(d.requested_until, id);
  }

  db.prepare(`
    UPDATE ot_requests
    SET status = ?, decided_by = ?, decided_at = ?
    WHERE id = ?
  `).run(newStatus, user.id, nowIso, id);

  logPersonaAction(user.id, `ot.${d.action}`, id);

  return NextResponse.json({ ok: true });
}
