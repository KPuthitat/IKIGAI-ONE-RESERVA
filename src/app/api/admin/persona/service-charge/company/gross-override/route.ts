import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { setSvcGrossOverride, clearSvcGrossOverride, companySvcPayoutState } from "@/lib/service-charge";

// PATCH /api/admin/persona/service-charge/company/gross-override — set or clear a
// hand-entered GROSS ("ยอดก่อนโอน") for one person in a company-wide month (owner
// 2026-09-03). gross=null clears it. Only while the month is still draft. The
// company is the caller's active-branch company — never trusted from the client.

const Body = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/),
  userId: z.number().int().positive(),
  gross: z.number().min(0).max(10_000_000).nullable(),
  note: z.string().max(500).optional()
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const companyId = (getDb().prepare("SELECT company_id FROM branches WHERE id = ?")
    .get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (!companyId) return NextResponse.json({ error: "no_company" }, { status: 400 });

  // Only editable while the month hasn't been closed — changing the gross after
  // finalize would desync the posted ACCOUNTA figures (owner 2026-09-03).
  if (companySvcPayoutState(companyId, d.yearMonth).status !== "draft") {
    return NextResponse.json({ error: "not_draft", message: "เดือนนี้ปิดยอดแล้ว — ยกเลิกปิดยอดก่อนจึงจะแก้ยอดได้" }, { status: 400 });
  }

  if (d.gross == null) {
    clearSvcGrossOverride(companyId, d.yearMonth, d.userId);
    return NextResponse.json({ ok: true, cleared: true });
  }
  setSvcGrossOverride({ companyId, yearMonth: d.yearMonth, userId: d.userId, gross: d.gross, note: d.note ?? null, setBy: user.id });
  return NextResponse.json({ ok: true });
}
