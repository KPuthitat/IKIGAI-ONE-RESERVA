import { NextResponse } from "next/server";
import { z } from "zod";
import { trackGoogleClick } from "@/lib/insigna";

// POST /api/insigna/reviews/track  — PUBLIC (no auth).
//
// Fire-and-forget beacon the thank-you screen sends when the customer
// taps the Google-review button, so หลังบ้าน can measure click-through.
// Unknown tokens are a silent no-op (the service swallows them), so this
// always returns ok — it must never block the customer's tap.

export const dynamic = "force-dynamic";

const Body = z.object({
  token: z.string().min(1).max(64),
  event: z.literal("google_click")
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (parsed.success) {
    trackGoogleClick(parsed.data.token);
  }
  return NextResponse.json({ ok: true });
}
