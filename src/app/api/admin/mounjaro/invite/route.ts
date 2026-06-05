import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { inviteEmployee, isMounjaroForbidden, type MjActor } from "@/lib/mounjaro-db";
import { notifyEmployeeInvited } from "@/lib/mounjaro-notify";

// POST /api/admin/mounjaro/invite — doctor sends an invitation to an
// employee to join the weight-control program. Doctor + unlock gated.
// The employee confirms on the staff portal; only then does the doctor's
// intake list show them.

const Body = z.object({ employee_id: z.number().int().positive() });

function gate() {
  const user = getSessionUser();
  if (!user) return { error: "unauthenticated", status: 401 as const };
  if (user.clinical_role !== "doctor") return { error: "forbidden", status: 403 as const };
  if (!isClinicalUnlocked(user)) return { error: "locked", status: 403 as const };
  return { user };
}

export async function POST(req: Request) {
  const g = gate();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const result = inviteEmployee(g.user as MjActor, parsed.data.employee_id);
    notifyEmployeeInvited(parsed.data.employee_id).catch(() => {});
    return NextResponse.json({ ok: true, enrollment_id: result.enrollment_id });
  } catch (e) {
    if (isMounjaroForbidden(e)) {
      const err = (e as Error).message;
      return NextResponse.json({
        error: err === "already_active" ? "already_active"
          : err === "already_confirmed" ? "already_confirmed"
          : "forbidden"
      }, { status: 400 });
    }
    return NextResponse.json({ error: "failed" }, { status: 400 });
  }
}
