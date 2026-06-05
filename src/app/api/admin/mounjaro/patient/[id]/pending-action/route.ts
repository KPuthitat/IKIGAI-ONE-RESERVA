import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { decidePendingAction, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";
import { notifyEmployeeActionDecision } from "@/lib/mounjaro-notify";

// POST /api/admin/mounjaro/patient/[id]/pending-action
//   body { decision: 'approve' | 'reject' }
// The attending doctor approves/rejects the employee's withdraw/erase
// request (owner 2026-06-05). Approve runs the real withdraw/erase;
// reject clears the request. Doctor + unlock gated; gateway re-scopes
// to the attending doctor.

const Body = z.object({ decision: z.enum(["approve", "reject"]) });

function gate() {
  const user = getSessionUser();
  if (!user) return { error: "unauthenticated", status: 401 as const };
  if (user.clinical_role !== "doctor") return { error: "forbidden", status: 403 as const };
  if (!isClinicalUnlocked(user)) return { error: "locked", status: 403 as const };
  return { user };
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const g = gate();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const res = decidePendingAction(g.user as MjActor, id, parsed.data.decision);
    if (!res) return NextResponse.json({ error: "no_pending_action" }, { status: 404 });
    notifyEmployeeActionDecision(res.employeeId, res.action, parsed.data.decision).catch(() => {});
    return NextResponse.json({ ok: true, action: res.action });
  } catch (e) {
    if (isMounjaroForbidden(e)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
