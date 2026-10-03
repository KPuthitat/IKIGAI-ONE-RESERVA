import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, getLineGroupId, setLineGroupId, getMonthlyTarget, setMonthlyTarget, listMonthlyTargets, setMonthlyTargetFor, getMerchantName, setMerchantName, getCardColor, setCardColor, branchOpensOn, setBranchOpensOn, getBranchHours, branchWeekHours } from "@/lib/salesa-db";

// REPORTA settings — the HOD LINE group id the daily/weekly cards are pushed to
// (per branch), the sales targets (default + per-month overrides), merchant
// name, card colour, opening date. Operating hours are RESERVA's (read-only
// here). Owner 2026-09-16 → 2026-10-02.

export const dynamic = "force-dynamic";

function ctx() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isSalesaBranch(branchId) };
}

function snapshot(branchId: number) {
  return {
    ok: true, lineGroupId: getLineGroupId(branchId), monthlyTarget: getMonthlyTarget(branchId),
    monthTargets: listMonthlyTargets(branchId), merchantName: getMerchantName(branchId), cardColor: getCardColor(branchId),
    opensOn: branchOpensOn(branchId), hours: getBranchHours(branchId), weekHours: branchWeekHours(branchId)
  };
}

export function GET() {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json(snapshot(branchId!));
}

const Body = z.object({
  lineGroupId: z.string().max(200).nullable().optional(),
  monthlyTarget: z.number().min(0).max(1_000_000_000).nullable().optional(),
  // Per-month overrides (owner 2026-10-02): { "2026-11": 650000, "2026-12": null }.
  monthTargets: z.record(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), z.number().min(0).max(1_000_000_000).nullable()).optional(),
  merchantName: z.string().max(200).nullable().optional(),
  // The RD branch code for the tax-invoice guard is branches.tax_branch_code,
  // set once in บริษัท/สาขา (owner 2026-10-03) — nothing to set here.
  cardColor: z.string().max(9).nullable().optional(),
  opensOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
  // Hours (open/close, lunch break, closed days) are read from RESERVA — nothing to set here.
});

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (parsed.data.lineGroupId !== undefined) setLineGroupId(branchId!, parsed.data.lineGroupId);
  if (parsed.data.monthlyTarget !== undefined) setMonthlyTarget(branchId!, parsed.data.monthlyTarget);
  if (parsed.data.monthTargets !== undefined) {
    for (const [ym, t] of Object.entries(parsed.data.monthTargets)) setMonthlyTargetFor(branchId!, ym, t);
  }
  if (parsed.data.merchantName !== undefined) setMerchantName(branchId!, parsed.data.merchantName);
  if (parsed.data.cardColor !== undefined) setCardColor(branchId!, parsed.data.cardColor);
  if (parsed.data.opensOn !== undefined) setBranchOpensOn(branchId!, parsed.data.opensOn);
  return NextResponse.json(snapshot(branchId!));
}
