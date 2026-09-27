import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, getLineGroupId, setLineGroupId, getMonthlyTarget, setMonthlyTarget, getMerchantName, setMerchantName, getCardColor, setCardColor, branchOpensOn, setBranchOpensOn, getBranchHours, setBranchBreak } from "@/lib/salesa-db";

// REPORTA settings — the HOD LINE group id the daily/weekly cards are pushed to
// (per branch). The IKIGAI OS platform OA must be a member of that group.
// Owner 2026-09-16.

export const dynamic = "force-dynamic";

function ctx() {
  const user = requirePermission("reporta.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isSalesaBranch(branchId) };
}

export function GET() {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!), monthlyTarget: getMonthlyTarget(branchId!), merchantName: getMerchantName(branchId!), cardColor: getCardColor(branchId!), opensOn: branchOpensOn(branchId!), hours: getBranchHours(branchId!) });
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const Body = z.object({
  lineGroupId: z.string().max(200).nullable().optional(),
  monthlyTarget: z.number().min(0).max(1_000_000_000).nullable().optional(),
  merchantName: z.string().max(200).nullable().optional(),
  cardColor: z.string().max(9).nullable().optional(),
  opensOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Open/close are managed in RESERVA (branches); ANALYTICA only sets the break.
  break: z.object({
    breakStart: z.string().regex(HHMM).nullable(), breakEnd: z.string().regex(HHMM).nullable(),
    breakWeekdayOnly: z.boolean(),
  }).nullable().optional()
});

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (parsed.data.lineGroupId !== undefined) setLineGroupId(branchId!, parsed.data.lineGroupId);
  if (parsed.data.monthlyTarget !== undefined) setMonthlyTarget(branchId!, parsed.data.monthlyTarget);
  if (parsed.data.merchantName !== undefined) setMerchantName(branchId!, parsed.data.merchantName);
  if (parsed.data.cardColor !== undefined) setCardColor(branchId!, parsed.data.cardColor);
  if (parsed.data.opensOn !== undefined) setBranchOpensOn(branchId!, parsed.data.opensOn);
  if (parsed.data.break !== undefined) {
    try { setBranchBreak(branchId!, parsed.data.break); }
    catch { return NextResponse.json({ error: "bad_hours" }, { status: 400 }); }
  }
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!), monthlyTarget: getMonthlyTarget(branchId!), merchantName: getMerchantName(branchId!), cardColor: getCardColor(branchId!), opensOn: branchOpensOn(branchId!), hours: getBranchHours(branchId!) });
}
