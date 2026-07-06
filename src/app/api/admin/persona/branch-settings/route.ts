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
  brand_color: z.string().regex(HEX_COLOR_RE, "invalid_color").nullable().optional(),

  // RECRUITA per-branch interview venue (owner 2026-07-06). address = free-text
  // venue shown to the candidate; map_url = nav link (must be http(s) when set).
  interview_address: z.string().max(500).nullable().optional(),
  interview_map_url: z.string().max(1000).nullable().optional(),

  // PERSONA Time Clock anti-cheat config — all optional; client only
  // sends fields the admin actually touched in the form. Validation:
  //   • lat/lng: standard WGS84 ranges
  //   • radius: 10m-5km bounds — narrower than 10m is impractical
  //     (GPS drift on a phone can be 3-10m even outdoors), wider
  //     than 5km defeats the geofence's purpose
  //   • qr_token: 8-64 chars, URL-safe characters only; null clears it
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  geofence_radius_meters: z.number().int().min(10).max(5000).optional(),
  geofence_enabled: z.boolean().optional(),
  clock_qr_token: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid_qr_token").nullable().optional(),
  clock_qr_enabled: z.boolean().optional(),
  // Whether the shift_close staff form must collect a service-charge
  // amount at the top (feeds the staff-share calculator). Added
  // 2026-05-23. Default off — existing branches stay unchanged.
  require_service_charge: z.boolean().optional(),
  // Required-financial-checklist toggles (2026-05-25). Default ON
  // for every branch via the schema; admin can flip per branch.
  require_yesterday_closing: z.boolean().optional(),
  require_morning_opening: z.boolean().optional(),
  require_today_closing: z.boolean().optional(),
  // 2026-05-28: per-branch toggle for the "ยอดขายวันนี้" field on
  // the shift_close form. ON = staff see + can fill, OFF = field
  // hidden and admin backfills via /admin/ascenda/revenue.
  require_daily_revenue: z.boolean().optional(),
  // Material-purchase quota (owner 2026-06-21). X = monthly sales target,
  // Y = max material %, weekday = the one weekly buying day (0=Sun…6=Sat).
  material_quota_enabled: z.boolean().optional(),
  material_target_sales: z.number().min(0).max(1_000_000_000).optional(),
  material_budget_pct: z.number().min(0).max(100).optional(),
  material_purchase_weekday: z.number().int().min(0).max(6).optional(),

  // Daily attendance summary — legacy single time (kept for backwards compat).
  attendance_summary_time: z.string().regex(TIME_RE, "invalid_time").nullable().optional(),
  // New multi-time JSON array (supersedes single time when present).
  // Form sends a JSON string like '["08:30","17:00"]'.
  attendance_summary_times_json: z.string().nullable().optional(),
  // Per-shift personal LINE reminder time (HH:MM Bangkok). null /
  // empty = auto-send off (manual roster button still works).
  shift_notify_time: z.string().regex(TIME_RE, "invalid_time").nullable().optional(),
  // Daily pending-requests digest time (HH:MM Bangkok). null / empty =
  // digest off. When set, the cron posts a summary of staff requests
  // still waiting (shift-change + pending leave) to the exec/HR group.
  pending_digest_time: z.string().regex(TIME_RE, "invalid_time").nullable().optional()
});

