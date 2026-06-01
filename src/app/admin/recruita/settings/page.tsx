import { redirect } from "next/navigation";

// 2026-06-01 — RECRUITA OA settings moved to /admin/system-settings
// (per owner request: one canonical settings location, superadmin
// only, applies to all branches). The page itself now lives in
// system-settings/RecruitaOaSection.tsx — we just redirect so old
// bookmarks and the sidebar fallback keep working.
export const dynamic = "force-dynamic";

export default function RecruitaSettingsRedirect() {
  redirect("/admin/system-settings#recruita-oa");
}
