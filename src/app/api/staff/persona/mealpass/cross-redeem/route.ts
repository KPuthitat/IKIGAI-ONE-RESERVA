import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCan } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { partnerConfirmCrossCompanyOrder, MealpassError } from "@/lib/mealpass";

// POST /api/staff/persona/mealpass/cross-redeem
//
// The ศาลาชิลล์ (selling-company) partner account scans a staffer's SC-xxxx code
// to confirm a cross-company meal. Confirming posts the payroll_charge against
// the buyer's home company. Gated on partner.mealpass.confirm (strict — NOT the
// admin fallback) and scoped: the partner must belong to the selling company.
const Body = z.object({ code: z.string().min(3).max(32) });

function statusFor(code: string): number {
  if (code === "not_found") return 404;
  if (code === "already_confirmed" || code === "not_pending" || code === "cap_exceeded" || code === "weekly_cap_exceeded") return 409;
  if (code === "wrong_partner") return 403;
  return 400;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCan(user, "partner.mealpass.confirm")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  try {
    const r = partnerConfirmCrossCompanyOrder({
      code: parsed.data.code.trim().toUpperCase(),
      confirmerUserId: user.id,
      confirmerBranchIds: user.branches.map((b) => b.id),
    });
    logPersonaAction(user.id, "mealpass.crosscompany.confirm");
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof MealpassError) return NextResponse.json({ error: e.code }, { status: statusFor(e.code) });
    throw e;
  }
}
