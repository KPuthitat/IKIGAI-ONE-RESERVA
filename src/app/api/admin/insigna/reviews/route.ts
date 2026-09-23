import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import {
  saveReviewConfig,
  setBranchGoogleUrl,
  claimReward
} from "@/lib/insigna";

// POST /api/admin/insigna/reviews  — admin only.
//
// One endpoint, three actions for the review-funnel back office:
//   • config      — toggle the funnel, set the reward text + star threshold
//   • branch_url  — set a branch's Google "write a review" link
//   • claim       — redeem a reward code a customer shows on the next visit

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("config"),
    enabled: z.boolean().optional(),
    reward_text: z.string().max(200).nullish(),
    high_threshold: z.number().int().min(2).max(5).optional()
  }),
  z.object({
    action: z.literal("branch_url"),
    branch_id: z.number().int().positive(),
    url: z.string().max(500).nullish()
  }),
  z.object({
    action: z.literal("claim"),
    reward_code: z.string().min(1).max(32)
  })
]);

export async function POST(req: Request) {
  // Match the module gate (layout.tsx uses insigna.view) so a console
  // user without INSIGNA access can't drive these mutations through the
  // API — requireAdmin() would have let any permissioned admin in.
  const user = requirePermission("insigna.view");
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const data = parsed.data;

  if (data.action === "config") {
    const cfg = saveReviewConfig({
      enabled: data.enabled,
      reward_text: data.reward_text === undefined ? undefined : data.reward_text,
      high_threshold: data.high_threshold
    });
    logPersonaAction(user.id, "insigna.reviews_config", null);
    return NextResponse.json({ ok: true, config: cfg });
  }

  if (data.action === "branch_url") {
    setBranchGoogleUrl(data.branch_id, data.url ?? null);
    logPersonaAction(user.id, "insigna.reviews_branch_url", data.branch_id);
    return NextResponse.json({ ok: true });
  }

  // claim — the reward code isn't a numeric ref, so no ref_id
  const result = claimReward(data.reward_code);
  logPersonaAction(user.id, "insigna.reviews_claim", null);
  return NextResponse.json({ ok: result === "claimed", result });
}
