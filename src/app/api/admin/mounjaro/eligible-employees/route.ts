import { NextResponse } from "next/server";
import { getSessionUser, isClinicalUnlocked } from "@/lib/auth";
import { listEligibleEmployees, type MjActor } from "@/lib/mounjaro-db";

// GET /api/admin/mounjaro/eligible-employees — list active employees who
// are eligible to be invited to the weight-control program (no current
// active or confirmed-pending enrollment). Doctor + unlock gated.
// Used to populate the invite-employee dropdown in ClinicalClient.

function gate() {
  const user = getSessionUser();
  if (!user) return { error: "unauthenticated", status: 401 as const };
  if (user.clinical_role !== "doctor") return { error: "forbidden", status: 403 as const };
  if (!isClinicalUnlocked(user)) return { error: "locked", status: 403 as const };
  return { user };
}

export async function GET() {
  const g = gate();
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: g.status });
  const employees = listEligibleEmployees(g.user as MjActor);
  return NextResponse.json({ ok: true, employees });
}
