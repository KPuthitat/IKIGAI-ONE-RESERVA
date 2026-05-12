import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, userHasBranch } from "@/lib/auth";
import { getDb, logPersonaAction } from "@/lib/db";

// POST /api/admin/persona/branch-settings
//
// Admin writes per-branch PERSONA settings. Scope today is just the
// two readiness round times (morning + afternoon HH:MM) so the
// LINE Flex cards and staff page subtitles render the right time
// per branch. The branch is always the admin's activeBranchId —
// no branch_id in the body, keeping cross-branch privilege
// escalation impossible by construction.
//
// More PERSONA branch settings will probably land here later
// (shift cutoff times, payroll-period boundaries, etc.); for now
// the route is intentionally minimal.

// HH:MM where hour is 00-23 and minute is 00-59. Accepts single-digit
// hour too (e.g., "9:30") but normalises to "09:30" before save so
// downstream code (LINE Flex builder, page subtitle) doesn't have to
// handle both shapes.
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function normalizeTime(input: string): string {
  const m = TIME_RE.exec(input.trim());
  if (!m) return input;   // caller already validated; defensive
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}`;
}

// Lenient hex colour check — accepts #RGB / #RRGGBB / #RRGGBBAA with
// or without the leading #. We normalise to #RRGGBB on the way to
// the DB. Empty string / null = "clear it, use default".
const HEX_COLOR_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const Body = z.object({
  readiness_morning_time: z.string().regex(TIME_RE, "invalid_time"),
  readiness_afternoon_time: z.string().regex(TIME_RE, "invalid_time"),
  // brand_color is fully optional; null/empty clears the field
  // (the LINE Flex card then falls back to the IKIGAI default ink).
  brand_color: z.string().regex(HEX_COLOR_RE, "invalid_color").nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!user.activeBranchId) {
    return NextResponse.json({ error: "no_active_branch" }, { status: 400 });
  }
  // Belt-and-braces: even though activeBranchId comes from the
  // session, double-check the admin is actually assigned to it.
  if (!userHasBranch(user, user.activeBranchId)) {
    return NextResponse.json({ error: "branch_forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", detail: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const morning = normalizeTime(parsed.data.readiness_morning_time);
  const afternoon = normalizeTime(parsed.data.readiness_afternoon_time);
  // Normalise brand_color: prefix with # if missing, lowercase,
  // null when explicitly cleared. The Zod schema already validated
  // the hex format (or null).
  let brandColor: string | null = null;
  if (parsed.data.brand_color) {
    const raw = parsed.data.brand_color.trim().toLowerCase();
    brandColor = raw.startsWith("#") ? raw : `#${raw}`;
  }

  const db = getDb();
  db.prepare(`
    UPDATE branches
    SET readiness_morning_time = ?,
        readiness_afternoon_time = ?,
        brand_color = ?
    WHERE id = ?
  `).run(morning, afternoon, brandColor, user.activeBranchId);

  // Activity log so the audit trail captures who tweaked the
  // round times. ref_id = branch_id (the entity being changed).
  logPersonaAction(
    user.id,
    "branch_settings.readiness_times.update",
    user.activeBranchId
  );

  return NextResponse.json({
    ok: true,
    readiness_morning_time: morning,
    readiness_afternoon_time: afternoon,
    brand_color: brandColor
  });
}
