import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { isDfBranch, listRules, createRule } from "@/lib/df-db";

// GET  /api/admin/persona/doctor-fee/rules  — list fee rules
// POST /api/admin/persona/doctor-fee/rules  — create one

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(120),
  item_tags: z.array(z.string().trim().min(1).max(40)).min(1).max(30),
  rate: z.number().min(0).max(1),
  active: z.boolean().optional()
}).strict();

function ctx() {
  const user = requirePayrollAccess();
  return { user, branchId: user.activeBranchId ?? null };
}

export async function GET() {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  return NextResponse.json({ ok: true, rules: listRules(branchId) });
}

export async function POST(req: Request) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;
  createRule(branchId, { name: d.name, item_tags: d.item_tags, rate: d.rate, active: d.active ?? true });
  return NextResponse.json({ ok: true, rules: listRules(branchId) });
}
