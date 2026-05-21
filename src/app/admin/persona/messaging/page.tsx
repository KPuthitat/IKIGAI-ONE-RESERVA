import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getLang } from "@/lib/lang-server";
import { t } from "@/lib/i18n";
import { getPlatformChannel } from "@/lib/messaging-channels";
import { getSystemSettings } from "@/lib/db";
import MessagingClient from "./MessagingClient";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "ตั้งค่าการแจ้งเตือน · IKIGAI ONE" };

export default function AdminMessagingPage() {
  const user = requireAdmin();
  const lang = getLang();

  const platform = getPlatformChannel();
  const platformInitial = {
    label: platform?.label ?? "IKIGAI OS",
    code: platform?.code ?? "ikigai-os",
    has_token: !!platform?.channel_token,
    has_secret: !!platform?.channel_secret,
    updated_at: platform?.updated_at ?? null
  };

  // Cross-branch staff group ID — only super_admin can read or change
  // it (the API enforces this too), so don't even ship the value to
  // non-super-admin clients.
  const isSuperAdmin = user.role === "super_admin";
  const globalStaffGroupId = isSuperAdmin
    ? (getSystemSettings().global_staff_group_id ?? "")
    : "";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">
          {t(lang, "admin.messaging.title")}
        </h1>
        <p className="text-sm text-slate-500">
          {t(lang, "admin.messaging.subtitle")}
        </p>
      </div>
      <MessagingClient
        lang={lang}
        platform={platformInitial}
        globalStaffGroupId={globalStaffGroupId}
        isSuperAdmin={isSuperAdmin}
      />
    </div>
  );
}
