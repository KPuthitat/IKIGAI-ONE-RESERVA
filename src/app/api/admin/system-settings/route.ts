import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateSystemSettings, logPersonaAction } from "@/lib/db";

// POST /api/admin/system-settings
//
// Admin updates the GLOBAL configuration that isn't branch-scoped —
// today this is the IKIGAI OS LINE OA push token + the cross-branch
// staff group ID used to route PERSONA notifications.
//
// Empty strings are normalised to NULL on the way to the DB (handled
// inside updateSystemSettings) so admin can clear a field by blanking
// the input rather than typing a sentinel value.
//
// Auth: admin role only. Unlike branch-scoped settings this is
// system-wide, so we don't filter by activeBranchId — but we still
// require an active admin session.

const Body = z.object({
  // LINE channel access token — opaque base64 from the LINE Developers
  // console. We don't validate its format because LINE has rotated
  // token shapes a few times; just accept any non-empty string and
  // let LINE's own API reject malformed ones on first push.
  global_line_channel_token: z.string().max(500).optional(),
  // LINE group ID — starts with 'C' followed by 32 hex chars. We do
  // a loose check (starts with C, 33 chars total) rather than strict
  // regex because the prefix has changed historically.
  global_staff_group_id: z.string().max(100).optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden_super_admin_only" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Light validation for the group ID — must look like a LINE group
  // identifier. Empty string passes (means "clear it") and is
  // normalised to NULL inside updateSystemSettings.
  if (parsed.data.global_staff_group_id) {
    const g = parsed.data.global_staff_group_id.trim();
    if (g && !/^[CRU][0-9a-f]{32}$/i.test(g)) {
      return NextResponse.json(
        {
          error: "invalid_group_id",
          message: "LINE group ID should start with C/R/U followed by 32 hex characters"
        },
        { status: 400 }
      );
    }
  }

  updateSystemSettings(parsed.data, user.id);

  // Activity log — captures every change to system-wide config.
  // ref_id is null because the entity changed is the singleton row.
  logPersonaAction(user.id, "system_settings.update", null);

  return NextResponse.json({ ok: true });
}
