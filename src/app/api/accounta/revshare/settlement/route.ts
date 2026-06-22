import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  isRevshareBranch, previewSettlement, saveSettlement,
  issueSettlement, markPaidSettlement, revertSettlement
} from "@/lib/revshare-db";

// Monthly settlement. GET = live preview (+ stored snapshot + stale flag).
// POST action = save | issue | mark_paid | revert.

const PostZ = z.object({
  partner: z.number().int().positive(),
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  action: z.enum(["save", "issue", "mark_paid", "revert"]),
  invoice_no: z.string().trim().max(60).nullable().optional()
});

function ctx() {
  const user = requirePermission("accounta.manage");
  const branchId = user.activeBranchId ?? null;
  return { branchId, ok: branchId != null && isRevshareBranch(branchId) };
}
function bkkNowIso(): string { return new Date().toISOString(); }

export function GET(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const sp = new URL(req.url).searchParams;
  const partner = Number(sp.get("partner")), year = Number(sp.get("year")), month = Number(sp.get("month"));
  if (![partner, year, month].every(Number.isInteger)) return NextResponse.json({ error: "bad_params" }, { status: 400 });
  const preview = previewSettlement(partner, branchId!, year, month);
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ...preview });
}

export async function POST(req: Request) {
  const { branchId, ok } = ctx();
  if (!ok) return NextResponse.json({ error: "not_revshare_branch" }, { status: 403 });
  const parsed = PostZ.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const { partner, year, month, action, invoice_no } = parsed.data;
  let done = false;
  if (action === "save") done = !!saveSettlement(partner, branchId!, year, month);
  else if (action === "issue") done = issueSettlement(partner, branchId!, year, month, invoice_no ?? null, bkkNowIso());
  else if (action === "mark_paid") done = markPaidSettlement(partner, branchId!, year, month, bkkNowIso());
  else if (action === "revert") done = revertSettlement(partner, branchId!, year, month);
  if (!done) return NextResponse.json({ error: `${action}_failed` }, { status: 400 });
  const preview = previewSettlement(partner, branchId!, year, month);
  return NextResponse.json({ ok: true, ...preview });
}
