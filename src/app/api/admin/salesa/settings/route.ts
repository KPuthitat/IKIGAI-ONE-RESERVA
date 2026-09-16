import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { isSalesaBranch, getLineGroupId, setLineGroupId } from "@/lib/salesa-db";

// SALESA settings — the HOD LINE group id the daily/weekly cards are pushed to
// (per branch). The IKIGAI OS platform OA must be a member of that group.
// Owner 2026-09-16.

export const dynamic = "force-dynamic";

function ctx() {
  const user = requirePermission("salesa.manage");
  const branchId = user.activeBranchId ?? null;
  return { user, branchId, ok: branchId != null && isSalesaBranch(branchId) };
}

export function GET() {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!) });
}

const Body = z.object({ lineGroupId: z.string().max(200).nullable() });

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  setLineGroupId(branchId!, parsed.data.lineGroupId);
  return NextResponse.json({ ok: true, lineGroupId: getLineGroupId(branchId!) });
}
