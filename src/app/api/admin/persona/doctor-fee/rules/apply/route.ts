import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePayrollAccess } from "@/lib/auth";
import { isDfBranch, listRules, upsertSingleTagRule } from "@/lib/df-db";

// POST /api/admin/persona/doctor-fee/rules/apply
//   Create/update DF rules from the codes the admin ticked in the file scan
//   (owner 2026-09-13). One rule per tag: { picks: [{ tag, rate }] }. Existing
//   single-tag rules are updated + re-activated; new ones are created.

export const dynamic = "force-dynamic";

const Body = z.object({
  picks: z.array(z.object({
    tag: z.string().trim().min(1).max(40),
    rate: z.number().min(0).max(1)
  })).min(1).max(60)
}).strict();

export async function POST(req: Request) {
  const user = requirePayrollAccess();
  const branchId = user.activeBranchId ?? null;
  if (branchId == null) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  if (!isDfBranch(branchId)) return NextResponse.json({ error: "not_df_branch" }, { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 });

  // De-dup by tag (last rate wins) so a double-tick can't make two rules.
  const byTag = new Map<string, number>();
  for (const p of parsed.data.picks) byTag.set(p.tag.trim().toUpperCase(), p.rate);
  for (const [tag, rate] of byTag) upsertSingleTagRule(branchId, tag, rate);

  return NextResponse.json({ ok: true, applied: byTag.size, rules: listRules(branchId) });
}
