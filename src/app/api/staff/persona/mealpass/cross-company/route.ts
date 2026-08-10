import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import {
  createCrossCompanyOrder, hasMealpassConsent, recordMealpassConsent, MealpassError,
} from "@/lib/mealpass";
import { todayBkk } from "@/lib/time";

// POST /api/staff/persona/mealpass/cross-company — a staffer buys a meal at a
// DIFFERENT company's branch (ศาลาชิลล์). No credits/cash: the employee price is
// charged to their payroll on partner confirm, and the company settles with the
// selling company weekly. Written consent is required first (labour law) — the
// client sends { consent: true } to sign it, then the order is created.
//   body: { sellingBranchId, menuItemId, consent? }
const Body = z.object({
  sellingBranchId: z.number().int().positive(),
  menuItemId: z.number().int().positive(),
  consent: z.boolean().optional(),
});

function statusFor(code: string): number {
  if (code === "consent_required") return 403;
  if (code === "cap_exceeded") return 409;
  if (code === "not_cross_company" || code === "menu_invalid" || code === "menu_unavailable"
    || code === "company_unknown") return 400;
  return 400;
}

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Capture written consent before the first cross-company charge (idempotent).
  if (parsed.data.consent && !hasMealpassConsent(user.id)) {
    recordMealpassConsent(user.id);
    logPersonaAction(user.id, "mealpass.crosscompany.consent");
  }

  try {
    const result = createCrossCompanyOrder({
      buyerUserId: user.id,
      sellingBranchId: parsed.data.sellingBranchId,
      menuItemId: parsed.data.menuItemId,
      dateBkk: todayBkk(),
    });
    logPersonaAction(user.id, "mealpass.crosscompany.create", result.id);
    return NextResponse.json({ ok: true, order: result });
  } catch (e) {
    if (e instanceof MealpassError) return NextResponse.json({ error: e.code }, { status: statusFor(e.code) });
    throw e;
  }
}