export async function POST(req: Request) {
  const user = getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (user.role !== "admin" && user.role !== "super_admin") {
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

  // Build a dynamic UPDATE so admin can patch a subset of fields
  // — the Time Clock anti-cheat section is independent of the
  // readiness times + brand colour above, and clients only send
  // what they actually changed.
  const db = getDb();
  const sets: string[] = [
    "readiness_morning_time = ?",
    "readiness_afternoon_time = ?",
    "brand_color = ?"
  ];
  const vals: Array<string | number | null> = [morning, afternoon, brandColor];

  if (Object.prototype.hasOwnProperty.call(parsed.data, "latitude")) {
    sets.push("latitude = ?");
    vals.push(parsed.data.latitude ?? null);
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data, "longitude")) {
    sets.push("longitude = ?");
    vals.push(parsed.data.longitude ?? null);
  }
  if (parsed.data.geofence_radius_meters !== undefined) {
    sets.push("geofence_radius_meters = ?");
    vals.push(parsed.data.geofence_radius_meters);
  }
  if (parsed.data.geofence_enabled !== undefined) {
    sets.push("geofence_enabled = ?");
    vals.push(parsed.data.geofence_enabled ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data, "clock_qr_token")) {
    sets.push("clock_qr_token = ?");
    vals.push(parsed.data.clock_qr_token ?? null);
  }
  if (parsed.data.clock_qr_enabled !== undefined) {
    sets.push("clock_qr_enabled = ?");
    vals.push(parsed.data.clock_qr_enabled ? 1 : 0);
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data, "interview_address")) {
    sets.push("interview_address = ?");
    vals.push(parsed.data.interview_address?.trim() || null);
  }
  if (Object.prototype.hasOwnProperty.call(parsed.data, "interview_map_url")) {
    const raw = (parsed.data.interview_map_url ?? "").trim();
    if (raw && !/^https?:\/\//i.test(raw)) {
      return NextResponse.json(
        { error: "bad_url", message: "ลิงก์แผนที่ต้องขึ้นต้นด้วย http:// หรือ https://" },
        { status: 400 }
      );
    }
    sets.push("interview_map_url = ?");
    vals.push(raw || null);
  }
  if (parsed.data.require_service_charge !== undefined) {
    sets.push("require_service_charge = ?");
    vals.push(parsed.data.require_service_charge ? 1 : 0);
  }
  if (parsed.data.require_yesterday_closing !== undefined) {
    sets.push("require_yesterday_closing = ?");
    vals.push(parsed.data.require_yesterday_closing ? 1 : 0);
  }
  if (parsed.data.require_morning_opening !== undefined) {
    sets.push("require_morning_opening = ?");
    vals.push(parsed.data.require_morning_opening ? 1 : 0);
  }
  if (parsed.data.require_today_closing !== undefined) {
    sets.push("require_today_closing = ?");
    vals.push(parsed.data.require_today_closing ? 1 : 0);
  }
  if (parsed.data.require_daily_revenue !== undefined) {
    sets.push("require_daily_revenue = ?");
    vals.push(parsed.data.require_daily_revenue ? 1 : 0);
  }
  if (parsed.data.material_quota_enabled !== undefined) {
    sets.push("material_quota_enabled = ?");
    vals.push(parsed.data.material_quota_enabled ? 1 : 0);
  }
  if (parsed.data.material_target_sales !== undefined) {
    sets.push("material_target_sales = ?");
    vals.push(parsed.data.material_target_sales);
  }
  if (parsed.data.material_budget_pct !== undefined) {
    sets.push("material_budget_pct = ?");
    vals.push(parsed.data.material_budget_pct);
  }
  if (parsed.data.material_purchase_weekday !== undefined) {
    sets.push("material_purchase_weekday = ?");
    vals.push(parsed.data.material_purchase_weekday);
  }
  // attendance_summary_times_json — new multi-time path (JSON array).
  // Reset sent_log + last_sent_date on any change so today's summary
  // fires again if the times were edited.
  if (Object.prototype.hasOwnProperty.call(parsed.data, "attendance_summary_times_json")) {
    const raw = parsed.data.attendance_summary_times_json;
    sets.push("attendance_summary_times_json = ?");
    vals.push(raw ?? null);
    sets.push("attendance_summary_sent_log = ?");
    vals.push(null);
    sets.push("attendance_summary_last_sent_date = ?");
    vals.push(null);
  }
  // Legacy single-time path — kept for backwards compat.
  if (Object.prototype.hasOwnProperty.call(parsed.data, "attendance_summary_time")) {
    const raw = parsed.data.attendance_summary_time;
    const normalised = raw ? normalizeTime(raw) : null;
    sets.push("attendance_summary_time = ?");
    vals.push(normalised);
    sets.push("attendance_summary_last_sent_date = ?");
    vals.push(null);
  }
  // shift_notify_time — same normalise + reset-dedupe rule so a time
  // change re-arms today's auto reminder.
  if (Object.prototype.hasOwnProperty.call(parsed.data, "shift_notify_time")) {
    const raw = parsed.data.shift_notify_time;
    const normalised = raw ? normalizeTime(raw) : null;
    sets.push("shift_notify_time = ?");
    vals.push(normalised);
    sets.push("shift_notify_last_sent_date = ?");
    vals.push(null);
  }
  // pending_digest_time — same normalise + reset-dedupe rule so
  // changing the time re-arms today's digest.
  if (Object.prototype.hasOwnProperty.call(parsed.data, "pending_digest_time")) {
    const raw = parsed.data.pending_digest_time;
    const normalised = raw ? normalizeTime(raw) : null;
    sets.push("pending_digest_time = ?");
    vals.push(normalised);
    sets.push("pending_digest_last_sent_date = ?");
    vals.push(null);
  }

  vals.push(user.activeBranchId);
  db.prepare(
    `UPDATE branches SET ${sets.join(", ")} WHERE id = ?`
  ).run(...vals);

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
