import { NextResponse } from "next/server";
import { checkDeployWindow } from "@/lib/deploy-window";

// GET /api/deploy-window
//
// Returns whether the current Bangkok-local moment is safe for a
// deploy — i.e. not within ±15 min of any scheduled shift start /
// end across any branch's roster for today.
//
// Auth: PUBLIC (read-only, non-sensitive). The endpoint exposes
// "is there a shift change happening soon" which an attacker could
// in theory use to time their own actions, but the risk is
// negligible compared to the operational benefit of letting both
// deploy.sh AND the developer-assistant (Claude) query the same
// truth without auth plumbing.
//
// Consumers:
//   • scripts/deploy.sh — pre-flight check, prompts on warning
//   • Claude in chat — should curl this before suggesting deploy
//   • Future: /admin dashboard widget showing "next safe window"

export const dynamic = "force-dynamic";

export async function GET() {
  const result = checkDeployWindow();
  return NextResponse.json(result, {
    headers: {
      // No caching — the result depends on current time + DB state.
      "Cache-Control": "no-store, must-revalidate"
    }
  });
}
