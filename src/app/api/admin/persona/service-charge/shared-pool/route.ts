import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { setSharedSvcMonth, isManualSvcMonth } from "@/lib/service-charge";

// POST /api/admin/persona/service-charge/shared-pool
//
// Toggle the company-wide "รวมกอง SVC ทั้งบริษัท" shared-pool mode for one month
// (owner 2026-08-18). When ON, every branch's daily SVC for that month is pooled
// and split across everyone who worked at ANY branch, weighted by hours — so a
// worker at a branch that entered no SVC (a new HYPO) still gets a share.
//
// Any admin who can view payroll may flip it (owner: "แอดมินที่ดู payroll ได้ ก็
// เปิดได้"). The company is derived from the admin's active branch — no company_id
// in the body, so cross-company tampering is impossible by construction.

const Body = z.object({
  year_month: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  shared: z.boolean()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }
    );
  }
  // Shared pool needs live clock/roster data to split by hours — pre-system
  // (hand-entered) months have none, so the toggle doesn't apply there.
  if (isManualSvcMonth(parsed.data.year_month)) {
    return NextResponse.json({ error: "manual_month_not_supported" }, { status: 400 });
  }

  const companyId = (getDb().prepare(
    "SELECT company_id FROM branches WHERE id = ?"
  ).get(user.activeBranchId) as { company_id: number | null } | undefined)?.company_id ?? null;
  if (!companyId) {
    return NextResponse.json({ error: "no_company" }, { status: 400 });
  }

  setSharedSvcMonth({
    companyId,
    yearMonth: parsed.data.year_month,
    shared: parsed.data.shared,
    userId: user.id
  });
  logPersonaAction(
    user.id,
    parsed.data.shared ? "svc.sharedPool.enable" : "svc.sharedPool.disable",
    companyId
  );
  return NextResponse.json({ ok: true, shared: parsed.data.shared });
}
