import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userCanViewPayroll, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";
import { isManualSvcMonth, saveManualAllocations } from "@/lib/service-charge";

// PATCH /api/admin/persona/service-charge/manual
//
// Hand-enter the per-staff GROSS SVC for a PRE-SYSTEM month (owner 2026-07-21).
// Months before the system went live (< SVC_SYSTEM_START_MONTH) have no clock /
// roster data to distribute a pool over, so the owner types each person's amount
// instead. The typed amount is the gross (before WHT); the monthly summary still
// withholds 3% for 'wht' staff and posts to ACCOUNTA like a normal month.
//
// Guards (payroll-grade, since this drives a payout):
//   • userCanViewPayroll — same permission as the payout / posting flow
//   • branch = caller's active branch, never trusted from the client
//   • manual months only — a live month must not be overwritten by hand
//   • draft only — once the batch is finalized/paid/posted the amounts are locked

const Body = z.object({
  yearMonth: z.string().regex(/^\d{4}-\d{2}$/, "invalid_month"),
  // Cap each person at 999,999 baht/month — far above any realistic SVC share,
  // but blocks a fat-finger typo before it pollutes a posted month.
  allocations: z.array(z.object({
    userId: z.number().int().positive(),
    gross: z.number().min(0).max(999_999)
  })).max(200)
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const branchId = user.activeBranchId;
  if (!branchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!userHasBranch(user, branchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  }
  const { yearMonth, allocations } = parsed.data;

  if (!isManualSvcMonth(yearMonth)) {
    return NextResponse.json(
      { error: "not_manual_month", message: "เดือนนี้ระบบคำนวณอัตโนมัติ กรอกเองไม่ได้" },
      { status: 400 }
    );
  }

  // Locked once the month is finalized/paid/posted — mirror the payout flow.
  const batch = getDb().prepare(
    "SELECT status FROM svc_payout_batches WHERE branch_id = ? AND year_month = ?"
  ).get(branchId, yearMonth) as { status: string } | undefined;
  if (batch && batch.status !== "draft") {
    return NextResponse.json(
      { error: "locked", message: "ปิดยอดแล้ว แก้ไขไม่ได้ — ยกเลิกปิดยอดก่อน" },
      { status: 400 }
    );
  }

  const n = saveManualAllocations({ branchId, yearMonth, allocations, userId: user.id });
  logPersonaAction(user.id, "svc.manual.save", branchId);
  return NextResponse.json({ ok: true, saved: n });
}
