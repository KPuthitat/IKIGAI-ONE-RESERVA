import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, getLineGroupId, setLineGroupId, getMonthlyTarget, setMonthlyTarget, getMerchantName, setMerchantName } from "@/lib/salesa-db";

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
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!), monthlyTarget: getMonthlyTarget(branchId!), merchantName: getMerchantName(branchId!) });
}

const Body = z.object({
  lineGroupId: z.string().max(200).nullable().optional(),
  monthlyTarget: z.number().min(0).max(1_000_000_000).nullable().optional(),
  merchantName: z.string().max(200).nullable().optional()
});

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  if (parsed.data.lineGroupId !== undefined) setLineGroupId(branchId!, parsed.data.lineGroupId);
  if (parsed.data.monthlyTarget !== undefined) setMonthlyTarget(branchId!, parsed.data.monthlyTarget);
  if (parsed.data.merchantName !== undefined) setMerchantName(branchId!, parsed.data.merchantName);
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!), monthlyTarget: getMonthlyTarget(branchId!), merchantName: getMerchantName(branchId!) });
}
