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
  global_line_channel_token: z.string().max(500).optional(),
  global_staff_group_id: z.string().max(100).optional(),
  // Escalation window in hours — 1h to 30 days. Comes off the wire
  // as a digit string (client uses FormData-style serialisation).
  default_escalation_hours: z.string().regex(/^\d{1,3}$/).optional(),
  // Free-text policy: "การลาออกไม่ถูกระเบียบจะเสียสิทธิ์อะไรบ้าง".
  // Capped at 2000 chars — enough for a bullet list of consequences.
  improper_resignation_consequences: z.string().max(2000).optional(),
  // Body text of the LINE Flex card sent when admin opens a staff's
  // resignation gate. {ADMIN} placeholder replaced at send time with
  // the admin's display_name. 1000-char cap is generous; the card
  // body wraps but you don't want War and Peace in a notification.
  resignation_unlock_message: z.string().max(1000).optional(),
  // Maintenance banner template text. Persisted even when banner is
  // off — owner authors once, toggles on/off via maintenance_active.
  // 500-char cap is enough for a deploy-window notice.
  maintenance_message: z.string().max(500).optional(),
  // Toggle: "true"/"false" from the form. Coerced to 0/1 in
  // updateSystemSettings. Banner renders only when this is true AND
  // message non-empty.
  maintenance_active: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional()
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

  // Escalation hours comes off the wire as a digit string; coerce to
  // INTEGER + clamp here (server-side defence in depth — client also
  // clamps in SystemSettingsForm). Missing key = leave column alone.
  const dbPatch: Parameters<typeof updateSystemSettings>[0] = {};
  if (parsed.data.global_line_channel_token !== undefined) {
    dbPatch.global_line_channel_token = parsed.data.global_line_channel_token;
  }
  if (parsed.data.global_staff_group_id !== undefined) {
    dbPatch.global_staff_group_id = parsed.data.global_staff_group_id;
  }
  if (parsed.data.default_escalation_hours !== undefined) {
    const h = parseInt(parsed.data.default_escalation_hours, 10);
    dbPatch.default_escalation_hours = Math.max(1, Math.min(720, h));
  }
  if (parsed.data.improper_resignation_consequences !== undefined) {
    dbPatch.improper_resignation_consequences = parsed.data.improper_resignation_consequences;
  }
  if (parsed.data.resignation_unlock_message !== undefined) {
    dbPatch.resignation_unlock_message = parsed.data.resignation_unlock_message;
  }
  if (parsed.data.maintenance_message !== undefined) {
    dbPatch.maintenance_message = parsed.data.maintenance_message;
  }
  if (parsed.data.maintenance_active !== undefined) {
    // Accept boolean OR the strings "true"/"false" (form serialisation
    // sometimes coerces booleans to strings). Normalise to 0/1.
    const v = parsed.data.maintenance_active;
    dbPatch.maintenance_active = (v === true || v === "true") ? 1 : 0;
  }

  updateSystemSettings(dbPatch, user.id);

  // Activity log — captures every change to system-wide config.
  // ref_id is null because the entity changed is the singleton row.
  logPersonaAction(user.id, "system_settings.update", null);

  return NextResponse.json({ ok: true });
}
