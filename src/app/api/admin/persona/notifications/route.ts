import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateSystemSettings, logPersonaAction } from "@/lib/db";

// PATCH /api/admin/persona/notifications
//
// Single endpoint for the /admin/persona/notifications customiser to
// save any of the LINE-card template overrides stored on
// system_settings. Each field is OPTIONAL — caller patches one
// template at a time. Empty string ("") clears the override back to
// the built-in default; omitting a field leaves it unchanged.
//
// Current templates:
//   • shift_greetings_work — newline-separated greeting pool used
//     when the staff has a work shift today
//   • shift_greetings_day_off — same, for off-roster days
//   • shift_greetings_on_leave — same, for approved-leave days
//
// resignation_unlock_message lives on a separate route
// (/api/admin/persona/resignation/settings) because it's grouped
// with the resignation policy editor in the UI. New template fields
// added here should bias toward this single endpoint to keep the
// /admin/persona/notifications page round-trip simple.
//
// Auth: admin / super_admin. Same threshold as resignation settings
// — branch admins author their own wording.

const Body = z.object({
  shift_greetings_work: z.string().max(4000).optional(),
  shift_greetings_day_off: z.string().max(4000).optional(),
  shift_greetings_on_leave: z.string().max(4000).optional()
});

export async function PATCH(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Forward only the fields the schema accepts so this endpoint
  // can't be used to mutate unrelated system_settings columns.
  const patch: Parameters<typeof updateSystemSettings>[0] = {};
  if (parsed.data.shift_greetings_work !== undefined) {
    patch.shift_greetings_work = parsed.data.shift_greetings_work;
  }
  if (parsed.data.shift_greetings_day_off !== undefined) {
    patch.shift_greetings_day_off = parsed.data.shift_greetings_day_off;
  }
  if (parsed.data.shift_greetings_on_leave !== undefined) {
    patch.shift_greetings_on_leave = parsed.data.shift_greetings_on_leave;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  updateSystemSettings(patch, user.id);
  logPersonaAction(user.id, "notification_templates.update", null);
  return NextResponse.json({ ok: true });
}
