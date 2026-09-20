import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import {
  isSalesaBranch, suggestMenuMerges, listMenuGroups,
  mergeMenuNames, ignoreMenuPair, unmergeMenuGroup
} from "@/lib/salesa-db";

// SALESA menu-name merging (owner 2026-09-20). A branch may rename a dish over
// time, so the same item appears under similar names and its sales get split.
//   GET  → { suggestions, groups } — likely-duplicate pairs to confirm, plus the
//          groups already confirmed.
//   POST → { action: "merge", names }      confirm names are one dish
//          { action: "ignore", a, b }      mark a pair as NOT the same
//          { action: "unmerge", root }     dissolve a confirmed group
// Non-destructive: the map is applied at read time, so every action is reversible.

export const dynamic = "force-dynamic";

function branchOr403(perm: "reporta.manage") {
  const user = requirePermission(perm);
  const branchId = user.activeBranchId ?? null;
  if (branchId == null || !isSalesaBranch(branchId)) return { error: true as const, user, branchId: null };
  return { error: false as const, user, branchId };
}

export function GET() {
  const ctx = branchOr403("reporta.manage");
  if (ctx.error) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  return NextResponse.json({
    ok: true,
    suggestions: suggestMenuMerges(ctx.branchId),
    groups: listMenuGroups(ctx.branchId)
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("merge"), names: z.array(z.string().min(1)).min(2) }),
  z.object({ action: z.literal("ignore"), a: z.string().min(1), b: z.string().min(1) }),
  z.object({ action: z.literal("unmerge"), root: z.string().min(1) })
]);

export async function POST(req: Request) {
  const ctx = branchOr403("reporta.manage");
  if (ctx.error) return NextResponse.json({ error: "no_branch" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const body = parsed.data;

  if (body.action === "merge") {
    const res = mergeMenuNames(ctx.branchId, body.names, ctx.user.id);
    if (!res) return NextResponse.json({ error: "need_two_names" }, { status: 400 });
  } else if (body.action === "ignore") {
    ignoreMenuPair(ctx.branchId, body.a, body.b, ctx.user.id);
  } else {
    unmergeMenuGroup(ctx.branchId, body.root);
  }
  // Return the fresh state so the client can re-render without a second call.
  return NextResponse.json({
    ok: true,
    suggestions: suggestMenuMerges(ctx.branchId),
    groups: listMenuGroups(ctx.branchId)
  });
}
