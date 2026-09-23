import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getReviewConfig,
  getBranchReviewInfo,
  submitReview
} from "@/lib/insigna";

// POST /api/insigna/reviews  — PUBLIC (no auth).
//
// The customer-facing feedback form posts here. It resolves the branch
// by slug, records the review, and returns the routing payload the
// thank-you screen needs (tier, the branch's Google link, and the
// reward code if a reward is configured). No PII is accepted or stored.

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
  comment: z.string().max(1000).nullish()
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

  const result = submitReview({
    branch_id: branch.branch_id,
    rating: parsed.data.rating,
    food_rating: parsed.data.food_rating ?? null,
    service_rating: parsed.data.service_rating ?? null,
    ambience_rating: parsed.data.ambience_rating ?? null,
    return_intent: parsed.data.return_intent ?? null,
    comment: parsed.data.comment ?? null
  });

  return NextResponse.json({ ok: true, ...result });
}
