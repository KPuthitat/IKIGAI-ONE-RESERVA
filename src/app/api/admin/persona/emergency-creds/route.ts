import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { logPersonaAction } from "@/lib/db";
import { issueEmergencyCred } from "@/lib/emergency-creds";

// POST /api/admin/persona/emergency-creds — issue temp 24h creds.
// Body: { user_id }. Returns the plaintext temp username + password
// EXACTLY ONCE; admin needs to communicate it to the staff via a
// side channel (LINE chat, in person, whatever). After this response
// the password is never recoverable.

const Body = z.object({
  user_id: z.number().int().positive()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json(
    { error: "invalid_body", detail: parsed.error.flatten() }, { status: 400 }
  );
  const cred = issueEmergencyCred({
    userId: parsed.data.user_id,
    createdBy: user.id
  });
  logPersonaAction(user.id, "emergency_cred.issue", cred.id);
  return NextResponse.json({
    ok: true,
    id: cred.id,
    temp_username: cred.temp_username,
    temp_password: cred.temp_password,   // plaintext, shown once
    expires_at: cred.expires_at
  });
}
