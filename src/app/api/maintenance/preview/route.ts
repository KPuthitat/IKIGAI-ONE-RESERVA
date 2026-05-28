import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import { generateMaintenanceHtml } from "@/lib/maintenance-page";

// GET /api/maintenance/preview
//
// Returns the live maintenance HTML so admin can preview what users
// will see during deploy WITHOUT having to actually take Next.js
// down. Pulls the current message from system_settings, runs it
// through the same generator that writes the on-disk file, and
// streams the HTML straight to the browser.
//
// Auth: super_admin only — the preview is harmless but the page
// exposes /admin/system-settings indirectly, so we keep the same
// gate as the settings page itself.

export const dynamic = "force-dynamic";

export async function GET() {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "super_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const settings = getSystemSettings();
  const html = generateMaintenanceHtml(settings.maintenance_message);
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    }
  });
}
