import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { listOptionGroups, OptionError, OPTION_ERROR_TH, saveItemOptions } from "@/lib/delivera/options";

// Admin (session): read / replace the option groups of one DELIVERA menu item (branch-scoped in the lib).
export const dynamic = "force-dynamic";

const Body = z.object({
  groups: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    min_pick: z.number().int().min(0).max(40), max_pick: z.number().int().min(1).max(40),
    choices: z.array(z.object({ name: z.string().trim().min(1).max(60), price_delta: z.number().min(-100000).max(100000), is_available: z.boolean().optional() })).min(1).max(40)
  })).max(12)
});

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const id = Number(params.id);
  return NextResponse.json({ ok: true, groups: listOptionGroups([id]).get(id) ?? [] });
}

export async function PUT(req: Request, { params }: { params: { id: string } }) {
  const user = requirePermission("delivera.manage");
  if (!user.activeBranchId) return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: OPTION_ERROR_TH.option_bad_input }, { status: 400 });
  try {
    const ok = saveItemOptions(user.activeBranchId, Number(params.id), parsed.data.groups.map((g) => ({
      name: g.name, minPick: g.min_pick, maxPick: g.max_pick,
      choices: g.choices.map((c) => ({ name: c.name, priceDelta: c.price_delta, available: c.is_available }))
    })));
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (e) {
    if (e instanceof OptionError) return NextResponse.json({ error: e.code, message: `${OPTION_ERROR_TH[e.code]}${e.detail ? ` (${e.detail})` : ""}` }, { status: 400 });
    throw e;
  }
}
