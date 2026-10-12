import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listForUser, pendingAckCount } from "@/lib/policy-notices";

// GET → this employee's notices: meeting announcements and the letters that were sent to them.
export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json({ ok: true, notices: listForUser(user.id), pending: pendingAckCount(user.id) });
}
