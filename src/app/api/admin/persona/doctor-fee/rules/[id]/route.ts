import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { isDfBranch, updateRule, deleteRule, listRules } from "@/lib/df-db";

// PATCH  /api/admin/persona/doctor-fee/rules/[id]  — edit name/tags/rate/active
// DELETE /api/admin/persona/doctor-fee/rules/[id]

export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  item_tags: z.array(z.string().trim().min(1).max(40)).min(1).max(30).optional(),
  rate: z.number().min(0).max(1).optional(),
  active: z.boolean().optional()
}).strict();

function ctx() {
  const user = requirePayrollAccess();
  return { user, branchId: user.activeBranchId ?? null };
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });
  const updated = updateRule(id, branchId, parsed.data);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, rules: listRules(branchId) });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const { branchId } = ctx();
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  if (!deleteRule(id, branchId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, rules: listRules(branchId) });
}
