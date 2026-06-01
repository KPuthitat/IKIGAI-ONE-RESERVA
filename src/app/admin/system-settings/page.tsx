// /admin/system-settings — global (non-branch-scoped) configuration.
//
// Today this is just the IKIGAI OS LINE OA channel token + the
// cross-branch staff group ID used to route PERSONA notifications.
// When set, all PERSONA Flex cards (daily reports, edit requests,
// decisions) are pushed via the IKIGAI OS OA into the shared group
// where staff from every branch can see them — much simpler than
// trying to keep parallel per-branch chats in sync.
//
// Booking notifications stay on the branch's own OA (handled by
// notifyStaff, unchanged) because each branch typically has its own
// floor staff group.

import Link from "next/link";
import type { Metadata } from "next";
import { requireSuperAdmin } from "@/lib/auth";
import { getSystemSettings } from "@/lib/db";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import SystemSettingsForm from "./SystemSettingsForm";
import RecruitaOaSection from "./RecruitaOaSection";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "System Settings · IKIGAI OS" };

export default function SystemSettingsPage() {
  requireSuperAdmin();
  const lang = getLang();
  const settings = getSystemSettings();

  return (
    <div className="space-y-4">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:text-brand">
          ← {t(lang, "common.back")}
        </Link>
      </div>
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.systemSettings.title")}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {t(lang, "admin.systemSettings.subtitle")}
        </p>
      </div>

      <SystemSettingsForm
        token={settings.global_line_channel_token}
        groupId={settings.global_staff_group_id}
        defaultEscalationHours={settings.default_escalation_hours ?? 24}
        maintenanceMessage={settings.maintenance_message ?? ""}
        maintenanceActive={settings.maintenance_active === 1}
      />

      {/* RECRUITA LINE OA — global setting (IKIGAI Recruit, shared
          across all branches). Mounted as a section here so the
          owner has one canonical place for cross-branch settings
          instead of hunting under each module's sidebar. */}
      <RecruitaOaSection />
    </div>
  );
}
