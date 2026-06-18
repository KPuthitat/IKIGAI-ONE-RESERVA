import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { updateSystemSettings, logPersonaAction, getSystemSettings } from "@/lib/db";
import { writeMaintenancePage } from "@/lib/maintenance-page";

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
  maintenance_active: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  // Public URL of the privacy policy / PDPA notice. Owner pastes a
  // Canva published-link (or any HTTPS URL); consent surfaces link
  // to it as "ดูนโยบาย". Plaintext, ≤500 chars. Empty = clear.
  privacy_policy_url: z.string().max(500).optional(),
  // LINE group id receiving new-application Flex pushes + PERSONA HR alerts.
  recruita_exec_group_id: z.string().max(100).optional(),
  // Human-readable label for the HR group (display only, e.g. "IKIGAI RECRUIT x HR").
  recruita_exec_group_name: z.string().max(100).optional(),
  // Inline PDPA consent text for the apply form. 5000-char cap is
  // generous for a full notice. Empty = clear (form uses default).
  recruita_pdpa_text: z.string().max(5000).optional(),
  // RECRUITA interview venue map/navigation link (Google Maps share URL
  // etc.). Empty = clear → the invite card omits the navigate button.
  recruita_interview_map_url: z.string().max(1000).optional(),
  // RECRUITA health-check card body shown to applicants who passed the
  // interview. Empty = clear → card uses the built-in default. 2000-char
  // cap fits the multi-paragraph default + note comfortably.
  recruita_health_check_message: z.string().max(2000).optional(),
  // IKIGAI OS PORTAL OA add-friend link (LINE deep link, e.g. https://lin.ee/…).
  // Empty = clear → the welcome card sent to a freshly-hired employee omits the
  // "เพิ่มเพื่อน IKIGAI OS PORTAL" button.
  portal_oa_link: z.string().max(500).optional(),
  // ACCOUNTA bill-OCR master toggle + chosen vision model id.
  accounta_ocr_enabled: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  accounta_ocr_model: z.string().max(100).optional(),
  // Smart น้องฮูก (admin AI Q&A) master toggle + chosen model id.
  owl_ai_enabled: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
  owl_ai_model: z.string().max(100).optional()
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
  if (parsed.data.privacy_policy_url !== undefined) {
    dbPatch.privacy_policy_url = parsed.data.privacy_policy_url.trim();
  }
  if (parsed.data.recruita_exec_group_id !== undefined) {
    const g = parsed.data.recruita_exec_group_id.trim();
    if (g && !/^[CRU][0-9a-f]{32}$/i.test(g)) {
      return NextResponse.json(
        {
          error: "invalid_recruita_exec_group_id",
          message: "RECRUITA exec group ID should start with C/R/U followed by 32 hex characters"
        },
        { status: 400 }
      );
    }
    dbPatch.recruita_exec_group_id = g;
  }
  if (parsed.data.recruita_exec_group_name !== undefined) {
    dbPatch.recruita_exec_group_name = parsed.data.recruita_exec_group_name.trim();
  }
  if (parsed.data.recruita_pdpa_text !== undefined) {
    dbPatch.recruita_pdpa_text = parsed.data.recruita_pdpa_text;
  }
  if (parsed.data.recruita_interview_map_url !== undefined) {
    dbPatch.recruita_interview_map_url = parsed.data.recruita_interview_map_url;
  }
  if (parsed.data.recruita_health_check_message !== undefined) {
    dbPatch.recruita_health_check_message = parsed.data.recruita_health_check_message;
  }
  if (parsed.data.portal_oa_link !== undefined) {
    dbPatch.portal_oa_link = parsed.data.portal_oa_link;
  }
  if (parsed.data.accounta_ocr_enabled !== undefined) {
    const v = parsed.data.accounta_ocr_enabled;
    dbPatch.accounta_ocr_enabled = (v === true || v === "true") ? 1 : 0;
  }
  if (parsed.data.accounta_ocr_model !== undefined) {
    dbPatch.accounta_ocr_model = parsed.data.accounta_ocr_model.trim();
  }
  if (parsed.data.owl_ai_enabled !== undefined) {
    const v = parsed.data.owl_ai_enabled;
    dbPatch.owl_ai_enabled = (v === true || v === "true") ? 1 : 0;
  }
  if (parsed.data.owl_ai_model !== undefined) {
    dbPatch.owl_ai_model = parsed.data.owl_ai_model.trim();
  }

  updateSystemSettings(dbPatch, user.id);

  // Regenerate the Nginx-served maintenance page whenever the
  // message changes. The HTML is self-contained (font + owl baked
  // in via base64) and lives at /var/www/maintenance/index.html on
  // prod — Nginx serves it via `error_page 502 503 504` whenever
  // Next.js is unreachable mid-deploy, so users see something
  // branded instead of a raw 502/504 / white screen of death.
  // Non-fatal: a permission issue here doesn't block the save.
  if (parsed.data.maintenance_message !== undefined) {
    try {
      const fresh = getSystemSettings();
      writeMaintenancePage(fresh.maintenance_message);
    } catch (e) {
      console.warn("maintenance page write failed:", e);
    }
  }

  // Activity log — captures every change to system-wide config.
  // ref_id is null because the entity changed is the singleton row.
  logPersonaAction(user.id, "system_settings.update", null);

  return NextResponse.json({ ok: true });
}
