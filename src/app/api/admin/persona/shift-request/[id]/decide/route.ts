import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { decideShiftRequest } from "@/lib/shift-requests";

// POST /api/admin/persona/shift-request/[id]/decide — supervisor/admin
// approves or rejects a shift-change request. Approval only RECORDS the
// decision (+ notifies the staff); the admin updates the roster manually.
const Body = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(500).optional()
});

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = requireAdmin();
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const ok = decideShiftRequest(user.id, id, parsed.data.decision, parsed.data.note?.trim() || null);
  if (!ok) return NextResponse.json({ error: "not_pending" }, { status: 409 });
  logPersonaAction(user.id, `shift_request.${parsed.data.decision}`, id);
  return NextResponse.json({ ok: true });
}
