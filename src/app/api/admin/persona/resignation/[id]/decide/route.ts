import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

const Body = z.object({
  decision: z.enum(["approved", "rejected", "revision_requested"]),
  note: z.string().max(500).optional(),
  // forfeit_svc — when admin approves a resignation that breaks
  // company policy ("ลาออกผิดกติกา"), tick this to forfeit the
  // resigning staff's whole-month SVC accrual to the company.
  // Default false (staff keeps their SVC). Only honoured when
  // decision === "approved" — set it on a reject and we ignore.
  forfeit_svc: z.boolean().optional()
});

// POST /api/admin/persona/resignation/[id]/decide
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const db = getDb();
  const row = db.prepare("SELECT status FROM resignation_requests WHERE id = ?")
    .get(id) as { status: string } | undefined;

  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.status !== "pending") {
    return NextResponse.json({ error: "already_decided", currentStatus: row.status }, { status: 409 });
  }

  const nowIso = new Date().toISOString();
  // Only persist forfeit_svc on approvals — irrelevant + misleading
  // for a reject or revision-request decision.
  const forfeit = parsed.data.decision === "approved" && parsed.data.forfeit_svc === true ? 1 : 0;
  db.prepare(`
    UPDATE resignation_requests
    SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, forfeit_svc = ?
    WHERE id = ?
  `).run(parsed.data.decision, user.id, nowIso, parsed.data.note ?? null, forfeit, id);

  return NextResponse.json({ ok: true, status: parsed.data.decision, forfeit_svc: !!forfeit });
}
