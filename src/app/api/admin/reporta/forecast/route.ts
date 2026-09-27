import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { forecastForBranch } from "@/lib/forecast";

// ANALYTICA forward plan (owner 2026-09-27): the next 3–7 days' predicted sales +
// holidays + weather + a น้องฮูก suggestion per day, for the branch's team.

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_branch" }, { status: 403 });

  const days = Number(new URL(req.url).searchParams.get("days")) || 7;
  const fc = await forecastForBranch(branchId, days);
  return NextResponse.json({ ok: true, forecast: fc, weatherAvailable: fc.rows.some((r) => r.weather != null) });
}
