import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateSystemSettings, logPersonaAction } from "@/lib/db";

// PATCH /api/admin/persona/resignation/settings
//
// Edit the two resignation-policy strings that live on
// system_settings:
//   • improper_resignation_consequences — bullet list shown to staff
//     on the resignation form + admin's decision modal
//   • resignation_unlock_message — LINE Flex body fired when admin
//     opens a staff's สิทธิ์ลาออก (uses {ADMIN} placeholder)
//
// Auth: admin / super_admin. These are PERSONA settings (HR
// policy), so requiring super_admin like /admin/system-settings
// would be overkill — branch admins should be able to author their
// own wording without needing the owner's credentials. The
// underlying DB column is system-wide today; if the owner later
// wants per-company / per-branch overrides, that's a schema
// migration, not an auth change.

const Body = z.object({
  improper_resignation_consequences: z.string().max(2000).optional(),
  resignation_unlock_message: z.string().max(1000).optional()
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

  // Only forward the fields we accept here so admin can't sneak
  // other system_settings columns into the patch via this endpoint.
  const patch: Parameters<typeof updateSystemSettings>[0] = {};
  if (parsed.data.improper_resignation_consequences !== undefined) {
    patch.improper_resignation_consequences = parsed.data.improper_resignation_consequences;
  }
  if (parsed.data.resignation_unlock_message !== undefined) {
    patch.resignation_unlock_message = parsed.data.resignation_unlock_message;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: true, noop: true });
  }

  updateSystemSettings(patch, user.id);
  logPersonaAction(user.id, "resignation_settings.update", null);
  return NextResponse.json({ ok: true });
}
