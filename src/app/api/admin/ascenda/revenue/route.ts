import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { upsertBranchDailyRevenue } from "@/lib/ascenda";
import { syncShiftCloseTotalIfNoChannels } from "@/lib/accounta-db";
import { logPersonaAction } from "@/lib/db";

// PUT /api/admin/ascenda/revenue — admin upserts one day's revenue.
//
// Branch guard: admin can only edit revenue for branches they have
// access to (userHasBranch). The lib helper handles insert-vs-update.

const Body = z.object({
  branch_id: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  revenue: z.number().min(0).max(10_000_000)
});

export async function PUT(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { branch_id, date, revenue } = parsed.data;

  if (!userHasBranch(user, branch_id)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  // Light sanity check: refuse future dates (can't have revenue for
  // tomorrow yet) — typo-protection more than security.
  const todayBkk = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (date > todayBkk) {
    return NextResponse.json(
      { error: "future_date", message: "ใส่วันที่ในอนาคตไม่ได้" },
      { status: 400 }
    );
  }

  const r = upsertBranchDailyRevenue({
    branchId: branch_id,
    date,
    revenue,
    userId: user.id,
    source: "admin_edit"
  });

  // Mirror the corrected total into the รายรับ ledger — but only when that
  // day has no per-channel breakdown (so a manual total fix never wipes the
  // channel split a shift-close submit produced).
  try {
    syncShiftCloseTotalIfNoChannels(branch_id, date, revenue, user.id);
  } catch (e) {
    console.error("รายรับ ledger total sync from admin edit failed", e);
  }

  logPersonaAction(
    user.id,
    r.created ? "ascenda.revenue.create" : "ascenda.revenue.update",
    r.id
  );

  return NextResponse.json({ ok: true, id: r.id, created: r.created });
}
