import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanAdminBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { decideBreakSkip } from "@/lib/break-skip";

// PATCH /api/admin/persona/break-skip-requests/[id] — a supervisor/admin approves
// or rejects a "work through the break" request (owner 2026-09-13). super_admin
// anyone; a branch admin only for their branch (or a NULL-branch record). May be
// done retroactively. Approving makes payroll skip that day's break so the freed
// over-8h pays as OT.

const Body = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(500).optional()
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

  const db = getDb();
  const row = db.prepare("SELECT id, branch_id, status FROM break_skip_requests WHERE id = ?")
    .get(id) as { id: number; branch_id: number | null; status: string } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (row.branch_id != null && !userCanAdminBranch(user, row.branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  if (row.status !== "pending") {
    return NextResponse.json({ error: "already_decided" }, { status: 409 });
  }

  const ok = decideBreakSkip(db, id, user.id, parsed.data.action === "approve", parsed.data.note ?? null);
  if (!ok) return NextResponse.json({ error: "not_pending" }, { status: 409 });
  logPersonaAction(user.id, parsed.data.action === "approve" ? "break_skip.approve" : "break_skip.reject", id);
  return NextResponse.json({ ok: true });
}
