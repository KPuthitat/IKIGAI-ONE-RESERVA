import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listExecMeetingsForUser } from "@/lib/exec-meetings";

// GET /api/persona/exec-meetings — meetings the current staff member is invited
// to (any status; the client shows join/minutes/end by state).
export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json({ meetings: listExecMeetingsForUser(user.id) });
}
