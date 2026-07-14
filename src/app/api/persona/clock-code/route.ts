import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb, type Branch } from "@/lib/db";
import { currentClockCode, secondsUntilRollover, CLOCK_CODE_STEP_SEC } from "@/lib/clock-code";

// GET /api/persona/clock-code
//
// Returns the CURRENT rotating clock-in code for the caller's active branch, so
// the door-display page (/staff/persona/clock-qr) can render it as a QR and
// poll for the next one. Auth: any signed-in member of the branch — the code is
// only useful to actually clock in when combined with GPS geofence (enforced by
// the clock route), so exposing it to a member is fine; a code fetched from home
// still can't punch. Rotating-QR must be enabled on the branch (secret set).
export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }

  const branch = getDb().prepare("SELECT * FROM branches WHERE id = ?")
    .get(user.activeBranchId) as Branch | undefined;
  if (!branch) return NextResponse.json({ error: "branch_not_found" }, { status: 404 });
  if (!branch.clock_totp_secret) {
    // Rotating QR not enabled for this branch.
    return NextResponse.json({ error: "rotating_qr_disabled" }, { status: 400 });
  }

  const now = Date.now();
  return NextResponse.json({
    ok: true,
    branchName: branch.name,
    code: currentClockCode(branch.clock_totp_secret, now),
    secondsLeft: secondsUntilRollover(now),
    stepSec: CLOCK_CODE_STEP_SEC
  });
}
