import { NextResponse } from "next/server";
import { getSessionUser, userCanViewPayroll } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { recomputeLine } from "@/lib/payroll-compute";

// POST /api/admin/persona/payroll/periods/[id]/lines/[userId]/recompute
//
// Recompute one employee's line from the current sources (time_entries +
// per-day overrides + roster). No PIN: it only re-derives from inputs
// the admin already controls — it doesn't change any recorded time. Use
// after editing the roster / rate, or to refresh after a per-day edit.
// Draft period only.

export async function POST(
  _req: Request,
  { params }: { params: { id: string; userId: string } }
) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!userCanViewPayroll(user)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const periodId = Number(params.id);
  const userId = Number(params.userId);
  if (!Number.isInteger(periodId) || !Number.isInteger(userId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    recomputeLine(getDb(), periodId, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "recompute_failed";
    const code = msg === "period_not_draft" ? 400 : 400;
    return NextResponse.json({ error: msg }, { status: code });
  }

  return NextResponse.json({ ok: true });
}
