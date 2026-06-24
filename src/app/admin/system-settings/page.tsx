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
import DeployCopyButton from "./DeployCopyButton";
import RecruitaOaSection from "./RecruitaOaSection";
import PdpaImageUploader from "./PdpaImageUploader";
import { DEFAULT_HEALTH_CHECK_MESSAGE } from "@/lib/recruita-notify";
import { OCR_MODELS, DEFAULT_OCR_MODEL } from "@/lib/accounta";
import { OWL_AI_MODELS, DEFAULT_OWL_AI_MODEL } from "@/lib/owl-ai-models";

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

      <DeployCopyButton />

      <SystemSettingsForm
        token={settings.global_line_channel_token}
        groupId={settings.global_staff_group_id}
        defaultEscalationHours={settings.default_escalation_hours ?? 24}
        maintenanceMessage={settings.maintenance_message ?? ""}
        maintenanceActive={settings.maintenance_active === 1}
        privacyPolicyUrl={settings.privacy_policy_url ?? ""}
        recruitaExecGroupId={settings.recruita_exec_group_id ?? ""}
        recruitaExecGroupName={settings.recruita_exec_group_name ?? ""}
        recruitaInterviewMapUrl={settings.recruita_interview_map_url ?? ""}
        recruitaHealthCheckMessage={settings.recruita_health_check_message ?? ""}
        defaultHealthCheckMessage={DEFAULT_HEALTH_CHECK_MESSAGE}
        portalOaLink={settings.portal_oa_link ?? ""}
        accountaOcrEnabled={settings.accounta_ocr_enabled === 1}
        accountaOcrModel={settings.accounta_ocr_model ?? DEFAULT_OCR_MODEL}
        ocrModels={OCR_MODELS.map((m) => ({ id: m.id, label: m.label }))}
        owlAiEnabled={settings.owl_ai_enabled === 1}
        owlAiModel={settings.owl_ai_model ?? DEFAULT_OWL_AI_MODEL}
        owlModels={OWL_AI_MODELS.map((m) => ({ id: m.id, label: m.label }))}
        owlHelpEnabled={settings.owl_help_enabled === 1}
        anthropicKeyPresent={!!process.env.ANTHROPIC_API_KEY}
      />

      {/* RECRUITA PDPA policy image — admin uploads an image of the
          privacy notice; the apply form links candidates to it. */}
      <PdpaImageUploader hasImage={!!settings.recruita_pdpa_image_path} />

      {/* RECRUITA LINE OA — global setting (IKIGAI Recruit, shared
          across all branches). Mounted as a section here so the
          owner has one canonical place for cross-branch settings
          instead of hunting under each module's sidebar. */}
      <RecruitaOaSection />
    </div>
  );
}
