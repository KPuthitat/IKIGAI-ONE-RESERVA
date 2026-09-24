import { NextResponse } from "next/server";
import { z } from "zod";
import QRCode from "qrcode";
import {
  getReviewConfig,
  getBranchReviewInfo,
  submitReview,
  resolveReviewInvite,
  hashLineUserId,
  customerRewardCountAtBranch
} from "@/lib/insigna";
import { notifyReviewReward } from "@/lib/line";

// POST /api/insigna/reviews  — PUBLIC (no auth).
//
// The customer-facing feedback form posts here. It resolves the branch
// by slug, records the review, and returns the routing payload the
// thank-you screen needs (tier, the branch's Google link, and the
// reward code if a reward is configured). No name/phone/email is stored.
// An optional invite token (t) is resolved to a raw LINE id server-side
// and immediately hashed to the INSIGNA pseudonym — only that hash is
// persisted on the review row.

export const dynamic = "force-dynamic";

// Best-effort per-IP throttle to blunt reward-code farming on this
// public, unauthenticated endpoint. In-memory is fine here: prod runs
// as a single PM2 process (see CLAUDE.md). Not a hard security boundary
// — the reward is staff-verified on redemption — just a speed bump.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // opportunistic cleanup so the map doesn't grow unbounded
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

const Body = z.object({
  branch_slug: z.string().min(1).max(80),
  rating: z.number().int().min(1).max(5),
  food_rating: z.number().int().min(1).max(5).nullish(),
  service_rating: z.number().int().min(1).max(5).nullish(),
  ambience_rating: z.number().int().min(1).max(5).nullish(),
  return_intent: z.boolean().nullish(),
  // Cap the free-text so a public endpoint can't be used to dump
  // arbitrarily large blobs into the DB.
  comment: z.string().max(1000).nullish(),
  // Optional invite token from a LINE thank-you card — resolved to the
  // customer's pseudonym server-side. Absent for anonymous QR reviews.
  t: z.string().max(64).nullish()
});

export async function POST(req: Request) {
  const cfg = getReviewConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ error: "reviews_disabled" }, { status: 403 });
  }

  if (rateLimited(clientIp(req))) {
    return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const branch = getBranchReviewInfo(parsed.data.branch_slug);
  if (!branch) {
    return NextResponse.json({ error: "unknown_branch" }, { status: 404 });
  }

  // Resolve the invite token (if any) to the customer's INSIGNA pseudonym.
  // The raw LINE id is hashed here and never stored on the review row — but we
  // keep it in-memory for this request so the reward card can be pushed back
  // into the customer's OA chat (owner 2026-09-24: the code lives in LINE).
  let customerHash: string | null = null;
  let inviteLineUserId: string | null = null;
  if (parsed.data.t) {
    try {
      const invite = resolveReviewInvite(parsed.data.t);
      if (invite) {
        customerHash = hashLineUserId(invite.line_user_id);
        inviteLineUserId = invite.line_user_id;
      }
    } catch (e) {
      // e.g. INSIGNA_SALT not set — never fail the review over identity;
      // just record it anonymously.
      console.warn("[insigna-reviews] identity resolve failed:", e);
    }
  }

  const result = submitReview({
    branch_id: branch.branch_id,
    rating: parsed.data.rating,
    food_rating: parsed.data.food_rating ?? null,
    service_rating: parsed.data.service_rating ?? null,
    ambience_rating: parsed.data.ambience_rating ?? null,
    return_intent: parsed.data.return_intent ?? null,
    comment: parsed.data.comment ?? null,
    customer_hash: customerHash
  });

  // A scannable QR of the reward code so staff can redeem it with the camera
  // (via น้องฮูก) instead of typing (owner 2026-09-24). Encodes the plain code.
  let rewardQr: string | null = null;
  if (result.reward_code) {
    rewardQr = await QRCode.toDataURL(result.reward_code, { width: 320, margin: 1, errorCorrectionLevel: "M" })
      .catch(() => null);
  }

  // Identified via LINE + a reward was issued → push the code into the
  // customer's OA chat so it's SAVED in LINE (owner 2026-09-24), not lost when
  // the browser tab closes. Only when this is the customer's ONLY reward at
  // this branch (count === 1, the row just minted) — so a resubmit or a repeat
  // visit doesn't stack cards, and a customer who already has a code (the cap
  // is 1 per branch) isn't handed one they can't redeem. Fire-and-forget: prod
  // is a long-lived PM2 process, so don't block the thank-you screen on LINE.
  if (
    inviteLineUserId && customerHash && result.reward_code && result.reward_text &&
    customerRewardCountAtBranch(customerHash, branch.branch_id) === 1
  ) {
    void notifyReviewReward({
      branchId: branch.branch_id,
      lineUserId: inviteLineUserId,
      code: result.reward_code,
      rewardText: result.reward_text
    }).catch((e) => console.warn("[insigna-reviews] reward push failed:", e));
  }

  return NextResponse.json({ ok: true, ...result, reward_qr: rewardQr });
}
